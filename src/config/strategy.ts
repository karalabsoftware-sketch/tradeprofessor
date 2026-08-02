/**
 * Versioned strategy configuration — the ONLY place strategy parameters live.
 * Any parameter change requires bumping `version`; trades store the version
 * they were produced under and results from different versions are never mixed.
 */

export const STRATEGY_VERSION = "btc-4h-trend-v1.0.0";

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

  /** Candles fetched per evaluation; must exceed minCandles for EMA200 warmup. */
  fetchLimit: 320,
  /** Minimum closed candles required before the engine will make decisions. */
  minCandles: 300,

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
