import { describe, expect, it } from "vitest";
import { atr, crossedAbove, crossedBelow, ema, rsi } from "../src/lib/indicators";

describe("ema", () => {
  it("is null during warmup, seeds with SMA, then applies k = 2/(period+1)", () => {
    // Series 1..10 with period 3: seed = SMA(1,2,3) = 2, k = 0.5.
    // Each subsequent price is exactly 2 above the running EMA + step, giving
    // hand-computable values: 2, 3, 4, 5, 6, 7, 8, 9.
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const out = ema(values, 3);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBe(2);
    expect(out[3]).toBe(3);
    expect(out[4]).toBe(4);
    expect(out[9]).toBe(9);
  });

  it("stays at the price level for a constant series", () => {
    const out = ema([5, 5, 5, 5, 5, 5], 3);
    expect(out[5]).toBeCloseTo(5, 12);
  });

  it("returns all null when there is not enough data", () => {
    expect(ema([1, 2], 3).every((v) => v === null)).toBe(true);
  });
});

describe("rsi (Wilder)", () => {
  // Classic 14-period worked example (Wilder / StockCharts dataset).
  const closes = [
    44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245,
    45.8433, 46.0826, 45.8931, 46.0328, 45.614, 46.282, 46.282, 46.0028,
    46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2521, 45.7137, 46.4515,
    45.7835, 45.3548, 44.0288, 44.1783, 44.2181,
  ];

  it("matches the published Wilder example values", () => {
    const out = rsi(closes, 14);
    expect(out[13]).toBeNull(); // needs period+1 closes
    expect(out[14]).toBeCloseTo(70.53, 1);
    expect(out[15]).toBeCloseTo(66.32, 1);
    expect(out[16]).toBeCloseTo(66.55, 1);
    expect(out[17]).toBeCloseTo(69.41, 1);
    expect(out[18]).toBeCloseTo(66.36, 1);
    expect(out[19]).toBeCloseTo(57.97, 1);
  });

  it("is 100 for monotonic gains and 0 for monotonic losses", () => {
    const up = Array.from({ length: 20 }, (_, i) => 100 + i);
    const down = Array.from({ length: 20 }, (_, i) => 100 - i);
    expect(rsi(up, 14)[19]).toBe(100);
    expect(rsi(down, 14)[19]).toBe(0);
  });

  it("is 50 for a flat series (no gains, no losses)", () => {
    const flat = Array.from({ length: 20 }, () => 42);
    expect(rsi(flat, 14)[19]).toBe(50);
  });
});

describe("atr (Wilder)", () => {
  it("computes true range with gaps and applies Wilder smoothing", () => {
    // Hand-computed, period 3:
    // TR1 = 10-8 = 2 (no prev close)
    // TR2 = max(11-9=2, |11-9|=2, |9-9|=0) = 2
    // TR3 = max(14-12=2, |14-10|=4, |12-10|=2) = 4   (gap up)
    // seed ATR(idx2) = (2+2+4)/3 = 8/3
    // TR4 = max(13-11=2, |13-13|=0, |11-13|=2) = 2
    // ATR(idx3) = (8/3 * 2 + 2)/3 = 22/9
    const candles = [
      { high: 10, low: 8, close: 9 },
      { high: 11, low: 9, close: 10 },
      { high: 14, low: 12, close: 13 },
      { high: 13, low: 11, close: 12 },
    ];
    const out = atr(candles, 3);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo(8 / 3, 12);
    expect(out[3]).toBeCloseTo(22 / 9, 12);
  });
});

describe("crossover events", () => {
  it("fires only on the crossing candle, not while staying above", () => {
    // prev close below EMA, current above -> event
    expect(crossedAbove(99, 100, 101, 100)).toBe(true);
    // already above on both candles -> level, not event
    expect(crossedAbove(101, 100, 102, 100)).toBe(false);
    // touching from below counts as "at or below" then crossing
    expect(crossedAbove(100, 100, 101, 100)).toBe(true);
  });

  it("mirrors for crossunder", () => {
    expect(crossedBelow(101, 100, 99, 100)).toBe(true);
    expect(crossedBelow(99, 100, 98, 100)).toBe(false);
  });

  it("never fires while the EMA is warming up (null)", () => {
    expect(crossedAbove(99, null, 101, 100)).toBe(false);
    expect(crossedBelow(101, 100, 99, null)).toBe(false);
  });
});
