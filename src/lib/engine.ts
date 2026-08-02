/**
 * Evaluation engine. Runs once per scheduler tick:
 *  1. fetch klines, keep CLOSED candles only (idempotent by candle open_time)
 *  2. process exits (stop/target/regime-flip) for every candle since last eval
 *  3. risk engine: daily loss / consecutive losses / max drawdown -> halt entries
 *  4. evaluate entry signal on the last closed candle only
 *  5. snapshot equity, log the decision (including WHY when there is no trade)
 *
 * PAPER TRADING ONLY. There is intentionally no order-placement code path.
 */

import { CONFIG, STRATEGY_VERSION } from "@/config/strategy";
import { Candle, closedCandles, fetchKlines } from "./binance";
import { db } from "./db";
import { atr, crossedAbove, crossedBelow, ema, rsi } from "./indicators";
import {
  checkPriceExit,
  forcedExitPrice,
  openPnl,
  planEntry,
  settleClose,
  Side,
} from "./fills";

interface BotState {
  equity: number;
  peak_equity: number;
  day_start_equity: number;
  day_start_date: string | null;
  consecutive_losses: number;
  halted: boolean;
  halt_reason: string | null;
  last_candle_time: number | null;
}

interface OpenTrade {
  id: number;
  symbol: string;
  side: Side;
  entry_price: number;
  qty: number;
  stop_price: number;
  target_price: number;
  entry_fee: number;
}

export interface SymbolResult {
  symbol: string;
  skipped?: boolean;
  error?: string;
  candleTime?: number;
  action?: string;
  reason?: string;
  exits?: string[];
  equity?: number;
  halted?: boolean;
}

type Sql = ReturnType<typeof db>;

export async function runEvaluation(): Promise<{
  ok: boolean;
  version: string;
  results: SymbolResult[];
}> {
  const sql = db();
  const state = await loadState(sql);
  if (!state) {
    throw new Error("bot_state not initialized — run `npm run seed` first");
  }

  const enabled = CONFIG.symbols.filter((s) => s.enabled);
  const results: SymbolResult[] = [];
  let anyError = false;

  for (const { symbol } of enabled) {
    const result = await evaluateSymbol(sql, state, symbol);
    if (result.error) anyError = true;
    results.push(result);
  }

  return { ok: !anyError, version: STRATEGY_VERSION, results };
}

async function evaluateSymbol(sql: Sql, state: BotState, symbol: string): Promise<SymbolResult> {
  // 1. Market data. On failure: skip the cycle, log, surface on dashboard.
  //    Never fabricate fills.
  let candles: Candle[];
  try {
    candles = await fetchKlines(symbol, CONFIG.interval, CONFIG.fetchLimit);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logSignal(sql, symbol, null, "error", `data fetch failed — cycle skipped: ${msg}`);
    await sql`UPDATE bot_state SET last_error = ${msg}, last_eval_at = now(), updated_at = now() WHERE id = 1`;
    return { symbol, skipped: true, error: msg };
  }

  const now = Date.now();
  const closed = closedCandles(candles, now);
  if (closed.length < CONFIG.minCandles) {
    const msg = `only ${closed.length} closed candles (< ${CONFIG.minCandles} required for warmup)`;
    await logSignal(sql, symbol, null, "error", `cycle skipped: ${msg}`);
    await sql`UPDATE bot_state SET last_error = ${msg}, last_eval_at = now(), updated_at = now() WHERE id = 1`;
    return { symbol, skipped: true, error: msg };
  }

  const last = closed[closed.length - 1];

  // Idempotency: dedupe by candle open_time. Scheduler retries and a few
  // minutes of GitHub Actions drift land on the same closed candle -> no-op.
  if (state.last_candle_time !== null && last.openTime <= state.last_candle_time) {
    // Heartbeat only: record that the scheduler ran and reached the data
    // source, but write no signal row — with sub-candle polling these no-ops
    // would otherwise bury the actual decisions in the dashboard feed.
    await sql`
      UPDATE bot_state SET last_eval_at = now(), last_error = NULL, updated_at = now()
      WHERE id = 1
    `;
    return {
      symbol,
      skipped: true,
      candleTime: last.openTime,
      action: "skip",
      reason: "candle already evaluated",
    };
  }

  // Persist recent candles (older ones are already stored by seed/prior runs).
  await upsertCandles(sql, symbol, closed.slice(-60));

  // 2. Indicators over the full closed series (>=300 candles warmup).
  const closes = closed.map((c) => c.close);
  const ema21 = ema(closes, CONFIG.indicators.emaFast);
  const ema50 = ema(closes, CONFIG.indicators.emaMid);
  const ema200 = ema(closes, CONFIG.indicators.emaSlow);
  const rsi14 = rsi(closes, CONFIG.indicators.rsiPeriod);
  const atr14 = atr(closed, CONFIG.indicators.atrPeriod);
  const indexByTime = new Map(closed.map((c, i) => [c.openTime, i]));

  // UTC day rollover for the daily-loss limit.
  const today = new Date(now).toISOString().slice(0, 10);
  if (state.day_start_date !== today) {
    state.day_start_date = today;
    state.day_start_equity = state.equity;
  }

  // 3. Exits: walk every closed candle since the last evaluated one, in order,
  //    so nothing is missed if the scheduler skipped a cycle.
  let openTrade = await loadOpenTrade(sql);
  const newOnes =
    state.last_candle_time === null
      ? [last]
      : closed.filter((c) => c.openTime > (state.last_candle_time as number));
  const exitLog: string[] = [];

  for (const c of newOnes) {
    if (!openTrade) break;
    const idx = indexByTime.get(c.openTime);

    let fill = checkPriceExit(
      {
        side: openTrade.side,
        entryPrice: openTrade.entry_price,
        qty: openTrade.qty,
        stopPrice: openTrade.stop_price,
        targetPrice: openTrade.target_price,
      },
      c
    );
    let reason: string = fill?.reason ?? "";

    // Emergency exit: regime flipped against the open position -> close at
    // this evaluation's candle close.
    if (!fill && idx !== undefined) {
      const e50 = ema50[idx];
      const e200 = ema200[idx];
      if (e50 !== null && e200 !== null) {
        const bull = e50 > e200;
        const flipped =
          (openTrade.side === "long" && !bull) || (openTrade.side === "short" && bull);
        if (flipped) {
          fill = { price: forcedExitPrice(openTrade.side, c.close), reason: "stop" };
          reason = "regime-flip";
        }
      }
    }

    if (fill) {
      const closedReason = reason || fill.reason;
      await closeTrade(sql, state, openTrade, fill.price, closedReason, c);
      exitLog.push(
        `${closedReason} @ ${fill.price.toFixed(2)} on ${new Date(c.openTime).toISOString()}`
      );
      openTrade = null;
    }
  }

  // 4. Risk engine (blocks NEW entries only; exits above always run).
  const lastIdx = closed.length - 1;
  const markPnl = openTrade
    ? openPnl(
        {
          side: openTrade.side,
          entryPrice: openTrade.entry_price,
          qty: openTrade.qty,
          stopPrice: openTrade.stop_price,
          targetPrice: openTrade.target_price,
        },
        last.close
      )
    : 0;
  const markEquity = state.equity + markPnl;
  if (markEquity > state.peak_equity) state.peak_equity = markEquity;

  if (!state.halted) {
    const dailyLoss = (state.day_start_equity - state.equity) / state.day_start_equity;
    const drawdown = (state.peak_equity - markEquity) / state.peak_equity;
    let haltReason: string | null = null;
    if (dailyLoss >= CONFIG.risk.dailyLossHaltPct) {
      haltReason = `daily loss ${(dailyLoss * 100).toFixed(2)}% >= ${CONFIG.risk.dailyLossHaltPct * 100}%`;
    } else if (state.consecutive_losses >= CONFIG.risk.maxConsecutiveLosses) {
      haltReason = `${state.consecutive_losses} consecutive losses >= ${CONFIG.risk.maxConsecutiveLosses}`;
    } else if (drawdown >= CONFIG.risk.maxDrawdownPct) {
      haltReason = `drawdown ${(drawdown * 100).toFixed(2)}% >= ${CONFIG.risk.maxDrawdownPct * 100}%`;
    }
    if (haltReason) {
      state.halted = true;
      state.halt_reason = haltReason;
      await logSignal(sql, symbol, last.openTime, "halt", `risk engine halted new entries: ${haltReason}`);
    }
  }

  // 5. Entry decision — last CLOSED candle only.
  const ind = {
    close: last.close,
    prevClose: closed[lastIdx - 1].close,
    ema21: ema21[lastIdx],
    prevEma21: ema21[lastIdx - 1],
    ema50: ema50[lastIdx],
    ema200: ema200[lastIdx],
    rsi14: rsi14[lastIdx],
    atr14: atr14[lastIdx],
  };
  const decision = decideEntry(ind, openTrade !== null, state.halted, state.halt_reason);

  if (decision.enter) {
    const plan = planEntry(decision.enter, last.close, ind.atr14 as number, state.equity);
    state.equity -= plan.entryFee;
    const [row] = await sql`
      INSERT INTO trades (
        symbol, side, status, strategy_version, entry_time, entry_candle,
        entry_price, qty, stop_price, target_price, atr_at_entry, entry_fee
      ) VALUES (
        ${symbol}, ${decision.enter}, 'open', ${STRATEGY_VERSION},
        ${new Date(last.closeTime).toISOString()}, ${last.openTime},
        ${plan.entryPrice}, ${plan.qty}, ${plan.stopPrice}, ${plan.targetPrice},
        ${ind.atr14}, ${plan.entryFee}
      ) RETURNING id, symbol, side, entry_price, qty, stop_price, target_price, entry_fee
    `;
    openTrade = rowToOpenTrade(row);
  }

  await logSignal(
    sql,
    symbol,
    last.openTime,
    decision.enter ? `entry_${decision.enter}` : "none",
    decision.reason,
    {
      candle: { open: last.open, high: last.high, low: last.low, close: last.close },
      indicators: {
        ema21: round(ind.ema21),
        ema50: round(ind.ema50),
        ema200: round(ind.ema200),
        rsi14: round(ind.rsi14),
        atr14: round(ind.atr14),
      },
      // Previous candle's close/EMA21 — the crossover check needs both bars,
      // so storing them makes the logged decision independently verifiable.
      prev: { close: ind.prevClose, ema21: round(ind.prevEma21) },
      gates: decision.gates,
      exits: exitLog,
      trade: openTrade && decision.enter
        ? {
            entry: openTrade.entry_price,
            stop: openTrade.stop_price,
            target: openTrade.target_price,
            qty: openTrade.qty,
          }
        : undefined,
    }
  );

  // 6. Equity snapshot (mark-to-market at last close).
  const finalOpenPnl = openTrade
    ? openPnl(
        {
          side: openTrade.side,
          entryPrice: openTrade.entry_price,
          qty: openTrade.qty,
          stopPrice: openTrade.stop_price,
          targetPrice: openTrade.target_price,
        },
        last.close
      )
    : 0;
  await sql`
    INSERT INTO equity_snapshots (candle_time, equity, realized, open_pnl)
    VALUES (${last.openTime}, ${state.equity + finalOpenPnl}, ${state.equity}, ${finalOpenPnl})
  `;

  state.last_candle_time = last.openTime;
  await persistState(sql, state);

  return {
    symbol,
    candleTime: last.openTime,
    action: decision.enter ? `entry_${decision.enter}` : "none",
    reason: decision.reason,
    exits: exitLog,
    equity: state.equity,
    halted: state.halted,
  };
}

interface IndicatorSnapshot {
  close: number;
  prevClose: number;
  ema21: number | null;
  prevEma21: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi14: number | null;
  atr14: number | null;
}

/**
 * Gate-by-gate breakdown of an entry decision. Purely descriptive metadata —
 * it never feeds back into the decision. Stored on every signal so the
 * dashboard can show exactly which condition blocked a trade.
 */
export interface EntryGates {
  warmedUp: boolean;
  regime: "bull" | "bear" | null;
  allowedSide: Side | null;
  crossedAbove: boolean;
  crossedBelow: boolean;
  /** A crossover event in the direction the regime allows. */
  crossoverOk: boolean;
  rsi: number | null;
  inDeadBand: boolean;
  /** RSI passes the threshold for the allowed side. */
  rsiOk: boolean;
  flat: boolean;
  notHalted: boolean;
}

/**
 * Pure entry decision — exported for tests. Returns the reason AND a
 * gate-by-gate breakdown in all cases. The decision itself is produced by
 * decideEntryCore below; gates are computed separately and never influence it.
 */
export function decideEntry(
  ind: IndicatorSnapshot,
  hasOpenPosition: boolean,
  halted: boolean,
  haltReason: string | null
): { enter: Side | null; reason: string; gates: EntryGates } {
  const core = decideEntryCore(ind, hasOpenPosition, halted, haltReason);
  return { ...core, gates: computeGates(ind, hasOpenPosition, halted) };
}

function computeGates(
  ind: IndicatorSnapshot,
  hasOpenPosition: boolean,
  halted: boolean
): EntryGates {
  const warmedUp =
    ind.ema21 !== null &&
    ind.prevEma21 !== null &&
    ind.ema50 !== null &&
    ind.ema200 !== null &&
    ind.rsi14 !== null &&
    ind.atr14 !== null;

  const regime = warmedUp ? (ind.ema50! > ind.ema200! ? "bull" : "bear") : null;
  const allowedSide: Side | null = regime === null ? null : regime === "bull" ? "long" : "short";
  const up = crossedAbove(ind.prevClose, ind.prevEma21, ind.close, ind.ema21);
  const down = crossedBelow(ind.prevClose, ind.prevEma21, ind.close, ind.ema21);
  const r = ind.rsi14;

  return {
    warmedUp,
    regime,
    allowedSide,
    crossedAbove: up,
    crossedBelow: down,
    crossoverOk: allowedSide === "long" ? up : allowedSide === "short" ? down : false,
    rsi: r,
    inDeadBand: r !== null && r >= CONFIG.entry.rsiShortMax && r <= CONFIG.entry.rsiLongMin,
    rsiOk:
      r === null || allowedSide === null
        ? false
        : allowedSide === "long"
          ? r > CONFIG.entry.rsiLongMin
          : r < CONFIG.entry.rsiShortMax,
    flat: !hasOpenPosition,
    notHalted: !halted,
  };
}

function decideEntryCore(
  ind: IndicatorSnapshot,
  hasOpenPosition: boolean,
  halted: boolean,
  haltReason: string | null
): { enter: Side | null; reason: string } {
  if (hasOpenPosition) return { enter: null, reason: "position already open (max 1)" };
  if (halted) return { enter: null, reason: `halted by risk engine: ${haltReason ?? "unknown"}` };
  if (
    ind.ema21 === null ||
    ind.prevEma21 === null ||
    ind.ema50 === null ||
    ind.ema200 === null ||
    ind.rsi14 === null ||
    ind.atr14 === null
  ) {
    return { enter: null, reason: "indicators still warming up" };
  }

  const bull = ind.ema50 > ind.ema200;
  const regime = bull ? "bull (EMA50>EMA200, longs only)" : "bear (EMA50<EMA200, shorts only)";
  const r = ind.rsi14;
  const crossUp = crossedAbove(ind.prevClose, ind.prevEma21, ind.close, ind.ema21);
  const crossDown = crossedBelow(ind.prevClose, ind.prevEma21, ind.close, ind.ema21);

  if (r >= CONFIG.entry.rsiShortMax && r <= CONFIG.entry.rsiLongMin) {
    return {
      enter: null,
      reason: `RSI ${r.toFixed(1)} in dead band [${CONFIG.entry.rsiShortMax}, ${CONFIG.entry.rsiLongMin}] — no trades; regime ${regime}`,
    };
  }

  if (bull) {
    if (crossUp && r > CONFIG.entry.rsiLongMin) {
      return { enter: "long", reason: `close crossed above EMA21, RSI ${r.toFixed(1)} > ${CONFIG.entry.rsiLongMin}, regime ${regime}` };
    }
    if (!crossUp) {
      return {
        enter: null,
        reason: crossDown
          ? `close crossed below EMA21 but regime ${regime} blocks shorts`
          : `no EMA21 crossover event; regime ${regime}; RSI ${r.toFixed(1)}`,
      };
    }
    return {
      enter: null,
      reason: `close crossed above EMA21 but RSI ${r.toFixed(1)} <= ${CONFIG.entry.rsiLongMin}`,
    };
  } else {
    if (crossDown && r < CONFIG.entry.rsiShortMax) {
      return { enter: "short", reason: `close crossed below EMA21, RSI ${r.toFixed(1)} < ${CONFIG.entry.rsiShortMax}, regime ${regime}` };
    }
    if (!crossDown) {
      return {
        enter: null,
        reason: crossUp
          ? `close crossed above EMA21 but regime ${regime} blocks longs`
          : `no EMA21 crossover event; regime ${regime}; RSI ${r.toFixed(1)}`,
      };
    }
    return {
      enter: null,
      reason: `close crossed below EMA21 but RSI ${r.toFixed(1)} >= ${CONFIG.entry.rsiShortMax}`,
    };
  }
}

async function closeTrade(
  sql: Sql,
  state: BotState,
  trade: OpenTrade,
  exitPrice: number,
  reason: string,
  candle: Candle
): Promise<void> {
  const pos = {
    side: trade.side,
    entryPrice: trade.entry_price,
    qty: trade.qty,
    stopPrice: trade.stop_price,
    targetPrice: trade.target_price,
  };
  const settle = settleClose(pos, exitPrice, trade.entry_fee);

  state.equity += settle.grossPnl - settle.exitFee; // entry fee already deducted at entry
  if (settle.netPnl < 0) state.consecutive_losses += 1;
  else state.consecutive_losses = 0;

  await sql`
    UPDATE trades SET
      status = 'closed',
      exit_time = ${new Date(candle.closeTime).toISOString()},
      exit_candle = ${candle.openTime},
      exit_price = ${exitPrice},
      exit_reason = ${reason},
      exit_fee = ${settle.exitFee},
      pnl = ${settle.netPnl},
      pnl_pct = ${settle.netPnlPct}
    WHERE id = ${trade.id}
  `;
  await logSignal(
    sql,
    trade.symbol,
    candle.openTime,
    "exit",
    `closed ${trade.side} via ${reason}: exit ${exitPrice.toFixed(2)}, net P/L ${settle.netPnl.toFixed(2)} USD`,
    { tradeId: trade.id, exitPrice, ...settle }
  );
}

async function loadState(sql: Sql): Promise<BotState | null> {
  const rows = await sql`SELECT * FROM bot_state WHERE id = 1`;
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    equity: Number(r.equity),
    peak_equity: Number(r.peak_equity),
    day_start_equity: Number(r.day_start_equity),
    day_start_date: r.day_start_date ?? null,
    consecutive_losses: Number(r.consecutive_losses),
    halted: Boolean(r.halted),
    halt_reason: r.halt_reason ?? null,
    last_candle_time: r.last_candle_time === null ? null : Number(r.last_candle_time),
  };
}

async function persistState(sql: Sql, s: BotState): Promise<void> {
  await sql`
    UPDATE bot_state SET
      equity = ${s.equity},
      peak_equity = ${s.peak_equity},
      day_start_equity = ${s.day_start_equity},
      day_start_date = ${s.day_start_date},
      consecutive_losses = ${s.consecutive_losses},
      halted = ${s.halted},
      halt_reason = ${s.halt_reason},
      last_candle_time = ${s.last_candle_time},
      last_eval_at = now(),
      last_error = NULL,
      updated_at = now()
    WHERE id = 1
  `;
}

async function loadOpenTrade(sql: Sql): Promise<OpenTrade | null> {
  const rows = await sql`
    SELECT id, symbol, side, entry_price, qty, stop_price, target_price, entry_fee
    FROM trades WHERE status = 'open' ORDER BY id LIMIT 1
  `;
  return rows.length ? rowToOpenTrade(rows[0]) : null;
}

function rowToOpenTrade(r: Record<string, unknown>): OpenTrade {
  return {
    id: Number(r.id),
    symbol: String(r.symbol),
    side: r.side as Side,
    entry_price: Number(r.entry_price),
    qty: Number(r.qty),
    stop_price: Number(r.stop_price),
    target_price: Number(r.target_price),
    entry_fee: Number(r.entry_fee),
  };
}

async function upsertCandles(sql: Sql, symbol: string, candles: Candle[]): Promise<void> {
  if (candles.length === 0) return;
  const rows = candles.map((c) => ({
    symbol,
    open_time: c.openTime,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    close_time: c.closeTime,
  }));
  await sql`INSERT INTO candles ${sql(rows)} ON CONFLICT (symbol, open_time) DO NOTHING`;
}

async function logSignal(
  sql: Sql,
  symbol: string,
  candleTime: number | null,
  action: string,
  reason: string,
  details?: unknown
): Promise<void> {
  await sql`
    INSERT INTO signals (symbol, candle_time, action, reason, details, strategy_version)
    VALUES (${symbol}, ${candleTime}, ${action}, ${reason},
            ${details === undefined ? null : sql.json(details as never)}, ${STRATEGY_VERSION})
  `;
}

function round(v: number | null): number | null {
  return v === null ? null : Math.round(v * 10000) / 10000;
}
