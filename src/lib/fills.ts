/**
 * Pure paper-fill simulation helpers (unit-tested; no I/O).
 * Conservative assumptions:
 *  - entries fill at candle close +/- slippage AGAINST the trade direction
 *  - stop and forced (regime-flip) exits also take slippage against direction
 *  - target exits fill at the target price exactly (limit-like)
 *  - if a candle touches BOTH stop and target, the stop is assumed first
 */

import { CONFIG } from "@/config/strategy";

export type Side = "long" | "short";

export interface PositionLike {
  side: Side;
  entryPrice: number;
  qty: number;
  stopPrice: number;
  targetPrice: number;
}

export interface CandleLike {
  high: number;
  low: number;
  close: number;
}

export interface EntryPlan {
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  qty: number;
  entryFee: number;
  stopDistance: number;
}

export function dirOf(side: Side): 1 | -1 {
  return side === "long" ? 1 : -1;
}

/** Build a full entry plan from the signal candle close, ATR and current equity. */
export function planEntry(side: Side, close: number, atrValue: number, equity: number): EntryPlan {
  const dir = dirOf(side);
  const { slippagePct, feePct } = CONFIG.fills;
  const stopDistance = CONFIG.exits.stopAtrMult * atrValue;

  const entryPrice = close * (1 + dir * slippagePct);
  const stopPrice = entryPrice - dir * stopDistance;
  const targetPrice = entryPrice + dir * stopDistance * CONFIG.exits.rrMultiple;
  const qty = (equity * CONFIG.sizing.riskPerTrade) / stopDistance;
  const entryFee = qty * entryPrice * feePct;

  return { entryPrice, stopPrice, targetPrice, qty, entryFee, stopDistance };
}

export interface ExitFill {
  price: number;
  reason: "stop" | "target";
}

/**
 * Check one candle's high/low against the position's stop/target.
 * Stop is checked FIRST — worst case when both are touched in the same candle.
 */
export function checkPriceExit(pos: PositionLike, candle: CandleLike): ExitFill | null {
  const { slippagePct } = CONFIG.fills;
  if (pos.side === "long") {
    if (candle.low <= pos.stopPrice) {
      return { price: pos.stopPrice * (1 - slippagePct), reason: "stop" };
    }
    if (candle.high >= pos.targetPrice) {
      return { price: pos.targetPrice, reason: "target" };
    }
  } else {
    if (candle.high >= pos.stopPrice) {
      return { price: pos.stopPrice * (1 + slippagePct), reason: "stop" };
    }
    if (candle.low <= pos.targetPrice) {
      return { price: pos.targetPrice, reason: "target" };
    }
  }
  return null;
}

/** Forced exit at candle close (regime flip): slippage against direction. */
export function forcedExitPrice(side: Side, close: number): number {
  return close * (1 - dirOf(side) * CONFIG.fills.slippagePct);
}

export interface CloseResult {
  exitFee: number;
  grossPnl: number;
  /** Net of entry AND exit fees — what gets stored on the trade row. */
  netPnl: number;
  netPnlPct: number;
}

export function settleClose(pos: PositionLike, exitPrice: number, entryFee: number): CloseResult {
  const dir = dirOf(pos.side);
  const exitFee = pos.qty * exitPrice * CONFIG.fills.feePct;
  const grossPnl = dir * (exitPrice - pos.entryPrice) * pos.qty;
  const netPnl = grossPnl - entryFee - exitFee;
  const entryNotional = pos.entryPrice * pos.qty;
  return { exitFee, grossPnl, netPnl, netPnlPct: (netPnl / entryNotional) * 100 };
}

/** Unrealized P/L at a mark price (fees ignored until the position closes). */
export function openPnl(pos: PositionLike, markPrice: number): number {
  return dirOf(pos.side) * (markPrice - pos.entryPrice) * pos.qty;
}
