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

export type Venue = "crypto" | "us-equity";
export type Provider = "binance" | "yahoo";

export interface Instrument {
  /** Stable key used in the database and URLs. Never reuse or rename. */
  id: string;
  label: string;
  venue: Venue;
  provider: Provider;
  /** Symbol as the provider spells it. */
  providerSymbol: string;
  interval: string;
  intervalMs: number;
  enabled: boolean;
  /** Shown on the dashboard when the instrument cannot trade yet. */
  note?: string;
}

const H = 60 * 60 * 1000;

/**
 * Crypto trades 24/7, so 4h bars line up with the clock and the strategy that
 * was validated on them.
 *
 * US equities trade 6.5h a day, which no 4h grid divides sensibly, so they use
 * 1h bars. That is a venue constraint, not a tuning decision.
 */
export const INSTRUMENTS: Instrument[] = [
  // ---- crypto (Binance, 4h) ----
  { id: "BTCUSDT", label: "Bitcoin", venue: "crypto", provider: "binance", providerSymbol: "BTCUSDT", interval: "4h", intervalMs: 4 * H, enabled: true },
  { id: "ETHUSDT", label: "Ethereum", venue: "crypto", provider: "binance", providerSymbol: "ETHUSDT", interval: "4h", intervalMs: 4 * H, enabled: true },
  { id: "SOLUSDT", label: "Solana", venue: "crypto", provider: "binance", providerSymbol: "SOLUSDT", interval: "4h", intervalMs: 4 * H, enabled: true },
  { id: "XRPUSDT", label: "XRP", venue: "crypto", provider: "binance", providerSymbol: "XRPUSDT", interval: "4h", intervalMs: 4 * H, enabled: true },
  { id: "SUIUSDT", label: "Sui", venue: "crypto", provider: "binance", providerSymbol: "SUIUSDT", interval: "4h", intervalMs: 4 * H, enabled: true },
  { id: "HBARUSDT", label: "Hedera", venue: "crypto", provider: "binance", providerSymbol: "HBARUSDT", interval: "4h", intervalMs: 4 * H, enabled: true },

  // ---- US equities (Yahoo, 1h) ----
  { id: "AAPL", label: "Apple", venue: "us-equity", provider: "yahoo", providerSymbol: "AAPL", interval: "1h", intervalMs: H, enabled: true },
  { id: "AMZN", label: "Amazon", venue: "us-equity", provider: "yahoo", providerSymbol: "AMZN", interval: "1h", intervalMs: H, enabled: true },
  { id: "INTC", label: "Intel", venue: "us-equity", provider: "yahoo", providerSymbol: "INTC", interval: "1h", intervalMs: H, enabled: true },
  { id: "META", label: "Meta", venue: "us-equity", provider: "yahoo", providerSymbol: "META", interval: "1h", intervalMs: H, enabled: true },
  { id: "NVDA", label: "NVIDIA", venue: "us-equity", provider: "yahoo", providerSymbol: "NVDA", interval: "1h", intervalMs: H, enabled: true },
  {
    id: "SPCX",
    label: "SpaceX",
    venue: "us-equity",
    provider: "yahoo",
    providerSymbol: "SPCX",
    interval: "1h",
    intervalMs: H,
    enabled: true,
    // Listed 2026-06-12. EMA200 needs ~800 bars of warmup and at ~7 bars per
    // trading day that lands around November 2026. The engine refuses to
    // decide before then, so it simply sits idle — no special-casing needed.
    note: "Listed June 2026 — collecting history for EMA200 warmup, cannot trade yet",
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
