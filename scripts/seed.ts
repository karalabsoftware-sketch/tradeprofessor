/**
 * Seed script:
 *  1. applies both schema files (idempotent)
 *  2. backfills candles for every enabled instrument
 *  3. reports which instruments are ready and which are still warming up
 *  4. initializes the shared account FLAT at $10,000
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
import { enabledInstruments } from "../src/config/instruments";
import { fetchCandles, closedOnly } from "../src/lib/marketdata";
import { atr, ema, rsi } from "../src/lib/indicators";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (put it in .env.local)");
  const sql = postgres(url, { ssl: "require", max: 1, prepare: false });

  const libDir = join(__dirname, "..", "src", "lib");
  console.log("Applying schema…");
  await sql.unsafe(readFileSync(join(libDir, "schema.sql"), "utf8"));
  console.log("Applying multi-instrument schema…");
  await sql.unsafe(readFileSync(join(libDir, "schema-multi.sql"), "utf8"));

  const instruments = enabledInstruments();
  console.log(`\nBackfilling ${instruments.length} instruments (${CONFIG.fetchLimit} bars each)…\n`);

  let ready = 0;
  let warming = 0;

  for (const inst of instruments) {
    try {
      const all = await fetchCandles(inst, CONFIG.fetchLimit);
      const closed = closedOnly(all, Date.now());

      if (closed.length > 0) {
        const rows = closed.map((c) => ({
          symbol: inst.id, open_time: c.openTime, open: c.open, high: c.high,
          low: c.low, close: c.close, volume: c.volume, close_time: c.closeTime,
        }));
        await sql`INSERT INTO candles ${sql(rows)} ON CONFLICT (symbol, open_time) DO NOTHING`;
      }

      const enough = closed.length >= CONFIG.minCandles;
      let detail = "";
      if (enough) {
        const cl = closed.map((c) => c.close);
        const i = cl.length - 1;
        const e50 = ema(cl, CONFIG.indicators.emaMid)[i];
        const e200 = ema(cl, CONFIG.indicators.emaSlow)[i];
        const r = rsi(cl, CONFIG.indicators.rsiPeriod)[i];
        const a = atr(closed, CONFIG.indicators.atrPeriod)[i];
        const dp = cl[i] < 1 ? 6 : 2;
        detail = `close=${cl[i].toFixed(dp)} RSI=${r?.toFixed(1)} ATR=${a?.toFixed(dp)} regime=${
          e50 !== null && e200 !== null ? (e50 > e200 ? "BULL" : "BEAR") : "?"
        }`;
        ready++;
      } else {
        detail = `WARMING UP — ${closed.length}/${CONFIG.minCandles} bars${inst.note ? ` (${inst.note})` : ""}`;
        warming++;
      }

      await sql`
        INSERT INTO instrument_state (instrument_id, warming_up, candles_seen, updated_at)
        VALUES (${inst.id}, ${!enough}, ${closed.length}, now())
        ON CONFLICT (instrument_id) DO UPDATE SET
          warming_up = ${!enough}, candles_seen = ${closed.length}, updated_at = now()
      `;

      console.log(`  ${inst.id.padEnd(9)} ${inst.venue.padEnd(10)} ${String(closed.length).padStart(5)} bars  ${detail}`);
    } catch (err) {
      console.log(`  ${inst.id.padEnd(9)} FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const existing = await sql`SELECT id FROM account_state WHERE id = 1`;
  if (existing.length > 0) {
    console.log("\naccount_state already initialized — leaving it untouched.");
  } else {
    const today = new Date().toISOString().slice(0, 10);
    const eq = CONFIG.account.startingEquity;
    await sql`
      INSERT INTO account_state (
        id, realized_equity, peak_equity, day_start_equity, day_start_date,
        consecutive_losses, halted, strategy_version
      ) VALUES (1, ${eq}, ${eq}, ${eq}, ${today}, 0, false, ${STRATEGY_VERSION})
    `;
    console.log(`\naccount_state initialized: ONE shared account of $${eq.toLocaleString("en-US")}.`);
  }

  console.log(`\n${ready} instruments ready to trade, ${warming} still warming up.`);
  console.log(`Strategy version: ${STRATEGY_VERSION}`);
  await sql.end();
  console.log("Seed complete.");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
