import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config/strategy";
import { ema } from "../src/lib/indicators";

/**
 * Regression guard for the v1.0.1 fix.
 *
 * An EMA is seeded with an SMA of its first `period` values and the seed's
 * influence decays only as (1 - 2/(period+1))^n. If the bot fetches too few
 * candles, EMA200 never escapes that seed and the bull/bear regime — the
 * strategy's primary directional gate — is computed from a number that is
 * simply wrong. That is exactly what shipped in v1.0.0.
 */

/** Trending series with noise: SMA and EMA diverge strongly in a trend, which
 *  is what makes an inadequate seed visible. */
function trendingCloses(n: number, seed = 987): number[] {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const out: number[] = [];
  let price = 20_000;
  for (let i = 0; i < n; i++) {
    price = price * (1 + 0.0009 + (rnd() - 0.5) * 0.012); // upward drift + noise
    out.push(price);
  }
  return out;
}

/** Relative gap between an EMA computed over `window` values and over everything. */
function warmupError(closes: number[], period: number, window: number): number {
  const full = ema(closes, period);
  const short = ema(closes.slice(-window), period);
  const a = full[full.length - 1] as number;
  const b = short[short.length - 1] as number;
  return Math.abs(b - a) / a;
}

describe("indicator warmup is sized to the slowest EMA", () => {
  const slow = CONFIG.indicators.emaSlow;

  it("fetchLimit leaves the slowest EMA enough steps to escape its seed", () => {
    // Rule of thumb: an EMA needs several times its period to converge.
    expect(CONFIG.fetchLimit).toBeGreaterThanOrEqual(slow * 4);
    // And the engine must not act on less than it fetched for.
    expect(CONFIG.minCandles).toBeGreaterThanOrEqual(slow * 4);
    expect(CONFIG.fetchLimit).toBeGreaterThanOrEqual(CONFIG.minCandles);
  });

  it("EMA200 over fetchLimit candles matches a full-history EMA200", () => {
    const closes = trendingCloses(6000);
    const err = warmupError(closes, slow, CONFIG.fetchLimit);
    expect(err).toBeLessThan(0.001); // < 0.1%
  });

  it("the fast EMAs were never affected", () => {
    const closes = trendingCloses(6000);
    expect(warmupError(closes, CONFIG.indicators.emaFast, CONFIG.fetchLimit)).toBeLessThan(1e-9);
    expect(warmupError(closes, CONFIG.indicators.emaMid, CONFIG.fetchLimit)).toBeLessThan(1e-9);
  });

  it("demonstrates why 320 candles was not enough (the v1.0.0 bug)", () => {
    const closes = trendingCloses(6000);
    const broken = warmupError(closes, slow, 320);
    const fixed = warmupError(closes, slow, CONFIG.fetchLimit);
    // On live BTC data the old window was off by ~0.5%; on this synthetic
    // series it is smaller, so the load-bearing assertion is the RATIO — the
    // old window is worse by more than an order of magnitude either way.
    expect(broken).toBeGreaterThan(0.001);
    expect(broken).toBeGreaterThan(fixed * 10);
  });
});
