/**
 * Versioned strategy configuration — the ONLY place strategy parameters live.
 * Any parameter change requires bumping `version`; trades store the version
 * they were produced under and results from different versions are never mixed.
 */

/**
 * v1.0.1 — the trading RULES are unchanged from v1.0.0. Only the indicator
 * warmup was fixed (see `fetchLimit`). The version is still bumped because the
 * fix changes which regime the bot sees on roughly a third of candles, so
 * decisions differ materially and results from the two versions must never be
 * pooled.
 */
export const STRATEGY_VERSION = "btc-4h-trend-v1.0.1";

export interface SymbolConfig {
  symbol: string;
  enabled: boolean;
}

export const CONFIG = {
  version: STRATEGY_VERSION,

  /** Symbols the engine iterates. Only `enabled: true` symbols are traded. */
  symbols: [
    { symbol: "BTCUSDT", enabled: true },
    { symbol: "ETHUSDT", enabled: false },
    { symbol: "SOLUSDT", enabled: false },
  ] as SymbolConfig[],

  interval: "4h" as const,
  intervalMs: 4 * 60 * 60 * 1000,

  /**
   * Candles fetched per evaluation. 1000 is Binance's per-request maximum.
   *
   * This is NOT a free parameter — it must be several times `emaSlow`. An EMA
   * is seeded with an SMA of its first `period` values, and the seed's
   * influence only decays as (1 - 2/(period+1))^n. The old value of 320 left
   * EMA200 with just 120 update steps, so ~30% of the value was still the
   * arbitrary seed: measured against a full-history EMA200 it was off by ~319
   * points (0.5%), which flipped the bull/bear regime on 36% of recent
   * candles. At 1000 candles EMA200 gets ~800 steps and the seed's influence
   * falls below 0.05%. Guarded by a test in tests/warmup.test.ts.
   */
  fetchLimit: 1000,
  /**
   * Minimum closed candles required before the engine will decide anything.
   * Sized to the same warmup requirement, not to a bare indicator minimum.
   */
  minCandles: 800,

  indicators: {
    emaFast: 21,
    emaMid: 50,
    emaSlow: 200,
    rsiPeriod: 14,
    atrPeriod: 14,
  },

  entry: {
    /** LONG requires RSI14 strictly above this. */
    rsiLongMin: 52,
    /** SHORT requires RSI14 strictly below this. */
    rsiShortMax: 48,
  },

  exits: {
    /** Stop = entry -/+ stopAtrMult * ATR14. */
    stopAtrMult: 2.5,
    /** Target distance = rrMultiple * stop distance (1:3 RR). */
    rrMultiple: 3,
  },

  sizing: {
    /** qty = (equity * riskPerTrade) / (stopAtrMult * ATR14) — 1.5% risk. */
    riskPerTrade: 0.015,
    maxOpenPositions: 1,
  },

  fills: {
    /** 0.05% slippage against trade direction on entries and stop/forced exits. */
    slippagePct: 0.0005,
    /** 0.1% of notional per fill (entry and exit). */
    feePct: 0.001,
  },

  risk: {
    /** Halt new entries if realized loss today >= 4% of day-start equity. */
    dailyLossHaltPct: 0.04,
    /** Halt new entries after this many consecutive losing trades. */
    maxConsecutiveLosses: 6,
    /** Halt new entries if drawdown from peak equity >= 10%. */
    maxDrawdownPct: 0.1,
  },

  account: {
    startingEquity: 10_000,
  },

  /**
   * Operational scheduling — NOT part of the versioned strategy surface.
   * Decisions are always made on the last CLOSED 4h candle, so polling more
   * often than the candle interval cannot change any trade; it only shortens
   * the delay before a closed candle is processed and lets a dropped
   * scheduler run heal on the next poll. Changing these does not require a
   * STRATEGY_VERSION bump.
   */
  /**
   * Presentation only. All storage and logic stay in UTC; this just chooses
   * the zone the dashboard renders timestamps in.
   */
  display: {
    timeZone: "Europe/Istanbul",
  },

  schedule: {
    /** External scheduler polls hourly at this minute past the hour (UTC). */
    pollMinute: 23,
    pollIntervalMs: 60 * 60 * 1000,
    /**
     * No heartbeat for this long => treat the scheduler as down on the
     * dashboard. Two and a half missed hourly polls.
     */
    stalenessMs: 2.5 * 60 * 60 * 1000,
  },
} as const;
