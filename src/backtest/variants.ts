/**
 * Strategy variants to compare. These exist ONLY for the backtest — the live
 * bot always runs `CONFIG` / STRATEGY_VERSION and is unaffected by anything
 * here.
 *
 * Keep this list SHORT. Every extra variant raises the chance that the best
 * result is luck rather than edge, which is why the runner prints the count
 * and the holdout numbers are the ones that matter.
 */

import { CONFIG } from "@/config/strategy";

export interface Variant {
  name: string;
  note: string;
  entry: "ema21-cross" | "donchian";
  /** Lookback for the Donchian channel (ignored by other entries). */
  donchianLen?: number;
  useRsiFilter: boolean;
  rsiLongMin: number;
  rsiShortMax: number;
  /** Which series decides long-only vs short-only. */
  regime: "4h" | "1d" | "none";
  stopAtrMult: number;
  /** Fixed target as a multiple of stop distance; null = no fixed target. */
  rrMultiple: number | null;
  /** ATR multiple for a ratcheting stop; null = fixed stop. */
  trailingAtrMult: number | null;
}

/** Exactly the live strategy — the yardstick every variant is measured against. */
export const BASELINE: Variant = {
  name: "baseline (live v1.0.0)",
  note: "EMA21 crossover + RSI gate + 4h regime, fixed 2.5xATR stop and 1:3 target",
  entry: "ema21-cross",
  useRsiFilter: true,
  rsiLongMin: CONFIG.entry.rsiLongMin,
  rsiShortMax: CONFIG.entry.rsiShortMax,
  regime: "4h",
  stopAtrMult: CONFIG.exits.stopAtrMult,
  rrMultiple: CONFIG.exits.rrMultiple,
  trailingAtrMult: null,
};

export const VARIANTS: Variant[] = [
  BASELINE,
  {
    ...BASELINE,
    name: "RR 1:2",
    note: "closer target — trades more of the moves that stall before 3R",
    rrMultiple: 2,
  },
  {
    ...BASELINE,
    name: "RR 1:4",
    note: "further target — tests whether the winners actually run further",
    rrMultiple: 4,
  },
  {
    ...BASELINE,
    name: "trailing 3xATR, no target",
    note: "ride the trend: ratcheting stop, exit only on stop or regime flip",
    rrMultiple: null,
    trailingAtrMult: 3,
  },
  {
    ...BASELINE,
    name: "trailing 3xATR + 1:3 target",
    note: "keeps the 3R target but protects open profit on the way",
    trailingAtrMult: 3,
  },
  {
    ...BASELINE,
    name: "daily regime filter",
    note: "trend direction from the daily EMA50/200 instead of the 4h one",
    regime: "1d",
  },
  {
    name: "donchian 20 breakout",
    note: "turtle-style: close breaks the 20-candle high/low, 4h regime, no RSI gate",
    entry: "donchian",
    donchianLen: 20,
    useRsiFilter: false,
    rsiLongMin: CONFIG.entry.rsiLongMin,
    rsiShortMax: CONFIG.entry.rsiShortMax,
    regime: "4h",
    stopAtrMult: CONFIG.exits.stopAtrMult,
    rrMultiple: CONFIG.exits.rrMultiple,
    trailingAtrMult: null,
  },
  {
    name: "donchian 55 + trailing",
    note: "slower breakout with a ratcheting stop and no fixed target",
    entry: "donchian",
    donchianLen: 55,
    useRsiFilter: false,
    rsiLongMin: CONFIG.entry.rsiLongMin,
    rsiShortMax: CONFIG.entry.rsiShortMax,
    regime: "4h",
    stopAtrMult: CONFIG.exits.stopAtrMult,
    rrMultiple: null,
    trailingAtrMult: 3,
  },
];
