/**
 * Seed script:
 *  1. applies schema.sql (idempotent)
 *  2. backfills the last 400 4h candles for every enabled symbol
 *  3. computes indicators over the backfill as a sanity check (printed)
 *  4. initializes bot_state FLAT at $10,000 starting from the last closed candle
 *
 * Usage: npm run seed   (requires DATABASE_URL in .env.local or .env)
 */

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv();

import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { CONFIG, STRATEGY_VERSION } from "../src/config/strategy";
import { closedCandles, fetchKlines } from "../src/lib/binance";
import { atr, ema, rsi } from "../src/lib/indicators";

const SEED_CANDLES = 400;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (put it in .env.local)");
  const sql = postgres(url, { ssl: "require", max: 1, prepare: false });

  console.log("Applying schema…");
  await sql.unsafe(readFileSync(join(__dirname, "..", "src", "lib", "schema.sql"), "utf8"));

  let lastClosedTime: number | null = null;

  for (const { symbol, enabled } of CONFIG.symbols) {
    if (!enabled) {
      console.log(`Skipping ${symbol} (disabled by config)`);
      continue;
    }
    console.log(`Fetching last ${SEED_CANDLES} ${CONFIG.interval} candles for ${symbol}…`);
    const candles = await fetchKlines(symbol, CONFIG.interval, SEED_CANDLES);
    const closed = closedCandles(candles, Date.now());
    console.log(`  ${closed.length} closed candles`);

    const rows = closed.map((c) => ({
      symbol,
      open_time: c.openTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      close_time: c.closeTime,
    }));
    await sql`INSERT INTO candles ${sql(rows)} ON CONFLICT (symbol, open_time) DO NOTHING`;

    // Indicator sanity check on the latest closed candle.
    const closes = closed.map((c) => c.close);
    const i = closed.length - 1;
    const e21 = ema(closes, CONFIG.indicators.emaFast)[i];
    const e50 = ema(closes, CONFIG.indicators.emaMid)[i];
    const e200 = ema(closes, CONFIG.indicators.emaSlow)[i];
    const r14 = rsi(closes, CONFIG.indicators.rsiPeriod)[i];
    const a14 = atr(closed, CONFIG.indicators.atrPeriod)[i];
    console.log(
      `  ${symbol} @ ${new Date(closed[i].openTime).toISOString()}  close=${closes[i]}  ` +
        `EMA21=${e21?.toFixed(2)} EMA50=${e50?.toFixed(2)} EMA200=${e200?.toFixed(2)} ` +
        `RSI14=${r14?.toFixed(2)} ATR14=${a14?.toFixed(2)}  regime=${
          e50 !== null && e200 !== null ? (e50 > e200 ? "BULL" : "BEAR") : "?"
        }`
    );
    lastClosedTime = closed[i].openTime;
  }

  const existing = await sql`SELECT id FROM bot_state WHERE id = 1`;
  if (existing.length > 0) {
    console.log("bot_state already initialized — leaving it untouched.");
  } else {
    const today = new Date().toISOString().slice(0, 10);
    const seedReason = `seeded: bot starts FLAT at $${CONFIG.account.startingEquity}; trading begins with the next closed candle`;
    await sql`
      INSERT INTO bot_state (
        id, equity, peak_equity, day_start_equity, day_start_date,
        consecutive_losses, halted, last_candle_time
      ) VALUES (
        1, ${CONFIG.account.startingEquity}, ${CONFIG.account.startingEquity},
        ${CONFIG.account.startingEquity}, ${today}, 0, false, ${lastClosedTime}
      )
    `;
    await sql`
      INSERT INTO signals (symbol, candle_time, action, reason, strategy_version)
      VALUES ('*', ${lastClosedTime}, 'none', ${seedReason}, ${STRATEGY_VERSION})
    `;
    console.log(
      `bot_state initialized: equity $${CONFIG.account.startingEquity}, flat, ` +
        `first tradable candle after ${lastClosedTime ? new Date(lastClosedTime).toISOString() : "?"}`
    );
  }

  await sql.end();
  console.log("Seed complete.");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
