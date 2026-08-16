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

type Json = Record<string, unknown>;

/** Shape of the single json_build_object the engine reads at the start. */
interface EnginePayload {
  account: Json | null;
  states: Json[];
  positions: Json[];
  unresolved: Json[];
  last_close: Record<string, number>;
}

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
  entry_candle: number;
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
  // ONE query, not five in parallel. Supabase's transaction pooler cannot
  // safely interleave several in-flight statements on one pooled connection:
  // fanning reads out with Promise.all left sessions stuck in ClientRead
  // forever, and the next cycle then blocked behind them. One statement, one
  // connection, no pipelining.
  const [{ payload }] = await sql<{ payload: EnginePayload }[]>`
    SELECT json_build_object(
      'account', (SELECT row_to_json(a) FROM account_state a WHERE a.id = 1),
      'states', (SELECT coalesce(json_agg(s), '[]'::json)
                 FROM (SELECT instrument_id, last_candle_time FROM instrument_state) s),
      'positions', (SELECT coalesce(json_agg(p ORDER BY p.id), '[]'::json) FROM (
          SELECT id, instrument_id, side, entry_price, qty, stop_price, target_price,
                 entry_fee, notional, entry_candle
          FROM trades WHERE status = 'open') p),
      -- Missed setups whose outcome is not yet known; resolved below against
      -- the candles this cycle already fetched, so it costs no extra I/O.
      'unresolved', (SELECT coalesce(json_agg(m), '[]'::json) FROM (
          SELECT id, instrument_id, candle_time, side, entry_price, stop_price, target_price, qty
          FROM missed_opportunities WHERE hypothetical_pnl IS NULL) m),
      -- Last stored close per instrument. Without it, a cycle where nothing is
      -- fresh marks open positions flat and stamps a false dip on the curve.
      'last_close', (SELECT coalesce(json_object_agg(l.symbol, l.close), '{}'::json) FROM (
          SELECT DISTINCT ON (symbol) symbol, close FROM candles
          ORDER BY symbol, open_time DESC) l)
    ) AS payload
  `;

  const accountRows = payload.account ? [payload.account] : [];
  const stateRows = payload.states;
  const positionRows = payload.positions;
  const unresolvedMissed = payload.unresolved;
  const lastCloseRows = Object.entries(payload.last_close).map(([symbol, close]) => ({
    symbol,
    close: Number(close),
  }));

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
  /** Instruments with a NEW bar — these get evaluated for entries/exits. */
  const loaded: Loaded[] = [];
  /** Every instrument with usable history, new bar or not. */
  const prepared: Loaded[] = [];
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

    // Keep every instrument we have bars for, whether or not they are new.
    // Resolving past missed setups needs price history, not fresh price —
    // scoping it to instruments with a new bar meant it almost never ran.
    prepared.push(data);

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
  applyRiskEngine(
    account,
    positions,
    loaded,
    new Map(lastCloseRows.map((r) => [String(r.symbol), Number(r.close)]))
  );

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

      // If the full size will not fit, take a smaller position rather than
      // skipping the signal. Risk scales down with it — a half-size trade
      // risks 0.75% instead of 1.5% — so this is strictly safer per trade
      // and roughly halves missed opportunities. Below minPartialFraction
      // the slice is not worth a slot and is recorded as missed instead.
      let fraction = 1;
      if (notional > available) {
        fraction = available > 0 ? available / notional : 0;
        if (!CONFIG.sizing.allowPartial || fraction < CONFIG.sizing.minPartialFraction) {
          missedRows.push({
            instrument_id: inst.id, candle_time: data.last.openTime, side: decision.enter,
            reason: "insufficient_capital", wanted_notional: notional, available_capital: available,
            entry_price: plan.entryPrice, stop_price: plan.stopPrice, target_price: plan.targetPrice,
            qty: plan.qty, strategy_version: STRATEGY_VERSION,
          });
          action = "missed";
          missed = `needed ${notional.toFixed(2)}, had ${available.toFixed(2)}`;
          reason = `valid ${decision.enter} setup skipped — free capital covers only ${(fraction * 100).toFixed(0)}% of the position, below the ${(CONFIG.sizing.minPartialFraction * 100).toFixed(0)}% floor (${missed})`;
          fraction = 0;
        }
      }

      if (fraction > 0) {
        const qty = plan.qty * fraction;
        const actualNotional = plan.entryPrice * qty;
        const entryFee = qty * plan.entryPrice * CONFIG.fills.feePct;
        account.realized_equity -= entryFee;

        openedTrades.push({
          symbol: inst.id, instrument_id: inst.id, side: decision.enter, status: "open",
          strategy_version: STRATEGY_VERSION,
          entry_time: new Date(data.last.closeTime).toISOString(),
          entry_candle: data.last.openTime, entry_price: plan.entryPrice, qty,
          stop_price: plan.stopPrice, target_price: plan.targetPrice,
          atr_at_entry: data.atr14[i], entry_fee: entryFee, notional: actualNotional,
          sized_fraction: fraction, intended_qty: plan.qty,
        });
        positions.push({
          id: -1 - openedTrades.length, // placeholder; real id assigned on insert
          instrument_id: inst.id, side: decision.enter, entry_price: plan.entryPrice,
          qty, stop_price: plan.stopPrice, target_price: plan.targetPrice,
          entry_fee: entryFee, notional: actualNotional, entry_candle: data.last.openTime,
        });

        if (fraction < 0.999) {
          action = `entry_${decision.enter}_partial`;
          missed = `sized to ${(fraction * 100).toFixed(0)}% — free capital ${available.toFixed(2)} of ${notional.toFixed(2)} needed`;
          reason = `${decision.reason} — opened at ${(fraction * 100).toFixed(0)}% size to fit free capital (risk ${(CONFIG.sizing.riskPerTrade * fraction * 100).toFixed(2)}% instead of ${(CONFIG.sizing.riskPerTrade * 100).toFixed(1)}%)`;
        }
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

  // ---- resolve missed setups whose outcome is now knowable --------------
  const resolved = resolveMissed(unresolvedMissed, prepared);

  // ---- account totals ---------------------------------------------------
  // Prefer this cycle's fresh close, fall back to the last stored one so a
  // quiet cycle does not report open positions as flat.
  const marks = new Map<string, number>(
    lastCloseRows.map((r) => [String(r.symbol), Number(r.close)])
  );
  for (const d of loaded) marks.set(d.inst.id, d.last.close);
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
    signals, states, newCandles, closedTrades, openedTrades, missedRows, resolved,
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

  const entryIdx = byTime.get(pos.entry_candle);

  for (const c of data.freshCandles) {
    if (!live) break;
    let fill = checkPriceExit(toPosLike(live), c);
    let reason: string = fill?.reason ?? "";

    // Time stop: about capital, not price. A trade that has gone nowhere is
    // holding every other instrument's signals hostage, so it is closed at
    // the market like any forced exit rather than pretending a level filled.
    //
    // It does NOT fire on a losing position (unless configured to): that
    // trade already has a planned exit at its stop, sized so the loss costs
    // exactly riskPerTrade. Closing early on a timer would turn a budgeted
    // risk into an unplanned partial loss.
    if (!fill && entryIdx !== undefined) {
      const idx = byTime.get(c.openTime);
      if (idx !== undefined && idx - entryIdx >= CONFIG.exits.maxBarsHeld) {
        const exitPx = forcedExitPrice(live.side, c.close);
        const settled = settleClose(toPosLike(live), exitPx, live.entry_fee);
        if (CONFIG.exits.timeStopWhenLosing || settled.netPnl >= 0) {
          fill = { price: exitPx, reason: "stop" };
          reason = "time-stop";
        }
      }
    }

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

export interface ResolvedMiss {
  id: number;
  pnl: number;
  exit: string;
}

/**
 * Work out what each skipped setup WOULD have done, using the entry, stop and
 * target that were recorded at the time and the same exit rules a real
 * position gets — including the time stop.
 *
 * Without this, "we missed 11 signals" is a number with no sign: half of them
 * might have been losers, in which case the budget protected us. Resolving
 * them turns the capital constraint from an anecdote into a dollar figure.
 *
 * Only setups whose outcome is settled get written; ones still running stay
 * NULL and are retried next cycle.
 */
function resolveMissed(rows: readonly Record<string, unknown>[], loaded: Loaded[]): ResolvedMiss[] {
  const byInstrument = new Map(loaded.map((d) => [d.inst.id, d]));
  const out: ResolvedMiss[] = [];

  for (const r of rows) {
    const data = byInstrument.get(String(r.instrument_id));
    if (!data) continue; // no fresh data for it this cycle

    const startTime = Number(r.candle_time);
    const startIdx = data.candles.findIndex((c) => c.openTime === startTime);
    if (startIdx < 0) continue; // outside the window we hold

    const pos = {
      side: r.side as Side,
      entryPrice: Number(r.entry_price),
      qty: Number(r.qty),
      stopPrice: Number(r.stop_price),
      targetPrice: Number(r.target_price),
    };
    const entryFee = pos.qty * pos.entryPrice * CONFIG.fills.feePct;

    for (let i = startIdx + 1; i < data.candles.length; i++) {
      const c = data.candles[i];
      let fill = checkPriceExit(pos, c);
      let why: string = fill?.reason ?? "";

      if (!fill && i - startIdx >= CONFIG.exits.maxBarsHeld) {
        const exitPx = forcedExitPrice(pos.side, c.close);
        if (CONFIG.exits.timeStopWhenLosing || settleClose(pos, exitPx, entryFee).netPnl >= 0) {
          fill = { price: exitPx, reason: "stop" };
          why = "time-stop";
        }
      }
      if (!fill) {
        const e50 = data.ema50[i];
        const e200 = data.ema200[i];
        if (e50 !== null && e200 !== null) {
          const bull = e50 > e200;
          if ((pos.side === "long" && !bull) || (pos.side === "short" && bull)) {
            fill = { price: forcedExitPrice(pos.side, c.close), reason: "stop" };
            why = "regime-flip";
          }
        }
      }

      if (fill) {
        const s = settleClose(pos, fill.price, entryFee);
        out.push({ id: Number(r.id), pnl: s.netPnl, exit: why || fill.reason });
        break;
      }
    }
  }
  return out;
}

function applyRiskEngine(
  account: AccountState,
  positions: OpenPosition[],
  loaded: Loaded[],
  storedMarks: Map<string, number>
): void {
  if (account.halted) return;

  const marks = new Map(storedMarks);
  for (const d of loaded) marks.set(d.inst.id, d.last.close);
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
    entry_candle: Number(r.entry_candle ?? 0),
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
  resolved: ResolvedMiss[];
}

/**
 * All writes, in ONE transaction, executed sequentially.
 *
 * They used to go out via Promise.all. Against Supabase's transaction pooler
 * that pipelines several statements onto one pooled connection, which
 * pgbouncer cannot demultiplex: sessions were left stuck in ClientRead
 * indefinitely and the next cycle blocked behind them. A transaction also
 * makes the flush atomic, which it should have been anyway — a cycle that
 * records a fill but not the account update leaves the books wrong.
 */
async function flush(sql: Sql, a: FlushArgs): Promise<void> {
  await sql.begin(async (tx) => {
    for (const t of a.closedTrades) {
      await tx`
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

    if (a.newCandles.length > 0) {
      await tx`INSERT INTO candles ${tx(a.newCandles)} ON CONFLICT (symbol, open_time) DO NOTHING`;
    }
    if (a.openedTrades.length > 0) {
      await tx`INSERT INTO trades ${tx(a.openedTrades)}`;
    }
    if (a.missedRows.length > 0) {
      await tx`INSERT INTO missed_opportunities ${tx(a.missedRows)}`;
    }
    if (a.resolved.length > 0) {
      await tx`
        UPDATE missed_opportunities m
        SET hypothetical_pnl = x.pnl, hypothetical_exit = x.exit
        FROM jsonb_to_recordset(${tx.json(a.resolved as never)}::jsonb)
          AS x(id bigint, pnl double precision, "exit" text)
        WHERE m.id = x.id
      `;
    }
    if (a.states.length > 0) {
      const now = new Date().toISOString();
      const rows = a.states.map((s) => ({ ...s, last_eval_at: now, updated_at: now }));
      await tx`
        INSERT INTO instrument_state ${tx(rows)}
        ON CONFLICT (instrument_id) DO UPDATE SET
          last_candle_time = EXCLUDED.last_candle_time,
          last_eval_at = EXCLUDED.last_eval_at,
          warming_up = EXCLUDED.warming_up,
          candles_seen = EXCLUDED.candles_seen,
          last_error = EXCLUDED.last_error,
          updated_at = now()
      `;
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
      await tx`
        INSERT INTO signals (symbol, instrument_id, candle_time, action, reason, details, strategy_version)
        SELECT x.symbol, x.instrument_id, x.candle_time, x.action, x.reason, x.details, x.strategy_version
        FROM jsonb_to_recordset(${tx.json(payload as never)}::jsonb)
          AS x(symbol text, instrument_id text, candle_time bigint, action text,
               reason text, details jsonb, strategy_version text)
      `;
    }

    await tx`
      INSERT INTO equity_snapshots (candle_time, equity, realized, open_pnl, deployed, available, open_positions, strategy_version)
      VALUES (${Date.now()}, ${a.equity}, ${a.account.realized_equity}, ${a.unrealized},
              ${a.deployed}, ${a.account.realized_equity - a.deployed}, ${a.positions}, ${STRATEGY_VERSION})
    `;

    await tx`
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
    `;
  });
}
