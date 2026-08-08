/**
 * Multi-instrument evaluation engine (v1.1.0).
 *
 * Differences from the single-instrument engine:
 *  - many instruments, each with its own bars, indicators and idempotency
 *  - ONE shared account. A position ties up its entry notional, so a valid
 *    signal can go untaken because the money is already working elsewhere.
 *    Those refusals are recorded rather than dropped — measuring what a fixed
 *    budget costs is a goal of the exercise, not a side effect.
 *  - exits for EVERY instrument are processed before ANY entry is considered,
 *    so capital freed this cycle is available to whoever signalled, instead of
 *    whoever happens to sit earlier in the config file
 *  - when capital is scarce, entries are offered in order of when their bar
 *    closed. Earliest signal wins, which is the only ordering that does not
 *    quietly favour one instrument.
 *
 * I/O is deliberately batched. Twelve instruments doing four round trips each
 * took 22-32s against a 10s function budget; reads are now three queries and
 * writes are grouped into one statement per table.
 *
 * The entry rules themselves are unchanged and still come from `decideEntry`,
 * so a candle produces the same verdict here as in the backtest.
 *
 * PAPER TRADING ONLY. No order-placement path exists.
 */

import { CONFIG, STRATEGY_VERSION, VENUE_RULES } from "@/config/strategy";
import { enabledInstruments, Instrument } from "@/config/instruments";
import { DEFAULT_FILL_PARAMS, FillParams } from "./fills";
import { Candle, closedOnly, fetchCandles } from "./marketdata";
import { db } from "./db";
import { atr, ema, rsi } from "./indicators";
import { decideEntry } from "./engine";
import { checkPriceExit, forcedExitPrice, openPnl, planEntry, settleClose, Side } from "./fills";

type Sql = ReturnType<typeof db>;

interface AccountState {
  realized_equity: number;
  peak_equity: number;
  day_start_equity: number;
  day_start_date: string | null;
  consecutive_losses: number;
  halted: boolean;
  halt_reason: string | null;
}

interface OpenPosition {
  id: number;
  instrument_id: string;
  side: Side;
  entry_price: number;
  qty: number;
  stop_price: number;
  target_price: number;
  entry_fee: number;
  notional: number;
}

interface Loaded {
  inst: Instrument;
  candles: Candle[];
  last: Candle;
  lastIdx: number;
  ema21: (number | null)[];
  ema50: (number | null)[];
  ema200: (number | null)[];
  rsi14: (number | null)[];
  atr14: (number | null)[];
  freshCandles: Candle[];
}

export interface InstrumentResult {
  instrument: string;
  status: "evaluated" | "warming-up" | "no-new-candle" | "error";
  candleTime?: number;
  action?: string;
  reason?: string;
  exits?: string[];
  missed?: string;
  error?: string;
}

export interface EvaluationResult {
  ok: boolean;
  version: string;
  equity: number;
  deployed: number;
  available: number;
  openPositions: number;
  halted: boolean;
  results: InstrumentResult[];
}

/* ---------- write batches, flushed once at the end ---------- */

interface SignalRow {
  instrument_id: string;
  candle_time: number | null;
  action: string;
  reason: string;
  details: unknown;
}
interface StateRow {
  instrument_id: string;
  last_candle_time: number | null;
  warming_up: boolean;
  candles_seen: number;
  last_error: string | null;
}
interface CandleRow {
  symbol: string;
  open_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  close_time: number;
}

export async function runEvaluation(): Promise<EvaluationResult> {
  const sql = db();
  const instruments = enabledInstruments();

  // ---- reads: three queries, in parallel -------------------------------
  const [accountRows, stateRows, positionRows] = await Promise.all([
    sql`SELECT * FROM account_state WHERE id = 1`,
    sql`SELECT instrument_id, last_candle_time FROM instrument_state`,
    sql`SELECT id, instrument_id, side, entry_price, qty, stop_price, target_price, entry_fee, notional
        FROM trades WHERE status = 'open' ORDER BY id`,
  ]);

  if (accountRows.length === 0) {
    throw new Error("account_state not initialized — run `npm run seed` first");
  }
  const account = toAccount(accountRows[0]);
  const lastCandleByInstrument = new Map<string, number | null>(
    stateRows.map((r) => [String(r.instrument_id), r.last_candle_time === null ? null : Number(r.last_candle_time)])
  );
  let positions = positionRows.map(rowToPosition);

  // ---- network: all instruments in parallel -----------------------------
  const fetched = await Promise.allSettled(
    instruments.map((inst) => fetchCandles(inst, CONFIG.fetchLimit))
  );

  const results: InstrumentResult[] = [];
  const signals: SignalRow[] = [];
  const states: StateRow[] = [];
  const newCandles: CandleRow[] = [];
  const loaded: Loaded[] = [];
  let anyError = false;

  for (let k = 0; k < instruments.length; k++) {
    const inst = instruments[k];
    const outcome = fetched[k];

    if (outcome.status === "rejected") {
      const msg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      anyError = true;
      states.push({ instrument_id: inst.id, last_candle_time: lastCandleByInstrument.get(inst.id) ?? null, warming_up: false, candles_seen: 0, last_error: msg });
      signals.push({ instrument_id: inst.id, candle_time: null, action: "error", reason: `data fetch failed — cycle skipped: ${msg}`, details: null });
      results.push({ instrument: inst.id, status: "error", error: msg });
      continue;
    }

    const prev = lastCandleByInstrument.get(inst.id) ?? null;
    const data = prepareInstrument(inst, outcome.value, prev);

    if (!data) {
      const seen = closedOnly(outcome.value, Date.now()).length;
      states.push({ instrument_id: inst.id, last_candle_time: prev, warming_up: true, candles_seen: seen, last_error: null });
      results.push({ instrument: inst.id, status: "warming-up" });
      continue;
    }

    if (data.freshCandles.length === 0) {
      states.push({ instrument_id: inst.id, last_candle_time: prev, warming_up: false, candles_seen: data.candles.length, last_error: null });
      results.push({ instrument: inst.id, status: "no-new-candle", candleTime: data.last.openTime });
      continue;
    }

    for (const c of data.freshCandles) {
      newCandles.push({
        symbol: inst.id, open_time: c.openTime, open: c.open, high: c.high,
        low: c.low, close: c.close, volume: c.volume, close_time: c.closeTime,
      });
    }
    loaded.push(data);
  }

  // ---- exits for every instrument, before any entry ---------------------
  const exitLog = new Map<string, string[]>();
  const closedTrades: { id: number; candle: Candle; price: number; reason: string; fee: number; pnl: number; pnlPct: number }[] = [];

  for (const data of loaded) {
    const pos = positions.find((p) => p.instrument_id === data.inst.id);
    if (!pos) continue;
    const logs = runExits(account, pos, data, closedTrades, signals);
    if (logs.length) exitLog.set(data.inst.id, logs);
  }
  const closedIds = new Set(closedTrades.map((t) => t.id));
  positions = positions.filter((p) => !closedIds.has(p.id));

  // ---- risk engine (account level, blocks NEW entries only) -------------
  const today = new Date().toISOString().slice(0, 10);
  if (account.day_start_date !== today) {
    account.day_start_date = today;
    account.day_start_equity = account.realized_equity;
  }
  applyRiskEngine(account, positions, loaded);

  // ---- entries, earliest bar close first --------------------------------
  const openedTrades: Record<string, unknown>[] = [];
  const missedRows: Record<string, unknown>[] = [];
  const ordered = [...loaded].sort((a, b) => a.last.closeTime - b.last.closeTime);

  for (const data of ordered) {
    const inst = data.inst;
    const i = data.lastIdx;
    const held = positions.some((p) => p.instrument_id === inst.id);
    const rules = VENUE_RULES[inst.venue];
    const fillParams: FillParams = {
      ...DEFAULT_FILL_PARAMS,
      stopAtrMult: rules.stopAtrMult,
      rrMultiple: rules.rrMultiple,
    };

    const decision = decideEntry(
      {
        close: data.candles[i].close,
        prevClose: data.candles[i - 1].close,
        ema21: data.ema21[i],
        prevEma21: data.ema21[i - 1],
        ema50: data.ema50[i],
        ema200: data.ema200[i],
        rsi14: data.rsi14[i],
        atr14: data.atr14[i],
      },
      held,
      account.halted,
      account.halt_reason,
      { allowLong: rules.allowLong, allowShort: rules.allowShort }
    );

    let action = decision.enter ? `entry_${decision.enter}` : "none";
    let reason = decision.reason;
    let missed: string | undefined;

    if (decision.enter) {
      const deployed = sumNotional(positions);
      const available = account.realized_equity - deployed;
      const plan = planEntry(
        decision.enter,
        data.candles[i].close,
        data.atr14[i] as number,
        account.realized_equity,
        fillParams
      );
      const notional = plan.entryPrice * plan.qty;

      if (notional > available) {
        // The setup was valid; the budget was not. This is the measurement
        // the fixed-capital design exists to produce.
        missedRows.push({
          instrument_id: inst.id, candle_time: data.last.openTime, side: decision.enter,
          reason: "insufficient_capital", wanted_notional: notional, available_capital: available,
          entry_price: plan.entryPrice, stop_price: plan.stopPrice, target_price: plan.targetPrice,
          qty: plan.qty, strategy_version: STRATEGY_VERSION,
        });
        action = "missed";
        missed = `needed ${notional.toFixed(2)}, had ${available.toFixed(2)}`;
        reason = `valid ${decision.enter} setup skipped — capital fully deployed (${missed})`;
      } else {
        account.realized_equity -= plan.entryFee;
        openedTrades.push({
          symbol: inst.id, instrument_id: inst.id, side: decision.enter, status: "open",
          strategy_version: STRATEGY_VERSION,
          entry_time: new Date(data.last.closeTime).toISOString(),
          entry_candle: data.last.openTime, entry_price: plan.entryPrice, qty: plan.qty,
          stop_price: plan.stopPrice, target_price: plan.targetPrice,
          atr_at_entry: data.atr14[i], entry_fee: plan.entryFee, notional,
        });
        positions.push({
          id: -1 - openedTrades.length, // placeholder; real id assigned on insert
          instrument_id: inst.id, side: decision.enter, entry_price: plan.entryPrice,
          qty: plan.qty, stop_price: plan.stopPrice, target_price: plan.targetPrice,
          entry_fee: plan.entryFee, notional,
        });
      }
    }

    signals.push({
      instrument_id: inst.id,
      candle_time: data.last.openTime,
      action,
      reason,
      details: {
        candle: { open: data.last.open, high: data.last.high, low: data.last.low, close: data.last.close },
        indicators: {
          ema21: round(data.ema21[i]), ema50: round(data.ema50[i]), ema200: round(data.ema200[i]),
          rsi14: round(data.rsi14[i]), atr14: round(data.atr14[i]),
        },
        prev: { close: data.candles[i - 1].close, ema21: round(data.ema21[i - 1]) },
        gates: decision.gates,
        exits: exitLog.get(inst.id) ?? [],
      },
    });

    states.push({
      instrument_id: inst.id, last_candle_time: data.last.openTime,
      warming_up: false, candles_seen: data.candles.length, last_error: null,
    });

    results.push({
      instrument: inst.id, status: "evaluated", candleTime: data.last.openTime,
      action, reason, exits: exitLog.get(inst.id), missed,
    });
  }

  // ---- account totals ---------------------------------------------------
  const marks = new Map(loaded.map((d) => [d.inst.id, d.last.close]));
  const unrealized = positions.reduce(
    (s, p) => s + (marks.has(p.instrument_id) ? openPnl(toPosLike(p), marks.get(p.instrument_id) as number) : 0),
    0
  );
  const deployed = sumNotional(positions);
  const equity = account.realized_equity + unrealized;
  if (equity > account.peak_equity) account.peak_equity = equity;

  // ---- writes: one statement per table ----------------------------------
  await flush(sql, {
    account, equity, deployed, unrealized, positions: positions.length,
    signals, states, newCandles, closedTrades, openedTrades, missedRows,
  });

  return {
    ok: !anyError,
    version: STRATEGY_VERSION,
    equity,
    deployed,
    available: account.realized_equity - deployed,
    openPositions: positions.length,
    halted: account.halted,
    results,
  };
}

/* ---------------- pure helpers ---------------- */

function prepareInstrument(inst: Instrument, all: Candle[], prev: number | null): Loaded | null {
  const candles = closedOnly(all, Date.now());
  if (candles.length < CONFIG.minCandles) return null;

  const last = candles[candles.length - 1];
  const fresh = prev === null ? [last] : candles.filter((c) => c.openTime > prev);
  const closes = candles.map((c) => c.close);

  return {
    inst, candles, last, lastIdx: candles.length - 1,
    ema21: ema(closes, CONFIG.indicators.emaFast),
    ema50: ema(closes, CONFIG.indicators.emaMid),
    ema200: ema(closes, CONFIG.indicators.emaSlow),
    rsi14: rsi(closes, CONFIG.indicators.rsiPeriod),
    atr14: atr(candles, CONFIG.indicators.atrPeriod),
    freshCandles: fresh,
  };
}

function runExits(
  account: AccountState,
  pos: OpenPosition,
  data: Loaded,
  closedTrades: { id: number; candle: Candle; price: number; reason: string; fee: number; pnl: number; pnlPct: number }[],
  signals: SignalRow[]
): string[] {
  const logs: string[] = [];
  const byTime = new Map(data.candles.map((c, i) => [c.openTime, i]));
  let live: OpenPosition | null = pos;

  for (const c of data.freshCandles) {
    if (!live) break;
    let fill = checkPriceExit(toPosLike(live), c);
    let reason: string = fill?.reason ?? "";

    if (!fill) {
      const idx = byTime.get(c.openTime);
      if (idx !== undefined) {
        const e50 = data.ema50[idx];
        const e200 = data.ema200[idx];
        if (e50 !== null && e200 !== null) {
          const bull = e50 > e200;
          if ((live.side === "long" && !bull) || (live.side === "short" && bull)) {
            fill = { price: forcedExitPrice(live.side, c.close), reason: "stop" };
            reason = "regime-flip";
          }
        }
      }
    }

    if (fill) {
      const settle = settleClose(toPosLike(live), fill.price, live.entry_fee);
      account.realized_equity += settle.grossPnl - settle.exitFee;
      if (settle.netPnl < 0) account.consecutive_losses += 1;
      else account.consecutive_losses = 0;

      const why = reason || fill.reason;
      closedTrades.push({
        id: live.id, candle: c, price: fill.price, reason: why,
        fee: settle.exitFee, pnl: settle.netPnl, pnlPct: settle.netPnlPct,
      });
      signals.push({
        instrument_id: live.instrument_id,
        candle_time: c.openTime,
        action: "exit",
        reason: `closed ${live.side} via ${why}: exit ${fill.price.toFixed(4)}, net ${settle.netPnl.toFixed(2)} USD`,
        details: { tradeId: live.id, exitPrice: fill.price, ...settle },
      });
      logs.push(`${why} @ ${fill.price.toFixed(4)}`);
      live = null;
    }
  }
  return logs;
}

function applyRiskEngine(account: AccountState, positions: OpenPosition[], loaded: Loaded[]): void {
  if (account.halted) return;

  const marks = new Map(loaded.map((d) => [d.inst.id, d.last.close]));
  const unrealized = positions.reduce(
    (s, p) => s + (marks.has(p.instrument_id) ? openPnl(toPosLike(p), marks.get(p.instrument_id) as number) : 0),
    0
  );
  const equity = account.realized_equity + unrealized;
  if (equity > account.peak_equity) account.peak_equity = equity;

  const dailyLoss = (account.day_start_equity - account.realized_equity) / account.day_start_equity;
  const drawdown = (account.peak_equity - equity) / account.peak_equity;

  let why: string | null = null;
  if (dailyLoss >= CONFIG.risk.dailyLossHaltPct) {
    why = `daily loss ${(dailyLoss * 100).toFixed(2)}% >= ${CONFIG.risk.dailyLossHaltPct * 100}%`;
  } else if (account.consecutive_losses >= CONFIG.risk.maxConsecutiveLosses) {
    why = `${account.consecutive_losses} consecutive losses >= ${CONFIG.risk.maxConsecutiveLosses}`;
  } else if (drawdown >= CONFIG.risk.maxDrawdownPct) {
    why = `drawdown ${(drawdown * 100).toFixed(2)}% >= ${CONFIG.risk.maxDrawdownPct * 100}%`;
  }
  if (why) {
    account.halted = true;
    account.halt_reason = why;
  }
}

function toPosLike(p: OpenPosition) {
  return { side: p.side, entryPrice: p.entry_price, qty: p.qty, stopPrice: p.stop_price, targetPrice: p.target_price };
}

function sumNotional(positions: OpenPosition[]): number {
  return positions.reduce((s, p) => s + p.notional, 0);
}

function toAccount(r: Record<string, unknown>): AccountState {
  return {
    realized_equity: Number(r.realized_equity),
    peak_equity: Number(r.peak_equity),
    day_start_equity: Number(r.day_start_equity),
    day_start_date: (r.day_start_date as string) ?? null,
    consecutive_losses: Number(r.consecutive_losses),
    halted: Boolean(r.halted),
    halt_reason: (r.halt_reason as string) ?? null,
  };
}

function rowToPosition(r: Record<string, unknown>): OpenPosition {
  return {
    id: Number(r.id),
    instrument_id: String(r.instrument_id),
    side: r.side as Side,
    entry_price: Number(r.entry_price),
    qty: Number(r.qty),
    stop_price: Number(r.stop_price),
    target_price: Number(r.target_price),
    entry_fee: Number(r.entry_fee),
    notional: Number(r.notional ?? Number(r.entry_price) * Number(r.qty)),
  };
}

function round(v: number | null): number | null {
  return v === null ? null : Math.round(v * 100000) / 100000;
}

/* ---------------- batched writes ---------------- */

interface FlushArgs {
  account: AccountState;
  equity: number;
  deployed: number;
  unrealized: number;
  positions: number;
  signals: SignalRow[];
  states: StateRow[];
  newCandles: CandleRow[];
  closedTrades: { id: number; candle: Candle; price: number; reason: string; fee: number; pnl: number; pnlPct: number }[];
  openedTrades: Record<string, unknown>[];
  missedRows: Record<string, unknown>[];
}

async function flush(sql: Sql, a: FlushArgs): Promise<void> {
  // Closing trades must land before the snapshot; they are rare, so a few
  // individual updates are fine.
  for (const t of a.closedTrades) {
    await sql`
      UPDATE trades SET
        status = 'closed',
        exit_time = ${new Date(t.candle.closeTime).toISOString()},
        exit_candle = ${t.candle.openTime},
        exit_price = ${t.price},
        exit_reason = ${t.reason},
        exit_fee = ${t.fee},
        pnl = ${t.pnl},
        pnl_pct = ${t.pnlPct}
      WHERE id = ${t.id}
    `;
  }

  const tasks: Promise<unknown>[] = [];

  if (a.newCandles.length > 0) {
    tasks.push(sql`INSERT INTO candles ${sql(a.newCandles)} ON CONFLICT (symbol, open_time) DO NOTHING`);
  }
  if (a.openedTrades.length > 0) {
    tasks.push(sql`INSERT INTO trades ${sql(a.openedTrades)}`);
  }
  if (a.missedRows.length > 0) {
    tasks.push(sql`INSERT INTO missed_opportunities ${sql(a.missedRows)}`);
  }
  if (a.states.length > 0) {
    const rows = a.states.map((s) => ({ ...s, last_eval_at: new Date().toISOString(), updated_at: new Date().toISOString() }));
    tasks.push(sql`
      INSERT INTO instrument_state ${sql(rows)}
      ON CONFLICT (instrument_id) DO UPDATE SET
        last_candle_time = EXCLUDED.last_candle_time,
        last_eval_at = EXCLUDED.last_eval_at,
        warming_up = EXCLUDED.warming_up,
        candles_seen = EXCLUDED.candles_seen,
        last_error = EXCLUDED.last_error,
        updated_at = now()
    `);
  }
  if (a.signals.length > 0) {
    // jsonb in a multi-row insert needs an explicit shape, hence recordset.
    const payload = a.signals.map((s) => ({
      symbol: s.instrument_id,
      instrument_id: s.instrument_id,
      candle_time: s.candle_time,
      action: s.action,
      reason: s.reason,
      details: s.details ?? null,
      strategy_version: STRATEGY_VERSION,
    }));
    tasks.push(sql`
      INSERT INTO signals (symbol, instrument_id, candle_time, action, reason, details, strategy_version)
      SELECT x.symbol, x.instrument_id, x.candle_time, x.action, x.reason, x.details, x.strategy_version
      FROM jsonb_to_recordset(${sql.json(payload as never)}::jsonb)
        AS x(symbol text, instrument_id text, candle_time bigint, action text,
             reason text, details jsonb, strategy_version text)
    `);
  }

  tasks.push(sql`
    INSERT INTO equity_snapshots (candle_time, equity, realized, open_pnl, deployed, available, open_positions, strategy_version)
    VALUES (${Date.now()}, ${a.equity}, ${a.account.realized_equity}, ${a.unrealized},
            ${a.deployed}, ${a.account.realized_equity - a.deployed}, ${a.positions}, ${STRATEGY_VERSION})
  `);

  tasks.push(sql`
    UPDATE account_state SET
      realized_equity = ${a.account.realized_equity},
      peak_equity = ${a.account.peak_equity},
      day_start_equity = ${a.account.day_start_equity},
      day_start_date = ${a.account.day_start_date},
      consecutive_losses = ${a.account.consecutive_losses},
      halted = ${a.account.halted},
      halt_reason = ${a.account.halt_reason},
      last_eval_at = now(),
      last_error = NULL,
      strategy_version = ${STRATEGY_VERSION},
      updated_at = now()
    WHERE id = 1
  `);

  await Promise.all(tasks);
}
