/**
 * Historical candle loading for the backtest. Read-only, no database.
 * Binance caps a klines request at 1000 rows, so longer histories are paged
 * backwards with endTime.
 */

import { Candle } from "@/lib/binance";

const HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"];

async function getJson(path: string): Promise<unknown[]> {
  let lastErr: unknown = null;
  for (const host of HOSTS) {
    try {
      const res = await fetch(`${host}${path}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as unknown[];
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`klines request failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

function toCandle(row: unknown): Candle {
  const k = row as [number, string, string, string, string, string, number, ...unknown[]];
  return {
    openTime: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: Number(k[6]),
  };
}

/** Fetch at least `want` CLOSED candles, oldest first. */
export async function fetchHistory(symbol: string, interval: string, want: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let endTime: number | undefined;

  while (out.length < want) {
    const q = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=1000` +
      (endTime ? `&endTime=${endTime}` : "");
    const raw = await getJson(q);
    if (raw.length === 0) break;
    const batch = raw.map(toCandle);
    out.unshift(...batch);
    endTime = batch[0].openTime - 1;
    if (raw.length < 1000) break;
  }

  const seen = new Set<number>();
  const now = Date.now();
  return out
    .filter((c) => (seen.has(c.openTime) ? false : (seen.add(c.openTime), true)))
    .sort((a, b) => a.openTime - b.openTime)
    .filter((c) => c.closeTime <= now);
}

export interface DailyCandle {
  dayStart: number; // UTC midnight
  closeTime: number;
  close: number;
}

/**
 * Aggregate 4h candles into UTC daily candles.
 * Only days with a candle whose close lands at/after the day's end are
 * complete; incomplete trailing days are dropped so nothing half-formed feeds
 * the regime filter.
 */
export function toDaily(candles: Candle[]): DailyCandle[] {
  const DAY = 24 * 60 * 60 * 1000;
  const byDay = new Map<number, Candle[]>();
  // Input is already oldest-first, so recording each day the first time it is
  // seen keeps dayOrder sorted without touching a Map iterator.
  const dayOrder: number[] = [];
  for (const c of candles) {
    const day = Math.floor(c.openTime / DAY) * DAY;
    const list = byDay.get(day);
    if (list) {
      list.push(c);
    } else {
      byDay.set(day, [c]);
      dayOrder.push(day);
    }
  }

  const expectedPerDay = DAY / (4 * 60 * 60 * 1000); // 6 four-hour candles
  const out: DailyCandle[] = [];
  for (const day of dayOrder) {
    const list = byDay.get(day) as Candle[];
    if (list.length < expectedPerDay) continue; // partial day
    const last = list[list.length - 1];
    out.push({ dayStart: day, closeTime: last.closeTime, close: last.close });
  }
  return out;
}

/**
 * For each 4h candle, the index of the most recent daily candle that had
 * ALREADY CLOSED by that candle's close. This is the guard against lookahead:
 * a 4h candle inside day D may only see daily data up to D-1.
 */
export function dailyIndexFor(candles: Candle[], daily: DailyCandle[]): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  let d = -1;
  for (let i = 0; i < candles.length; i++) {
    while (d + 1 < daily.length && daily[d + 1].closeTime <= candles[i].closeTime) d++;
    out[i] = d >= 0 ? d : null;
  }
  return out;
}
