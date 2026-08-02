import { describe, expect, it } from "vitest";
import {
  computeMetrics,
  formatAge,
  nextCandleClose,
  nextPoll,
  schedulerHealth,
} from "../src/lib/metrics";

const HOUR = 60 * 60 * 1000;
const at = (iso: string) => new Date(iso).getTime();

describe("nextPoll", () => {
  it("returns this hour's slot when it is still ahead", () => {
    expect(nextPoll(at("2026-08-02T06:10:00Z"), 23).toISOString()).toBe("2026-08-02T06:23:00.000Z");
  });

  it("rolls to the next hour once the slot has passed", () => {
    expect(nextPoll(at("2026-08-02T06:30:00Z"), 23).toISOString()).toBe("2026-08-02T07:23:00.000Z");
  });

  it("rolls past midnight correctly", () => {
    expect(nextPoll(at("2026-08-02T23:45:00Z"), 23).toISOString()).toBe("2026-08-03T00:23:00.000Z");
  });

  it("treats the exact slot minute as already passed", () => {
    expect(nextPoll(at("2026-08-02T06:23:00Z"), 23).toISOString()).toBe("2026-08-02T07:23:00.000Z");
  });
});

describe("nextCandleClose", () => {
  const FOUR_H = 4 * HOUR;

  it("returns the next 4h boundary", () => {
    expect(nextCandleClose(at("2026-08-02T06:20:00Z"), FOUR_H).toISOString()).toBe("2026-08-02T08:00:00.000Z");
    expect(nextCandleClose(at("2026-08-02T23:59:00Z"), FOUR_H).toISOString()).toBe("2026-08-03T00:00:00.000Z");
  });

  it("moves to the following boundary when exactly on one", () => {
    expect(nextCandleClose(at("2026-08-02T08:00:00Z"), FOUR_H).toISOString()).toBe("2026-08-02T12:00:00.000Z");
  });
});

describe("schedulerHealth", () => {
  const now = at("2026-08-02T06:20:00Z");
  const staleness = 2.5 * HOUR;

  it("is healthy right after a run", () => {
    const h = schedulerHealth(new Date(now - 30 * 60 * 1000), now, staleness);
    expect(h.stale).toBe(false);
    expect(h.ageMs).toBe(30 * 60 * 1000);
  });

  it("is stale once the window is exceeded", () => {
    const h = schedulerHealth(new Date(now - 3 * HOUR), now, staleness);
    expect(h.stale).toBe(true);
  });

  it("treats a bot that never ran as stale with a null age", () => {
    const h = schedulerHealth(null, now, staleness);
    expect(h.stale).toBe(true);
    expect(h.ageMs).toBeNull();
  });
});

describe("formatAge", () => {
  it("formats minutes and hours compactly", () => {
    expect(formatAge(5 * 60 * 1000)).toBe("5m");
    expect(formatAge(59 * 60 * 1000)).toBe("59m");
    expect(formatAge(2 * HOUR)).toBe("2h");
    expect(formatAge(2 * HOUR + 14 * 60 * 1000)).toBe("2h 14m");
  });
});

describe("computeMetrics", () => {
  const t = (pnl: number) => ({ pnl, entry_fee: 1, exit_fee: 1 });

  it("returns empty-safe values with no trades", () => {
    const m = computeMetrics([], []);
    expect(m.totalTrades).toBe(0);
    expect(m.winRatePct).toBeNull();
    expect(m.profitFactor).toBeNull();
    expect(m.avgTrade).toBe(0);
    expect(m.currentStreak).toBe(0);
  });

  it("computes win rate, profit factor, fees and average", () => {
    // newest first: +30, -10, +20
    const m = computeMetrics([t(30), t(-10), t(20)], []);
    expect(m.totalTrades).toBe(3);
    expect(m.wins).toBe(2);
    expect(m.winRatePct).toBeCloseTo((2 / 3) * 100, 6);
    expect(m.profitFactor).toBeCloseTo(50 / 10, 6);
    expect(m.avgTrade).toBeCloseTo(40 / 3, 6);
    expect(m.totalFees).toBe(6);
  });

  it("reports profit factor as Infinity when there are no losses", () => {
    expect(computeMetrics([t(10), t(5)], []).profitFactor).toBe(Infinity);
  });

  it("counts the current streak from the newest trade backwards", () => {
    expect(computeMetrics([t(5), t(8), t(-2)], []).currentStreak).toBe(2);
    expect(computeMetrics([t(-5), t(-8), t(3)], []).currentStreak).toBe(-2);
  });

  it("computes max drawdown from the equity series peak", () => {
    const m = computeMetrics([], [10000, 12000, 9000, 11000]);
    expect(m.maxDrawdownPct).toBeCloseTo(25, 6); // 12000 -> 9000
  });
});
