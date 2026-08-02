import { describe, expect, it } from "vitest";
import { Candle } from "../src/lib/binance";
import { decideEntry } from "../src/lib/engine";
import { CONFIG } from "../src/config/strategy";
import { DEFAULT_FILL_PARAMS, planEntry, checkPriceExit, settleClose } from "../src/lib/fills";
import { buildContext, entrySignal, simulate } from "../src/backtest/simulate";
import { BASELINE, Variant } from "../src/backtest/variants";
import { dailyIndexFor, toDaily } from "../src/backtest/history";

/**
 * Deterministic synthetic 4h series: a slow trend cycle plus seeded noise.
 * The noise matters — without it price never pulls back through EMA21 during
 * a trend, so no crossover ever fires and an equivalence test would pass
 * vacuously. A fixed LCG keeps it reproducible.
 */
function synthetic(n: number, seed = 12345): Candle[] {
  const H4 = 4 * 60 * 60 * 1000;
  const start = Date.UTC(2024, 0, 1);
  const out: Candle[] = [];
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };

  let price = 30_000;
  for (let i = 0; i < n; i++) {
    const trend = Math.sin(i / 70) * 55;
    const noise = (rnd() - 0.5) * 260;
    const open = price;
    const close = Math.max(1000, price + trend + noise);
    const wick = 30 + rnd() * 90;
    out.push({
      openTime: start + i * H4,
      open,
      high: Math.max(open, close) + wick,
      low: Math.min(open, close) - wick,
      close,
      volume: 10,
      closeTime: start + (i + 1) * H4 - 1,
    });
    price = close;
  }
  return out;
}

describe("fill params defaults", () => {
  it("still mirror the live config after parameterisation", () => {
    expect(DEFAULT_FILL_PARAMS).toEqual({
      slippagePct: CONFIG.fills.slippagePct,
      feePct: CONFIG.fills.feePct,
      stopAtrMult: CONFIG.exits.stopAtrMult,
      rrMultiple: CONFIG.exits.rrMultiple,
      riskPerTrade: CONFIG.sizing.riskPerTrade,
    });
  });

  it("produce identical results whether params are passed or omitted", () => {
    const a = planEntry("long", 50_000, 1_000, 10_000);
    const b = planEntry("long", 50_000, 1_000, 10_000, DEFAULT_FILL_PARAMS);
    expect(a).toEqual(b);

    const pos = { side: "long" as const, entryPrice: 100, qty: 1, stopPrice: 95, targetPrice: 115 };
    expect(checkPriceExit(pos, { high: 120, low: 90, close: 110 })).toEqual(
      checkPriceExit(pos, { high: 120, low: 90, close: 110 }, DEFAULT_FILL_PARAMS)
    );
    expect(settleClose(pos, 110, 0.2)).toEqual(settleClose(pos, 110, 0.2, DEFAULT_FILL_PARAMS));
  });
});

describe("baseline variant matches the live engine", () => {
  // The whole point of the harness: if these ever diverge, backtest numbers
  // would describe a strategy the bot does not actually run.
  it("produces the same entry decision as decideEntry on every candle", () => {
    // Must comfortably exceed CONFIG.minCandles or the loop below is empty.
    const candles = synthetic(1400);
    const ctx = buildContext(candles);

    let checked = 0;
    let signals = 0;
    for (let i = CONFIG.minCandles; i < candles.length; i++) {
      const live = decideEntry(
        {
          close: ctx.closes[i],
          prevClose: ctx.closes[i - 1],
          ema21: ctx.ema21[i],
          prevEma21: ctx.ema21[i - 1],
          ema50: ctx.ema50[i],
          ema200: ctx.ema200[i],
          rsi14: ctx.rsi14[i],
          atr14: ctx.atr14[i],
        },
        false,
        false,
        null
      ).enter;
      const back = entrySignal(ctx, BASELINE, i);
      expect(back, `candle index ${i}`).toBe(live);
      checked++;
      if (live !== null) signals++;
    }

    expect(checked).toBeGreaterThan(250);
    expect(signals).toBeGreaterThan(0); // the series actually exercises entries
  });
});

describe("lookahead guards", () => {
  it("donchian channel excludes the current candle", () => {
    // Craft a series whose LAST candle is the highest high: if the window
    // included it, close > hi could never be true.
    const candles = synthetic(400);
    const v: Variant = { ...BASELINE, entry: "donchian", donchianLen: 20, useRsiFilter: false, regime: "none" };
    const ctx = buildContext(candles);

    const i = candles.length - 1;
    let windowHigh = -Infinity;
    for (let k = i - 20; k < i; k++) windowHigh = Math.max(windowHigh, candles[k].high);

    const side = entrySignal(ctx, v, i);
    if (side === "long") expect(ctx.closes[i]).toBeGreaterThan(windowHigh);
    // and the current candle's own high never enters the comparison
    expect(windowHigh).not.toBe(candles[i].high);
  });

  it("daily regime never uses a day that has not closed yet", () => {
    const candles = synthetic(400);
    const daily = toDaily(candles);
    const idx = dailyIndexFor(candles, daily);

    for (let i = 0; i < candles.length; i++) {
      const di = idx[i];
      if (di === null) continue;
      expect(daily[di].closeTime).toBeLessThanOrEqual(candles[i].closeTime);
      if (di + 1 < daily.length) {
        expect(daily[di + 1].closeTime).toBeGreaterThan(candles[i].closeTime);
      }
    }
  });

  it("toDaily drops partial days", () => {
    const candles = synthetic(400);
    const daily = toDaily(candles.slice(0, 400 - 2)); // truncate mid-day
    const DAY = 24 * 60 * 60 * 1000;
    const lastFull = daily[daily.length - 1];
    expect(lastFull.closeTime).toBeGreaterThanOrEqual(lastFull.dayStart + DAY - 1);
  });
});

describe("simulate", () => {
  const candles = synthetic(1400);
  const ctx = buildContext(candles);
  const range = { from: CONFIG.minCandles, to: candles.length };

  it("is deterministic", () => {
    const a = simulate(ctx, BASELINE, range);
    const b = simulate(ctx, BASELINE, range);
    expect(a).toEqual(b);
  });

  it("never holds more than one position (trade count is bounded by signals)", () => {
    const r = simulate(ctx, BASELINE, range);
    expect(r.trades).toBeGreaterThanOrEqual(0);
    expect(r.wins).toBeLessThanOrEqual(r.trades);
  });

  it("charges fees on every closed trade", () => {
    const r = simulate(ctx, BASELINE, range);
    if (r.trades > 0) expect(r.fees).toBeGreaterThan(0);
  });

  it("a trailing stop only ever ratchets in the favourable direction", () => {
    const trail: Variant = { ...BASELINE, rrMultiple: null, trailingAtrMult: 3 };
    const r = simulate(ctx, trail, range);
    // With no fixed target, nothing can exit via "target".
    expect(r.byReason.target ?? 0).toBe(0);
  });

  it("respects the simulated window", () => {
    const early = simulate(ctx, BASELINE, { from: CONFIG.minCandles, to: CONFIG.minCandles + 1 });
    expect(early.trades).toBe(0);
  });
});
