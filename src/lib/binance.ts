/**
 * Binance public market-data client. No API keys, read-only.
 * data-api.binance.vision is Binance's market-data-only mirror and is tried
 * first because api.binance.com geo-blocks some Vercel regions (HTTP 451).
 */

export interface Candle {
  openTime: number; // ms epoch
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number; // ms epoch
}

const HOSTS = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
  "https://api1.binance.com",
];

const PER_HOST_TIMEOUT_MS = 4000;

export async function fetchKlines(
  symbol: string,
  interval: string,
  limit: number
): Promise<Candle[]> {
  let lastError: unknown = null;
  for (const host of HOSTS) {
    const url = `${host}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    try {
      const res = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(PER_HOST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`${host} responded HTTP ${res.status}`);
      const raw = (await res.json()) as unknown[];
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error(`${host} returned empty/invalid klines payload`);
      }
      return raw.map(parseKline);
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `all Binance hosts failed for ${symbol} ${interval}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

function parseKline(row: unknown): Candle {
  const k = row as [number, string, string, string, string, string, number, ...unknown[]];
  const candle: Candle = {
    openTime: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: Number(k[6]),
  };
  for (const [key, v] of Object.entries(candle)) {
    if (!Number.isFinite(v)) throw new Error(`invalid kline field ${key}: ${String(v)}`);
  }
  return candle;
}

/** Candles whose close time is in the past — decisions use closed candles only. */
export function closedCandles(candles: Candle[], nowMs: number): Candle[] {
  return candles.filter((c) => c.closeTime <= nowMs);
}
