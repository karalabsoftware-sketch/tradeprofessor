/**
 * Shared-capital portfolio backtest. READ-ONLY.
 *
 *   npm run portfolio           # target x time-limit grid
 *   npm run portfolio -- --live # just the configuration the bot runs today
 *
 * Answers what the isolated-capital backtests structurally cannot: how far
 * should the target sit, and how long should a position be allowed to hold
 * capital, when those two choices interact.
 *
 * They DO interact. A 1:4 target sits 14xATR from entry; price rarely travels
 * that far inside a 60-bar window, so the time limit, not the target, decides
 * most exits. The EXIT MIX column makes that visible: when TGT% is near zero
 * the target is decorative and the pair is mismatched.
 */

import { fetchHistory } from "../src/backtest/history";
import { buildContext } from "../src/backtest/simulate";
import { simulatePortfolio, PortfolioInstrument, PortfolioResult } from "../src/backtest/portfolio";
import { BASELINE } from "../src/backtest/variants";
import { CONFIG, VENUE_RULES } from "../src/config/strategy";
import { enabledInstruments, intervalOf } from "../src/config/instruments";
import { fetchCandles, Candle } from "../src/lib/marketdata";
import { DEFAULT_FILL_PARAMS } from "../src/lib/fills";

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
const padL = (s: string, n: number) => s.padStart(n);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const RR_VALUES = [1.5, 2, 2.5, 3, 4];
const BAR_LIMITS: (number | null)[] = [30, 45, 60, 90, null];

/** `--rr 4,5,6` / `--bars 60,90,none` override the sweep for a focused run. */
function listArg(flag: string): string[] | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1].split(",") : null;
}

async function load(): Promise<{ base: PortfolioInstrument[]; from: number; to: number }> {
  const base: PortfolioInstrument[] = [];
  let latestStart = 0;
  let earliestEnd = Number.MAX_SAFE_INTEGER;

  for (const inst of enabledInstruments()) {
    let candles: Candle[];
    try {
      candles = inst.provider === "binance"
        ? await fetchHistory(inst.providerSymbol, intervalOf(inst), 14000)
        : await fetchCandles(inst, 2600);
    } catch {
      console.log(`  ${inst.id}: veri alinamadi, atlandi`);
      continue;
    }
    if (candles.length < CONFIG.minCandles + 300) {
      console.log(`  ${inst.id}: yetersiz gecmis (${candles.length}), atlandi`);
      continue;
    }
    const rules = VENUE_RULES[inst.venue];
    base.push({
      id: inst.id,
      ctx: buildContext(candles),
      variant: {
        ...BASELINE,
        allowLong: rules.allowLong,
        allowShort: rules.allowShort,
        stopAtrMult: rules.stopAtrMult,
        rrMultiple: rules.rrMultiple,
      },
      fills: { ...DEFAULT_FILL_PARAMS, stopAtrMult: rules.stopAtrMult, rrMultiple: rules.rrMultiple },
    });
    latestStart = Math.max(latestStart, candles[CONFIG.minCandles].closeTime);
    earliestEnd = Math.min(earliestEnd, candles[candles.length - 1].closeTime);
  }
  return { base, from: latestStart, to: earliestEnd };
}

function withRr(base: PortfolioInstrument[], rr: number): PortfolioInstrument[] {
  return base.map((b) => ({
    ...b,
    variant: { ...b.variant, rrMultiple: rr },
    fills: { ...b.fills, rrMultiple: rr },
  }));
}

/** Share of exits by reason — the diagnostic the aggregate numbers hide. */
function exitMix(r: PortfolioResult): { tgt: number; time: number; stop: number } {
  if (r.trades === 0) return { tgt: 0, time: 0, stop: 0 };
  let tgt = 0, time = 0, stop = 0;
  for (const t of r.tradeList) {
    if (t.reason === "target") tgt++;
    else if (t.reason === "time-stop") time++;
    else stop++; // stop + regime-flip
  }
  const n = r.trades;
  return { tgt: (tgt / n) * 100, time: (time / n) * 100, stop: (stop / n) * 100 };
}

function header(): string {
  return (
    pad("HEDEF / SURE", 17) + padL("ISLEM", 6) + padL("KACAN", 6) + padL("KAZ%", 6) +
    padL("PF", 6) + padL("NET $", 9) + padL("MAXDD", 7) + padL("ORT.BAR", 8) +
    padL("TGT%", 6) + padL("SURE%", 7) + padL("STOP%", 7)
  );
}

function line(label: string, r: PortfolioResult): string {
  const m = exitMix(r);
  return (
    pad(label, 17) +
    padL(String(r.trades), 6) +
    padL(String(r.missed), 6) +
    padL(r.trades ? r.winRatePct.toFixed(0) : "-", 6) +
    padL(r.trades ? (isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : "inf") : "-", 6) +
    padL(r.netPnl.toFixed(0), 9) +
    padL(r.maxDrawdownPct.toFixed(0) + "%", 7) +
    padL(r.avgBarsHeld.toFixed(0), 8) +
    padL(m.tgt.toFixed(0), 6) +
    padL(m.time.toFixed(0), 7) +
    padL(m.stop.toFixed(0), 7)
  );
}

async function main() {
  const liveOnly = process.argv.includes("--live");
  console.log("Veri yukleniyor…");
  const { base, from, to } = await load();
  const split = from + (to - from) * 0.7;
  const years = (ms: number) => (ms / (365 * 24 * 3600 * 1000)).toFixed(1);

  console.log(`\n${base.length} enstruman | ortak pencere ${day(from)} -> ${day(to)} (~${years(to - from)}y)`);
  console.log(`TRAIN ${day(from)} -> ${day(split)}   HOLDOUT ${day(split)} -> ${day(to)}`);
  console.log(`Sermaye: TEK paylasimli $${CONFIG.account.startingEquity.toLocaleString("en-US")}`);
  console.log(`Zaman stopu: yalnizca kardaki pozisyonlarda (canli kural)\n`);

  const opts = (maxBars: number | null) => ({
    allowPartial: CONFIG.sizing.allowPartial,
    minPartialFraction: CONFIG.sizing.minPartialFraction,
    startingEquity: CONFIG.account.startingEquity,
    maxBarsHeld: maxBars,
    timeStopMode: "profitable-only" as const,
  });

  const rrArg = listArg("--rr");
  const barsArg = listArg("--bars");
  const rrList = liveOnly
    ? [VENUE_RULES.crypto.rrMultiple]
    : rrArg
      ? rrArg.map(Number)
      : RR_VALUES;
  const barList: (number | null)[] = liveOnly
    ? [CONFIG.exits.maxBarsHeld]
    : barsArg
      ? barsArg.map((b) => (b === "none" ? null : Number(b)))
      : BAR_LIMITS;

  for (const [label, lo, hi] of [["TRAIN", from, split], ["HOLDOUT", split, to]] as const) {
    console.log(`=== ${label} ===`);
    console.log(header());
    console.log("-".repeat(85));
    for (const rr of rrList) {
      for (const bars of barList) {
        const r = simulatePortfolio(withRr(base, rr), lo, hi, opts(bars));
        console.log(line(`1:${rr} / ${bars ?? "sinirsiz"}`, r));
      }
      if (!liveOnly) console.log("");
    }
  }

  console.log("TGT%/SURE%/STOP% = cikislarin hangi sebeple gerceklestigi");
  console.log("TGT% sifira yakinsa hedef fiilen devre disi: sureyi hedef degil, sayac belirliyor.");
  console.log(`\nCanli yapilandirma: 1:${VENUE_RULES.crypto.rrMultiple} hedef, ${CONFIG.exits.maxBarsHeld} bar sinir.`);
  console.log("Bu calisma hicbir seyi degistirmedi.");
}

main().catch((err) => {
  console.error("Portfolio backtest failed:", err);
  process.exit(1);
});
