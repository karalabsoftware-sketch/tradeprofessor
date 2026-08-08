import { NextResponse } from "next/server";
import { runEvaluation } from "@/lib/engine-multi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10; // stay inside Vercel Hobby's function limit

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await runEvaluation();
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
