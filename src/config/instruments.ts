/**
 * Instrument registry — what the bot watches, and where the data comes from.
 *
 * Deliberately NOT one strategy per instrument. We measured the same rules
 * across ten crypto symbols and per-symbol results were uncorrelated between
 * the training and holdout halves (ADA 0.75 -> 1.45, DOT 1.26 -> 0.43), so
 * fitting bespoke parameters per instrument would be fitting noise. Every
 * instrument runs the SAME rules; only the bar interval differs, and that is
 * dictated by the venue rather than chosen for performance.
 */

import { VENUE_RULES, VenueKey } from "./strategy";

export type Venue = VenueKey;
export type Provider = "binance" | "yahoo";

export interface Instrument {
  /** Stable key used in the database and URLs. Never reuse or rename. */
  id: string;
  label: string;
  venue: Venue;
  provider: Provider;
  /** Symbol as the provider spells it. */
  providerSymbol: string;
  enabled: boolean;
  /** Shown on the dashboard when the instrument cannot trade yet. */
  note?: string;
}

/** Bar length comes from the venue, never from the individual instrument. */
export function intervalOf(inst: Instrument): string {
  return VENUE_RULES[inst.venue].interval;
}
export function intervalMsOf(inst: Instrument): number {
  return VENUE_RULES[inst.venue].intervalMs;
}

export const INSTRUMENTS: Instrument[] = [
  // ---- crypto (Binance, 4h bars, long + short) ----
  { id: "BTCUSDT", label: "Bitcoin", venue: "crypto", provider: "binance", providerSymbol: "BTCUSDT", enabled: true },
  { id: "ETHUSDT", label: "Ethereum", venue: "crypto", provider: "binance", providerSymbol: "ETHUSDT", enabled: true },
  { id: "SOLUSDT", label: "Solana", venue: "crypto", provider: "binance", providerSymbol: "SOLUSDT", enabled: true },
  { id: "XRPUSDT", label: "XRP", venue: "crypto", provider: "binance", providerSymbol: "XRPUSDT", enabled: true },
  { id: "SUIUSDT", label: "Sui", venue: "crypto", provider: "binance", providerSymbol: "SUIUSDT", enabled: true },
  { id: "HBARUSDT", label: "Hedera", venue: "crypto", provider: "binance", providerSymbol: "HBARUSDT", enabled: true },

  // ---- US equities (Yahoo, daily bars, long only) ----
  { id: "AAPL", label: "Apple", venue: "us-equity", provider: "yahoo", providerSymbol: "AAPL", enabled: true },
  { id: "AMZN", label: "Amazon", venue: "us-equity", provider: "yahoo", providerSymbol: "AMZN", enabled: true },
  { id: "INTC", label: "Intel", venue: "us-equity", provider: "yahoo", providerSymbol: "INTC", enabled: true },
  { id: "META", label: "Meta", venue: "us-equity", provider: "yahoo", providerSymbol: "META", enabled: true },
  { id: "NVDA", label: "NVIDIA", venue: "us-equity", provider: "yahoo", providerSymbol: "NVDA", enabled: true },
  {
    id: "SPCX",
    label: "SpaceX",
    venue: "us-equity",
    provider: "yahoo",
    providerSymbol: "SPCX",
    enabled: true,
    // Listed 2026-06-12. On daily bars EMA200 needs ~800 trading days of
    // history, so this one sits idle for years rather than months. That is
    // not a bug to work around: a 200-day trend cannot be computed for a
    // stock that has not traded 200 days. The existing warmup guard handles
    // it with no special-casing.
    note: "Listed June 2026 — a 200-day trend needs ~800 trading days of history, so it stays idle until roughly 2029",
  },
];

export const VENUE_LABELS: Record<Venue, string> = {
  crypto: "Crypto",
  "us-equity": "US Stocks",
};

export function enabledInstruments(): Instrument[] {
  return INSTRUMENTS.filter((i) => i.enabled);
}

export function instrumentById(id: string): Instrument | undefined {
  return INSTRUMENTS.find((i) => i.id === id);
}

export function instrumentsByVenue(venue: Venue): Instrument[] {
  return INSTRUMENTS.filter((i) => i.venue === venue && i.enabled);
}
