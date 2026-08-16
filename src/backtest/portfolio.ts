/**
 * Shared-capital portfolio simulator.
 *
 * Every other backtest in this repo gives each instrument its own $10,000,
 * which makes capital free and infinite. That hides the cost the live bot
 * actually pays: a position ties up a share of ONE account, and while it is
 * open every other instrument's signals go untaken.
 *
 * That blind spot matters. Isolated tests said a 1:4 target beat 1:2 — but
 * they never charged the 1:4 trade for holding capital three times longer.
 * This simulator does, so questions about targets, sizing and how many
 * positions a budget supports can be answered instead of argued.
 *
 * Instruments run on different bar lengths (crypto 4h, equities 1d), so the
 * simulation walks a single merged timeline ordered by bar CLOSE time. That
 * is also the order the live engine offers entries in when capital is scarce.
 */

import { CONFIG } from "@/config/strategy";
import { Candle } from "@/lib/binance";
import { checkPriceExit, DEFAULT_FILL_PARAMS, FillParams, forcedExitPrice, planEntry, settleClose, Side } from "@/lib/fills";
import { MarketContext, entrySignal, regimeAt } from "./simulate";
import { Variant } from "./variants";

export interface PortfolioInstrument {
  id: string;
  ctx: MarketContext;
  variant: Variant;
  fills: FillParams;
}

export interface PortfolioOptions {
  /** Scale a position down to whatever cash is left instead of skipping it. */
  allowPartial: boolean;
  /** Smallest usable slice of the intended size; below this, skip instead. */
  minPartialFraction: number;
  startingEquity: number;
  /**
   * Close a position after this many of its own bars regardless of price.
   * Aimed at capital lock-up rather than at price: a trade that has gone
   * nowhere in weeks is holding the account hostage. null = no time limit.
   */
  maxBarsHeld: number | null;
}

export interface PortfolioTrade {
  instrument: string;
  side: Side;
  entryTime: number;
  exitTime: number;
  notional: number;
  /** 1 = full size; below that, capital forced a smaller position. */
  sizedFraction: number;
  pnl: number;
  reason: string;
  barsHeld: number;
}

export interface PortfolioMissed {
  instrument: string;
  time: number;
  wanted: number;
  available: number;
}

export interface PortfolioResult {
  finalEquity: number;
  netPnl: number;
  trades: number;
  partialTrades: number;
  wins: number;
  winRatePct: number;
  profitFactor: number;
  maxDrawdownPct: number;
  fees: number;
  missed: number;
  /** Mean share of the account tied up, sampled at every event. */
  avgDeployedPct: number;
  /** Mean bars a position stayed open. */
  avgBarsHeld: number;
  /** Account-days of capital tied up per dollar of profit. */
  tradeList: PortfolioTrade[];
  missedList: PortfolioMissed[];
}

interface OpenPos {
  instrument: number;
  side: Side;
  entryPrice: number;
  qty: number;
  stopPrice: number;
  targetPrice: number;
  entryFee: number;
  notional: number;
  sizedFraction: number;
  entryTime: number;
  entryBar: number;
}

interface Event {
  inst: number;
  bar: number;
  closeTime: number;
}

/** Merged, chronologically ordered bar-close timeline across all instruments. */
function buildTimeline(instruments: PortfolioInstrument[], fromMs: number, toMs: number): Event[] {
  const events: Event[] = [];
  instruments.forEach((pi, idx) => {
    const { candles } = pi.ctx;
    for (let b = CONFIG.minCandles; b < candles.length; b++) {
      const t = candles[b].closeTime;
      if (t >= fromMs && t <= toMs) events.push({ inst: idx, bar: b, closeTime: t });
    }
  });
  events.sort((a, b) => a.closeTime - b.closeTime);
  return events;
}

export function simulatePortfolio(
  instruments: PortfolioInstrument[],
  fromMs: number,
  toMs: number,
  opts: PortfolioOptions
): PortfolioResult {
  const events = buildTimeline(instruments, fromMs, toMs);

  let cash: number = opts.startingEquity;
  let peak: number = cash;
  let maxDd = 0;
  let fees = 0;
  const open = new Map<number, OpenPos>();
  // Latest known close per instrument. Marking to market needs each
  // instrument's OWN most recent bar — indexing one instrument's array with
  // another's bar number is meaningless and silently corrupts drawdown.
  const lastClose: number[] = instruments.map((pi) => pi.ctx.candles[CONFIG.minCandles].close);
  const lastBar: number[] = instruments.map(() => CONFIG.minCandles);
  const trades: PortfolioTrade[] = [];
  const missedList: PortfolioMissed[] = [];
  let deployedSum = 0;
  let samples = 0;

  const deployed = () => {
    let d = 0;
    for (const p of open.values()) d += p.notional;
    return d;
  };

  for (const ev of events) {
    const pi = instruments[ev.inst];
    const { ctx, variant, fills } = pi;
    const candle = ctx.candles[ev.bar];
    lastClose[ev.inst] = candle.close;
    lastBar[ev.inst] = ev.bar;

    // ---- exit first: capital freed here is spendable on this same event ----
    const held = open.get(ev.inst);
    if (held) {
      let fill = checkPriceExit(held, candle, fills);
      let reason: string = fill?.reason ?? "";
      // Time stop: aimed at capital lock-up, so it fills at the close like a
      // market order rather than pretending a level was available.
      if (!fill && opts.maxBarsHeld !== null && ev.bar - held.entryBar >= opts.maxBarsHeld) {
        fill = { price: forcedExitPrice(held.side, candle.close, fills), reason: "stop" };
        reason = "time-stop";
      }
      if (!fill && variant.regime !== "none") {
        const reg = regimeAt(ctx, variant, ev.bar);
        if (reg !== null && ((held.side === "long" && reg === "bear") || (held.side === "short" && reg === "bull"))) {
          fill = { price: forcedExitPrice(held.side, candle.close, fills), reason: "stop" };
          reason = "regime-flip";
        }
      }
      if (fill) {
        const s = settleClose(held, fill.price, held.entryFee, fills);
        cash += s.grossPnl - s.exitFee;
        fees += held.entryFee + s.exitFee;
        trades.push({
          instrument: pi.id,
          side: held.side,
          entryTime: held.entryTime,
          exitTime: candle.closeTime,
          notional: held.notional,
          sizedFraction: held.sizedFraction,
          pnl: s.netPnl,
          reason: reason || fill.reason,
          barsHeld: ev.bar - held.entryBar,
        });
        open.delete(ev.inst);
      }
    }

    // ---- mark to market for drawdown ----
    let unreal = 0;
    for (const [i, p] of open) {
      unreal += (p.side === "long" ? 1 : -1) * (lastClose[i] - p.entryPrice) * p.qty;
    }
    const equity = cash + unreal;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDd) maxDd = dd;
    deployedSum += deployed() / Math.max(cash, 1);
    samples++;

    // ---- entry ----
    if (open.has(ev.inst)) continue;
    const side = entrySignal(ctx, variant, ev.bar);
    if (!side) continue;

    const available = cash - deployed();
    const plan = planEntry(side, candle.close, ctx.atr14[ev.bar] as number, cash, fills);
    const wanted = plan.entryPrice * plan.qty;

    let fraction = 1;
    if (wanted > available) {
      if (!opts.allowPartial || available <= 0) {
        missedList.push({ instrument: pi.id, time: candle.closeTime, wanted, available });
        continue;
      }
      fraction = available / wanted;
      if (fraction < opts.minPartialFraction) {
        missedList.push({ instrument: pi.id, time: candle.closeTime, wanted, available });
        continue;
      }
    }

    const qty = plan.qty * fraction;
    const notional = plan.entryPrice * qty;
    const entryFee = qty * plan.entryPrice * fills.feePct;
    cash -= entryFee;
    open.set(ev.inst, {
      instrument: ev.inst,
      side,
      entryPrice: plan.entryPrice,
      qty,
      stopPrice: plan.stopPrice,
      targetPrice: plan.targetPrice,
      entryFee,
      notional,
      sizedFraction: fraction,
      entryTime: candle.closeTime,
      entryBar: ev.bar,
    });
  }

  const pnls = trades.map((t) => t.pnl);
  const wins = pnls.filter((p) => p >= 0);
  const grossWin = wins.reduce((s, p) => s + p, 0);
  const grossLoss = Math.abs(pnls.filter((p) => p < 0).reduce((s, p) => s + p, 0));

  return {
    finalEquity: cash,
    netPnl: cash - opts.startingEquity,
    trades: trades.length,
    partialTrades: trades.filter((t) => t.sizedFraction < 0.999).length,
    wins: wins.length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? Infinity : 0) : grossWin / grossLoss,
    maxDrawdownPct: maxDd * 100,
    fees,
    missed: missedList.length,
    avgDeployedPct: samples ? (deployedSum / samples) * 100 : 0,
    avgBarsHeld: trades.length ? trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length : 0,
    tradeList: trades,
    missedList,
  };
}
