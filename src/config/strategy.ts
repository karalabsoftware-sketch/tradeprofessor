/**
 * Versioned strategy configuration — the ONLY place strategy parameters live.
 * Any parameter change requires bumping `version`; trades store the version
 * they were produced under and results from different versions are never mixed.
 */

/**
 * Version history — results from different versions are never pooled.
 *
 * v1.0.0  BTCUSDT 4h only.
 * v1.0.1  Same rules; fixed the EMA200 warmup (fetchLimit 320 -> 1000). The
 *         old window left ~30% of EMA200 as its seed, inverting the bull/bear
 *         regime on 36% of candles.
 * v1.1.0  Same entry/exit rules, applied to twelve instruments across two
 *         venues, sharing ONE $10,000 account. Position sizing is unchanged
 *         (1.5% risk), but a signal can now go untaken when capital is fully
 *         deployed — those refusals are recorded in `missed_opportunities`.
 *         Stop fills became gap-aware, which matters for equities that gap
 *         overnight and can only ever make results more conservative.
 * v1.2.0  Stop widens to 3.5xATR and the target to 1:4, everywhere. Found by
 *         two independent procedures: a per-instrument grid picked a wider
 *         stop on 6 of 11 instruments, and testing it as a single SHARED
 *         change improved the holdout total from -$3,980 to +$653, improving
 *         in both halves for BTC, ETH, SOL and HBAR. Mechanism: a 2.5xATR
 *         stop sits inside normal noise and is taken out before the move
 *         develops. Also introduces VENUE_RULES — see below.
 * v1.3.0  Two capital-efficiency changes, both measured with the new
 *         shared-capital simulator (`npm run portfolio`) rather than the
 *         isolated-capital backtests, which cannot see capital competition:
 *           - partial sizing: a signal that does not fit the free balance is
 *             taken smaller instead of skipped
 *           - 60-bar time stop: a position that has gone nowhere stops
 *             holding every other instrument's signals hostage
 *         Notably, moving the TARGET closer was tested and rejected (1:3 ->
 *         -$733, 1:1.5 -> -$1,911 on holdout). The problem was never the
 *         target distance; it was trades sitting idle. Target stays at 1:4.
 * v1.3.1  The time stop no longer fires on losing positions. The worry was
 *         that losers would accumulate and clog the account; measured, they
 *         do not (holding 44 vs 43 bars, deployment 77% vs 78%) because a
 *         losing trade reaches its stop anyway. P&L between the two flips
 *         sign with the bar limit, i.e. noise — so it is settled on
 *         principle: a losing trade already has a planned exit at its stop.
 */
export const STRATEGY_VERSION = "multi-trend-v1.3.1";

export type VenueKey = "crypto" | "us-equity";

export interface VenueRules {
  interval: string;
  intervalMs: number;
  /** Direction limits applied on top of the regime filter. */
  allowLong: boolean;
  allowShort: boolean;
  stopAtrMult: number;
  /** Target distance as a multiple of the stop distance. */
  rrMultiple: number;
}

/**
 * Venue-level rules. NOT per-instrument tuning — every instrument inside a
 * venue is treated identically, and the two venues differ only where market
 * structure forces it:
 *
 *  - **Bar length.** Crypto trades 24/7 so 4h bars line up with the clock.
 *    US equities trade 6.5h a day, which no 4h grid divides; measured across
 *    the five stocks, daily bars beat hourly in every configuration tested
 *    (e.g. long-only 3.5x/1:4: holdout PF 0.64 on 1h vs 1.51 on 1d).
 *
 *  - **Direction.** Equity prices drift upward over time, so shorting an
 *    individual stock fights that drift. Skipping shorts improved the holdout
 *    in all four paired comparisons (1d 2.5x/1:3: 0.79 -> 1.06; 1d 3.5x/1:4:
 *    0.99 -> 1.51). Crypto has no comparable drift and keeps both directions.
 *
 * The entry rule, indicators, sizing and risk engine are identical everywhere.
 * A Donchian breakout scored the same on equities (holdout 1.49 vs 1.51) and
 * was rejected — a second entry rule is more surface to overfit for no
 * measurable gain.
 */
export const VENUE_RULES: Record<VenueKey, VenueRules> = {
  crypto: {
    interval: "4h",
    intervalMs: 4 * 60 * 60 * 1000,
    allowLong: true,
    allowShort: true,
    stopAtrMult: 3.5,
    rrMultiple: 4,
  },
  "us-equity": {
    interval: "1d",
    intervalMs: 24 * 60 * 60 * 1000,
    allowLong: true,
    allowShort: false,
    stopAtrMult: 3.5,
    rrMultiple: 4,
  },
};

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
    /**
     * Stop = entry -/+ stopAtrMult * ATR14. Widened from 2.5 to 3.5 in
     * v1.2.0; see VENUE_RULES for the evidence. Venue rules override these,
     * but both venues currently use the same numbers.
     */
    stopAtrMult: 3.5,
    /** Target distance = rrMultiple * stop distance (1:4 RR). */
    rrMultiple: 4,
    /**
     * Close a position after this many of its OWN bars, at the close, no
     * matter where price is. Added in v1.3.0 and aimed at capital, not price.
     *
     * With one shared account a position that goes nowhere holds every other
     * instrument's signals hostage. Measured with the shared-capital
     * simulator (`npm run portfolio`), a 60-bar limit cut average holding
     * from 139 bars to 43 and raised holdout net from +$50 to +$650, with
     * trades rising 46 -> 131 and win rate 24% -> 43.5%.
     *
     * Note the venue asymmetry: 60 bars is ~10 days on crypto 4h but ~3
     * months on daily equities, so in practice this binds crypto and rarely
     * touches stocks. That matches where the problem actually was.
     *
     * Tightening it further backfired (42 bars: -$364, 30 bars: -$1,879) —
     * winners need room. 60 is a measured optimum, not a round number, and
     * the drop-off on either side is sharp enough to re-check periodically.
     */
    maxBarsHeld: 60,
    /**
     * Whether the time stop fires on a losing position too.
     *
     * false — only close if the trade is at or above break-even; a losing one
     *         keeps running until its stop or target.
     *
     * The time stop exists to free capital, and the first instinct was to
     * apply it unconditionally. Measured, that instinct does not hold up:
     * restricting it to profitable trades left average holding at 44 bars vs
     * 43 and capital deployment at 77% vs 78% — losing positions do not
     * accumulate, because they reach their stop anyway. The P&L difference
     * flips sign depending on the bar limit (60 bars favours unconditional,
     * 42 favours profit-only), which is the signature of noise rather than
     * edge, so this is decided on principle instead:
     *
     * a losing position already HAS a planned exit — the stop, sized so the
     * loss costs exactly `riskPerTrade`. Closing early on a timer converts a
     * budgeted risk into an unplanned partial loss and gives up the recovery
     * the stop was paying for.
     */
    timeStopWhenLosing: false,
  },

  sizing: {
    /** qty = (equity * riskPerTrade) / (stopAtrMult * ATR14) — 1.5% risk. */
    riskPerTrade: 0.015,
    maxOpenPositions: 1,
    /**
     * When the full-size position will not fit the free balance, take a
     * smaller one instead of skipping the signal. Risk scales down with it,
     * so a half-size trade risks 0.75% rather than 1.5% — strictly safer per
     * trade, and it roughly halves missed opportunities (holdout 147 -> 94).
     */
    allowPartial: true,
    /**
     * Below this share of the intended size the trade is not worth a slot;
     * record it as missed instead. Prevents token positions that add
     * bookkeeping without moving the account.
     */
    minPartialFraction: 0.25,
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
