/**
 * Backtest simulator. Reuses the live paper-fill code (`fills.ts`) so the cost
 * model — slippage against direction, fees on both sides, stop-before-target
 * on an ambiguous candle — is literally the same code the bot runs. Only the
 * strategy PARAMETERS vary.
 *
 * Lookahead discipline:
 *  - indicators are causal (EMA/RSI/ATR only look backwards)
 *  - the daily regime for a 4h candle uses the last daily candle that had
 *    already CLOSED (see history.dailyIndexFor)
 *  - a Donchian channel excludes the current candle
 *  - entries fill at candle i's close; exits are checked from candle i+1 on
 *  - a trailing stop moves only after the candle it is derived from has closed
 *
 * Risk-engine halts are intentionally NOT simulated: a halt freezes the bot
 * until a human resets it, which would make a mechanical comparison depend on
 * an unmodelled human. Variants are compared on trade quality alone.
 */

import { Candle } from "@/lib/binance";
import { atr, crossedAbove, crossedBelow, ema, rsi } from "@/lib/indicators";
import {
  checkPriceExit,
  DEFAULT_FILL_PARAMS,
  FillParams,
  forcedExitPrice,
  planEntry,
  settleClose,
  Side,
} from "@/lib/fills";
import { CONFIG } from "@/config/strategy";
import { DailyCandle, dailyIndexFor, toDaily } from "./history";
import { Variant } from "./variants";

export interface MarketContext {
  candles: Candle[];
  closes: number[];
  ema21: (number | null)[];
  ema50: (number | null)[];
  ema200: (number | null)[];
  rsi14: (number | null)[];
  atr14: (number | null)[];
  daily: DailyCandle[];
  dailyEma50: (number | null)[];
  dailyEma200: (number | null)[];
  dailyIdx: (number | null)[];
}

/** Compute every series once; all variants share it. */
export function buildContext(candles: Candle[]): MarketContext {
  const closes = candles.map((c) => c.close);
  const daily = toDaily(candles);
  const dailyCloses = daily.map((d) => d.close);
  return {
    candles,
    closes,
    ema21: ema(closes, CONFIG.indicators.emaFast),
    ema50: ema(closes, CONFIG.indicators.emaMid),
    ema200: ema(closes, CONFIG.indicators.emaSlow),
    rsi14: rsi(closes, CONFIG.indicators.rsiPeriod),
    atr14: atr(candles, CONFIG.indicators.atrPeriod),
    daily,
    dailyEma50: ema(dailyCloses, CONFIG.indicators.emaMid),
    dailyEma200: ema(dailyCloses, CONFIG.indicators.emaSlow),
    dailyIdx: dailyIndexFor(candles, daily),
  };
}

/** null = regime unknown (still warming up). */
export function regimeAt(ctx: MarketContext, v: Variant, i: number): "bull" | "bear" | null {
  if (v.regime === "none") return null;
  if (v.regime === "4h") {
    const a = ctx.ema50[i];
    const b = ctx.ema200[i];
    return a === null || b === null ? null : a > b ? "bull" : "bear";
  }
  const di = ctx.dailyIdx[i];
  if (di === null) return null;
  const a = ctx.dailyEma50[di];
  const b = ctx.dailyEma200[di];
  return a === null || b === null ? null : a > b ? "bull" : "bear";
}

/** Entry signal for one candle, or null. Exported for the equivalence test. */
export function entrySignal(ctx: MarketContext, v: Variant, i: number): Side | null {
  if (i < 1) return null;
  const atrV = ctx.atr14[i];
  if (atrV === null || atrV <= 0) return null;

  const regime = regimeAt(ctx, v, i);
  if (v.regime !== "none" && regime === null) return null;
  // Regime decides direction; the variant's own flags can narrow it further.
  const allowLong = (v.regime === "none" || regime === "bull") && v.allowLong;
  const allowShort = (v.regime === "none" || regime === "bear") && v.allowShort;

  // Direction proposed by the entry trigger
  let side: Side | null = null;
  if (v.entry === "ema21-cross") {
    const e = ctx.ema21[i];
    const ePrev = ctx.ema21[i - 1];
    if (e === null || ePrev === null) return null;
    if (crossedAbove(ctx.closes[i - 1], ePrev, ctx.closes[i], e)) side = "long";
    else if (crossedBelow(ctx.closes[i - 1], ePrev, ctx.closes[i], e)) side = "short";
  } else {
    const n = v.donchianLen ?? 20;
    if (i < n) return null;
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i - n; k < i; k++) {
      // window excludes the current candle — no lookahead
      if (ctx.candles[k].high > hi) hi = ctx.candles[k].high;
      if (ctx.candles[k].low < lo) lo = ctx.candles[k].low;
    }
    if (ctx.closes[i] > hi) side = "long";
    else if (ctx.closes[i] < lo) side = "short";
  }
  if (side === null) return null;
  if (side === "long" && !allowLong) return null;
  if (side === "short" && !allowShort) return null;

  if (v.useRsiFilter) {
    const r = ctx.rsi14[i];
    if (r === null) return null;
    if (r >= v.rsiShortMax && r <= v.rsiLongMin) return null; // dead band
    if (side === "long" && !(r > v.rsiLongMin)) return null;
    if (side === "short" && !(r < v.rsiShortMax)) return null;
  }

  return side;
}

export interface BacktestResult {
  variant: string;
  trades: number;
  wins: number;
  winRatePct: number;
  profitFactor: number;
  netPnl: number;
  finalEquity: number;
  maxDrawdownPct: number;
  fees: number;
  avgTrade: number;
  byReason: Record<string, number>;
}

export interface Range {
  from: number; // inclusive index
  to: number; // exclusive index
}

export function simulate(
  ctx: MarketContext,
  v: Variant,
  range: Range,
  fillBase: FillParams = DEFAULT_FILL_PARAMS
): BacktestResult {
  const p: FillParams = { ...fillBase, stopAtrMult: v.stopAtrMult, rrMultiple: v.rrMultiple ?? 1 };

  // Explicit `number` — CONFIG is `as const`, so startingEquity carries the
  // literal type 10000 and would not widen on its own.
  let equity: number = CONFIG.account.startingEquity;
  let peak: number = equity;
  let maxDd = 0;
  let fees = 0;
  const pnls: number[] = [];
  const byReason: Record<string, number> = {};

  interface OpenPos {
    side: Side;
    entryPrice: number;
    qty: number;
    stopPrice: number;
    targetPrice: number;
    entryFee: number;
    extreme: number; // best price reached since entry, for the trailing stop
  }
  let pos: OpenPos | null = null;

  const start = Math.max(range.from, CONFIG.minCandles);
  for (let i = start; i < range.to; i++) {
    const c = ctx.candles[i];

    if (pos) {
      // 1. price exits, using the stop as it stood BEFORE this candle
      let fill = checkPriceExit(pos, c, p);
      let reason: string = fill?.reason ?? "";

      // 2. regime flip -> close at this candle's close
      if (!fill && v.regime !== "none") {
        const reg = regimeAt(ctx, v, i);
        if (reg !== null && ((pos.side === "long" && reg === "bear") || (pos.side === "short" && reg === "bull"))) {
          fill = { price: forcedExitPrice(pos.side, c.close, p), reason: "stop" };
          reason = "regime-flip";
        }
      }

      if (fill) {
        const s = settleClose(pos, fill.price, pos.entryFee, p);
        equity += s.grossPnl - s.exitFee;
        fees += pos.entryFee + s.exitFee;
        pnls.push(s.netPnl);
        const key = reason || fill.reason;
        byReason[key] = (byReason[key] ?? 0) + 1;
        pos = null;
      } else if (v.trailingAtrMult !== null) {
        // 3. ratchet the stop using data from the candle that just closed
        const a = ctx.atr14[i];
        if (a !== null) {
          if (pos.side === "long") {
            pos.extreme = Math.max(pos.extreme, c.high);
            pos.stopPrice = Math.max(pos.stopPrice, pos.extreme - v.trailingAtrMult * a);
          } else {
            pos.extreme = Math.min(pos.extreme, c.low);
            pos.stopPrice = Math.min(pos.stopPrice, pos.extreme + v.trailingAtrMult * a);
          }
        }
      }
    }

    // mark-to-market drawdown
    const mark = pos
      ? equity + (pos.side === "long" ? 1 : -1) * (c.close - pos.entryPrice) * pos.qty
      : equity;
    if (mark > peak) peak = mark;
    const dd = peak > 0 ? (peak - mark) / peak : 0;
    if (dd > maxDd) maxDd = dd;

    // 4. entry on this candle's close
    if (!pos) {
      const side = entrySignal(ctx, v, i);
      if (side) {
        const plan = planEntry(side, c.close, ctx.atr14[i] as number, equity, p);
        equity -= plan.entryFee;
        pos = {
          side,
          entryPrice: plan.entryPrice,
          qty: plan.qty,
          stopPrice: plan.stopPrice,
          targetPrice: v.rrMultiple === null ? (side === "long" ? Infinity : -Infinity) : plan.targetPrice,
          entryFee: plan.entryFee,
          extreme: plan.entryPrice,
        };
      }
    }
  }

  const wins = pnls.filter((x) => x >= 0);
  const grossWin = wins.reduce((s, x) => s + x, 0);
  const grossLoss = Math.abs(pnls.filter((x) => x < 0).reduce((s, x) => s + x, 0));

  return {
    variant: v.name,
    trades: pnls.length,
    wins: wins.length,
    winRatePct: pnls.length ? (wins.length / pnls.length) * 100 : 0,
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? Infinity : 0) : grossWin / grossLoss,
    netPnl: pnls.reduce((s, x) => s + x, 0),
    finalEquity: equity,
    maxDrawdownPct: maxDd * 100,
    fees,
    avgTrade: pnls.length ? pnls.reduce((s, x) => s + x, 0) / pnls.length : 0,
    byReason,
  };
}
