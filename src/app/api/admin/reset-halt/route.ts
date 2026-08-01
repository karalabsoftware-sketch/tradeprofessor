import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { STRATEGY_VERSION } from "@/config/strategy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Manual halt reset (admin only). Clears the halt flag and re-bases the
 * counters that can trigger it (loss streak, daily baseline, equity peak) so
 * the bot does not immediately re-halt on the same stale numbers.
 */
export async function POST(req: Request) {
  const secret = process.env.ADMIN_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sql = db();
  const rows = await sql`
    UPDATE bot_state SET
      halted = false,
      halt_reason = NULL,
      consecutive_losses = 0,
      day_start_equity = equity,
      day_start_date = ${new Date().toISOString().slice(0, 10)},
      peak_equity = equity,
      updated_at = now()
    WHERE id = 1
    RETURNING equity, halted
  `;
  if (rows.length === 0) {
    return NextResponse.json({ error: "bot_state not initialized" }, { status: 409 });
  }

  await sql`
    INSERT INTO signals (symbol, candle_time, action, reason, strategy_version)
    VALUES ('*', NULL, 'halt', 'halt manually reset via admin route', ${STRATEGY_VERSION})
  `;
  return NextResponse.json({ ok: true, equity: Number(rows[0].equity), halted: false });
}
