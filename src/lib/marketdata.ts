/**
 * Unified market data. One `Candle` shape, two providers:
 *  - Binance public REST for crypto (no key, 24/7)
 *  - Yahoo Finance chart API for US equities (no key, session hours only)
 *
 * Neither needs credentials, which keeps the project on free tiers. Both are
 * read-only price feeds; nothing here can place an order.
 */

import { Candle, fetchKlines } from "./binance";
import { Instrument, intervalOf } from "@/config/instruments";

export type { Candle };

const YAHOO_HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const UA = "Mozilla/5.0 (compatible; PaperTradeBot/1.0; +https://github.com/karalabsoftware-sketch/tradeprofessor)";

/** Yahoo needs a range string; pick the smallest one that covers `limit` bars. */
function yahooRange(interval: string, limit: number): string {
  if (interval === "1d") return limit > 1200 ? "10y" : "5y";
  // Intraday history on Yahoo is capped around 730 days.
  const perDay = 7; // ~6.5h session, one bar per hour
  const days = Math.ceil(limit / perDay) * 1.6; // weekends/holidays padding
  if (days <= 60) return "3mo";
  if (days <= 180) return "6mo";
  if (days <= 360) return "1y";
  return "2y";
}

interface YahooQuote {
  open: (number | null)[];
  high: (number | null)[];
  low: (number | null)[];
  close: (number | null)[];
  volume: (number | null)[];
}

async function fetchYahoo(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  const range = yahooRange(interval, limit);
  let lastError: unknown = null;

  for (const host of YAHOO_HOSTS) {
    const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
    try {
      const res = await fetch(url, {
        cache: "no-store",
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`${host} responded HTTP ${res.status}`);
      const body = (await res.json()) as {
        chart?: { result?: unknown[]; error?: { description?: string; code?: string } | null };
      };
      if (body.chart?.error) {
        throw new Error(body.chart.error.description ?? body.chart.error.code ?? "yahoo error");
      }
      const result = body.chart?.result?.[0] as
        | { timestamp?: number[]; indicators?: { quote?: YahooQuote[] } }
        | undefined;
      const ts = result?.timestamp;
      const q = result?.indicators?.quote?.[0];
      if (!ts || !q) throw new Error(`${host} returned no candles for ${symbol}`);

      const out: Candle[] = [];
      for (let i = 0; i < ts.length; i++) {
        const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
        // Halts, holidays and the padding Yahoo emits come through as nulls.
        if (o == null || h == null || l == null || c == null) continue;
        const openTime = ts[i] * 1000;
        out.push({
          openTime,
          open: o,
          high: h,
          low: l,
          close: c,
          volume: q.volume[i] ?? 0,
          closeTime: openTime + intervalToMs(interval) - 1,
        });
      }
      if (out.length === 0) throw new Error(`${host} returned only empty bars for ${symbol}`);
      return out.slice(-limit);
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `Yahoo failed for ${symbol} ${interval}: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

export function intervalToMs(interval: string): number {
  const m = /^(\d+)([mhdw])$/.exec(interval);
  if (!m) throw new Error(`unsupported interval: ${interval}`);
  const n = Number(m[1]);
  switch (m[2]) {
    case "m": return n * 60 * 1000;
    case "h": return n * 60 * 60 * 1000;
    case "d": return n * 24 * 60 * 60 * 1000;
    case "w": return n * 7 * 24 * 60 * 60 * 1000;
    default: throw new Error(`unsupported interval: ${interval}`);
  }
}

/** Fetch the most recent `limit` bars for an instrument, oldest first. */
export async function fetchCandles(
  inst: Instrument,
  limit: number,
  intervalOverride?: string
): Promise<Candle[]> {
  const interval = intervalOverride ?? intervalOf(inst);
  const raw =
    inst.provider === "binance"
      ? await fetchKlines(inst.providerSymbol, interval, limit)
      : await fetchYahoo(inst.providerSymbol, interval, limit);

  // Providers occasionally repeat a bar across paged/cached responses.
  const seen = new Set<number>();
  return raw
    .filter((c) => (seen.has(c.openTime) ? false : (seen.add(c.openTime), true)))
    .sort((a, b) => a.openTime - b.openTime);
}

/**
 * Bars whose close time has passed. Decisions only ever use these, so an
 * in-progress bar can never influence a trade.
 */
export function closedOnly(candles: Candle[], nowMs: number): Candle[] {
  return candles.filter((c) => c.closeTime <= nowMs);
}
