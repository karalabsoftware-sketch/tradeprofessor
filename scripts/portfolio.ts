/**
 * Shared-capital portfolio backtest. READ-ONLY.
 *
 *   npm run portfolio
 *
 * Answers the two questions the isolated-capital backtests structurally
 * cannot: how far should the target sit when holding a position costs other
 * instruments their signals, and does scaling a position down to fit the
 * remaining cash beat skipping it?
 */

import { fetchHistory } from "../src/backtest/history";
import { buildContext } from "../src/backtest/simulate";
import { simulatePortfolio, PortfolioInstrument } from "../src/backtest/portfolio";
import { BASELINE } from "../src/backtest/variants";
import { CONFIG, VENUE_RULES } from "../src/config/strategy";
import { enabledInstruments, intervalOf } from "../src/config/instruments";
import { fetchCandles, Candle } from "../src/lib/marketdata";
import { DEFAULT_FILL_PARAMS } from "../src/lib/fills";

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
const padL = (s: string, n: number) => s.padStart(n);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

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

function variantFor(base: PortfolioInstrument, rr: number): PortfolioInstrument {
  return {
    ...base,
    variant: { ...base.variant, rrMultiple: rr },
    fills: { ...base.fills, rrMultiple: rr },
  };
}

async function main() {
  console.log("Veri yukleniyor…");
  const { base, from, to } = await load();
  const split = from + (to - from) * 0.7;
  const years = (ms: number) => (ms / (365 * 24 * 3600 * 1000)).toFixed(1);

  console.log(`\n${base.length} enstruman | ortak pencere ${day(from)} -> ${day(to)} (~${years(to - from)}y)`);
  console.log(`TRAIN ${day(from)} -> ${day(split)}   HOLDOUT ${day(split)} -> ${day(to)}`);
  console.log(`Sermaye: TEK paylasimli $${CONFIG.account.startingEquity.toLocaleString("en-US")}\n`);

  const header =
    pad("KONFIGURASYON", 26) + padL("ISLEM", 7) + padL("KISMI", 7) + padL("KACAN", 7) +
    padL("KAZ%", 7) + padL("PF", 7) + padL("NET $", 10) + padL("MAXDD", 8) +
    padL("ORT.BAR", 9) + padL("DOLU%", 8);

  for (const [label, lo, hi] of [["TRAIN", from, split], ["HOLDOUT", split, to]] as const) {
    console.log(`=== ${label} ===`);
    console.log(header);
    console.log("-".repeat(103));

    type Mode = "always" | "profitable-only";
    const cases: { rr: number; partial: boolean; maxBars: number | null; mode: Mode }[] = [
      { rr: 4, partial: false, maxBars: null, mode: "always" }, // v1.2.0
      { rr: 4, partial: true, maxBars: null, mode: "always" },
      { rr: 2, partial: true, maxBars: null, mode: "always" },
      // zaman stopu: kosulsuz vs sadece kardaysa
      { rr: 4, partial: true, maxBars: 60, mode: "always" }, // v1.3.0
      { rr: 4, partial: true, maxBars: 60, mode: "profitable-only" },
      { rr: 4, partial: true, maxBars: 42, mode: "always" },
      { rr: 4, partial: true, maxBars: 42, mode: "profitable-only" },
      { rr: 4, partial: true, maxBars: 90, mode: "always" },
      { rr: 4, partial: true, maxBars: 90, mode: "profitable-only" },
      { rr: 4, partial: true, maxBars: 30, mode: "profitable-only" },
    ];

    for (const c of cases) {
      {
        const { rr, partial, maxBars, mode } = c;
        const insts = base.map((b) => variantFor(b, rr));
        const r = simulatePortfolio(insts, lo, hi, {
          allowPartial: partial,
          minPartialFraction: 0.25,
          startingEquity: CONFIG.account.startingEquity,
          maxBarsHeld: maxBars,
          timeStopMode: mode,
        });
        console.log(
          pad(`1:${rr}${partial ? "+ks" : ""}${maxBars ? ` +${maxBars}b${mode === "profitable-only" ? "(kar)" : ""}` : ""}`, 26) +
          padL(String(r.trades), 7) +
          padL(String(r.partialTrades), 7) +
          padL(String(r.missed), 7) +
          padL(r.trades ? r.winRatePct.toFixed(1) : "-", 7) +
          padL(r.trades ? (isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : "inf") : "-", 7) +
          padL(r.netPnl.toFixed(0), 10) +
          padL(r.maxDrawdownPct.toFixed(1) + "%", 8) +
          padL(r.avgBarsHeld.toFixed(1), 9) +
          padL(r.avgDeployedPct.toFixed(0) + "%", 8)
        );
      }
    }
    console.log("");
  }

  console.log("ORT.BAR = pozisyonun acik kaldigi ortalama bar sayisi");
  console.log("DOLU%   = sermayenin ortalama ne kadarinin bagli oldugu");
  console.log("KISMI   = kalan nakde sigacak sekilde kucultulerek acilan islem sayisi");
  console.log("\nBu calisma hicbir seyi degistirmedi.");
}

main().catch((err) => {
  console.error("Portfolio backtest failed:", err);
  process.exit(1);
});
