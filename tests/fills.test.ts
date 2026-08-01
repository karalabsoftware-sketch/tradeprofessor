import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config/strategy";
import { checkPriceExit, forcedExitPrice, planEntry, settleClose } from "../src/lib/fills";
import { decideEntry } from "../src/lib/engine";

const SLIP = CONFIG.fills.slippagePct; // 0.0005
const FEE = CONFIG.fills.feePct; // 0.001

describe("planEntry", () => {
  it("long: slippage against direction, 2.5*ATR stop, 1:3 RR, 1.5% risk sizing", () => {
    const close = 50_000;
    const atr = 1_000;
    const equity = 10_000;
    const p = planEntry("long", close, atr, equity);

    expect(p.entryPrice).toBeCloseTo(close * (1 + SLIP), 8); // 50025
    expect(p.stopDistance).toBeCloseTo(2.5 * atr, 8); // 2500
    expect(p.stopPrice).toBeCloseTo(p.entryPrice - 2500, 8);
    expect(p.targetPrice).toBeCloseTo(p.entryPrice + 3 * 2500, 8);
    expect(p.qty).toBeCloseTo((equity * 0.015) / 2500, 12); // 0.06
    expect(p.entryFee).toBeCloseTo(p.qty * p.entryPrice * FEE, 8);
    // risk if stopped (ignoring fees/slippage-on-exit) = 1.5% of equity
    expect(p.qty * p.stopDistance).toBeCloseTo(equity * 0.015, 8);
  });

  it("short: entry slips DOWN, stop above, target below", () => {
    const p = planEntry("short", 50_000, 1_000, 10_000);
    expect(p.entryPrice).toBeCloseTo(50_000 * (1 - SLIP), 8);
    expect(p.stopPrice).toBeGreaterThan(p.entryPrice);
    expect(p.targetPrice).toBeLessThan(p.entryPrice);
    expect(p.targetPrice).toBeCloseTo(p.entryPrice - 3 * 2500, 8);
  });
});

describe("checkPriceExit — conservative same-candle rule", () => {
  const long = { side: "long" as const, entryPrice: 100, qty: 1, stopPrice: 95, targetPrice: 115 };

  it("assumes STOP first when a candle touches both stop and target", () => {
    const fill = checkPriceExit(long, { high: 120, low: 90, close: 110 });
    expect(fill?.reason).toBe("stop");
    expect(fill?.price).toBeCloseTo(95 * (1 - SLIP), 10);
  });

  it("fills target exactly when only the target is touched", () => {
    const fill = checkPriceExit(long, { high: 116, low: 99, close: 114 });
    expect(fill?.reason).toBe("target");
    expect(fill?.price).toBe(115);
  });

  it("returns null when neither level is touched", () => {
    expect(checkPriceExit(long, { high: 110, low: 96, close: 105 })).toBeNull();
  });

  it("short: stop is above, slippage pushes the stop fill higher (worse)", () => {
    const short = { side: "short" as const, entryPrice: 100, qty: 1, stopPrice: 105, targetPrice: 85 };
    const both = checkPriceExit(short, { high: 106, low: 84, close: 90 });
    expect(both?.reason).toBe("stop");
    expect(both?.price).toBeCloseTo(105 * (1 + SLIP), 10);
    const target = checkPriceExit(short, { high: 101, low: 84, close: 86 });
    expect(target?.reason).toBe("target");
    expect(target?.price).toBe(85);
  });
});

describe("settleClose", () => {
  it("nets out entry fee, exit fee and direction", () => {
    const pos = { side: "long" as const, entryPrice: 100, qty: 2, stopPrice: 95, targetPrice: 115 };
    const entryFee = 2 * 100 * FEE; // 0.2
    const r = settleClose(pos, 110, entryFee);
    expect(r.grossPnl).toBeCloseTo(20, 10);
    expect(r.exitFee).toBeCloseTo(2 * 110 * FEE, 10); // 0.22
    expect(r.netPnl).toBeCloseTo(20 - 0.2 - 0.22, 10);
    expect(r.netPnlPct).toBeCloseTo(((20 - 0.42) / 200) * 100, 10);
  });

  it("short profit when price falls", () => {
    const pos = { side: "short" as const, entryPrice: 100, qty: 1, stopPrice: 105, targetPrice: 85 };
    const r = settleClose(pos, 85, 0.1);
    expect(r.grossPnl).toBeCloseTo(15, 10);
    expect(r.netPnl).toBeCloseTo(15 - 0.1 - 85 * FEE, 10);
  });
});

describe("forcedExitPrice (regime-flip close)", () => {
  it("slips against the trade direction", () => {
    expect(forcedExitPrice("long", 100)).toBeCloseTo(100 * (1 - SLIP), 12);
    expect(forcedExitPrice("short", 100)).toBeCloseTo(100 * (1 + SLIP), 12);
  });
});

describe("decideEntry — strategy gates", () => {
  const base = {
    close: 102,
    prevClose: 99,
    ema21: 100,
    prevEma21: 100,
    ema50: 100,
    ema200: 90, // bull regime
    rsi14: 60,
    atr14: 2,
  };

  it("takes a long on crossover + RSI > 52 + bull regime + flat", () => {
    expect(decideEntry(base, false, false, null).enter).toBe("long");
  });

  it("blocks entries while a position is open (max 1)", () => {
    const d = decideEntry(base, true, false, null);
    expect(d.enter).toBeNull();
    expect(d.reason).toContain("position already open");
  });

  it("blocks entries while halted", () => {
    const d = decideEntry(base, false, true, "6 consecutive losses");
    expect(d.enter).toBeNull();
    expect(d.reason).toContain("halted");
  });

  it("rejects RSI inside the dead band [48, 52] even with a crossover", () => {
    expect(decideEntry({ ...base, rsi14: 52 }, false, false, null).enter).toBeNull();
    expect(decideEntry({ ...base, rsi14: 48 }, false, false, null).enter).toBeNull();
    expect(decideEntry({ ...base, rsi14: 50 }, false, false, null).enter).toBeNull();
  });

  it("bull regime blocks shorts even on a crossunder with weak RSI", () => {
    const d = decideEntry(
      { ...base, close: 98, prevClose: 101, rsi14: 40 },
      false,
      false,
      null
    );
    expect(d.enter).toBeNull();
    expect(d.reason).toContain("blocks shorts");
  });

  it("takes a short on crossunder + RSI < 48 + bear regime", () => {
    const d = decideEntry(
      { ...base, close: 98, prevClose: 101, ema50: 90, ema200: 100, rsi14: 40 },
      false,
      false,
      null
    );
    expect(d.enter).toBe("short");
  });

  it("requires the crossover EVENT, not just being above the EMA", () => {
    const d = decideEntry({ ...base, prevClose: 101 }, false, false, null); // already above
    expect(d.enter).toBeNull();
    expect(d.reason).toContain("no EMA21 crossover event");
  });

  it("does nothing while indicators warm up", () => {
    const d = decideEntry({ ...base, ema200: null }, false, false, null);
    expect(d.enter).toBeNull();
    expect(d.reason).toContain("warming up");
  });
});
