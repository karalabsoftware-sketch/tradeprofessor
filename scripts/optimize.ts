/**
 * Per-instrument parameter study. READ-ONLY: no database, no effect on the
 * live bot.
 *
 * The question this answers is NOT "what are the best parameters for each
 * instrument?" — a grid search always returns an answer to that, and the
 * answer is usually noise. The question is:
 *
 *     Does tuning per instrument beat shared parameters OUT OF SAMPLE?
 *
 * So each instrument's grid is searched on the TRAINING half only, the winner
 * is locked in, and it is then judged on the HOLDOUT half against the shared
 * baseline. If per-instrument tuning is real, the tuned picks should beat the
 * baseline on the holdout for most instruments. If it is noise, they will beat
 * it about half the time — a coin flip.
 *
 *   npm run optimize
 *   npm run optimize -- --instrument BTCUSDT
 */

import { fetchHistory } from "../src/backtest/history";
import { buildContext, simulate, BacktestResult } from "../src/backtest/simulate";
import { BASELINE, Variant } from "../src/backtest/variants";
import { CONFIG } from "../src/config/strategy";
import { enabledInstruments, Instrument, intervalOf } from "../src/config/instruments";
import { fetchCandles, Candle } from "../src/lib/marketdata";

/** Small on purpose: every extra cell makes the winner more likely to be luck. */
const GRID = {
  stopAtrMult: [1.5, 2.0, 2.5, 3.0, 3.5],
  rrMultiple: [2, 3, 4],
  bandHalfWidth: [1, 2, 3], // 49/51, 48/52 (baseline), 47/53
};

const CRYPTO_BARS = 14000;
const EQUITY_BARS = 4000;

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
const padL = (s: string, n: number) => s.padStart(n);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function gridVariants(): Variant[] {
  const out: Variant[] = [];
  for (const stop of GRID.stopAtrMult) {
    for (const rr of GRID.rrMultiple) {
      for (const half of GRID.bandHalfWidth) {
        out.push({
          ...BASELINE,
          name: `stop${stop}/rr${rr}/band${50 - half}-${50 + half}`,
          stopAtrMult: stop,
          rrMultiple: rr,
          rsiLongMin: 50 + half,
          rsiShortMax: 50 - half,
        });
      }
    }
  }
  return out;
}

async function history(inst: Instrument): Promise<Candle[]> {
  // Binance pages backwards for real depth; Yahoo caps intraday at ~2 years.
  return inst.provider === "binance"
    ? fetchHistory(inst.providerSymbol, intervalOf(inst), CRYPTO_BARS)
    : fetchCandles(inst, EQUITY_BARS);
}

interface Row {
  id: string;
  span: string;
  baseTrain: number;
  baseHold: number;
  baseHoldNet: number;
  bestName: string;
  bestTrain: number;
  tunedHold: number;
  tunedHoldNet: number;
  improved: boolean;
  trades: number;
}

async function main() {
  const only = process.argv.includes("--instrument")
    ? process.argv[process.argv.indexOf("--instrument") + 1]
    : null;

  const variants = gridVariants();
  const instruments = enabledInstruments().filter((i) => !only || i.id === only);

  console.log(`Grid: ${variants.length} parameter combinations per instrument.`);
  console.log(`Chosen on TRAIN, judged on HOLDOUT. Baseline = shared params (${BASELINE.stopAtrMult}xATR, 1:${BASELINE.rrMultiple}, band ${BASELINE.rsiShortMax}-${BASELINE.rsiLongMin}).\n`);

  const rows: Row[] = [];

  for (const inst of instruments) {
    let candles: Candle[];
    try {
      candles = await history(inst);
    } catch (err) {
      console.log(`${pad(inst.id, 10)} data unavailable: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (candles.length < CONFIG.minCandles + 400) {
      console.log(`${pad(inst.id, 10)} skipped — only ${candles.length} bars (needs ${CONFIG.minCandles + 400})`);
      continue;
    }

    const ctx = buildContext(candles);
    const split = Math.floor(candles.length * 0.7);
    const trainRange = { from: CONFIG.minCandles, to: split };
    const holdRange = { from: split, to: candles.length };

    const baseTrain = simulate(ctx, BASELINE, trainRange);
    const baseHold = simulate(ctx, BASELINE, holdRange);

    // Search TRAIN only. The holdout is not consulted to make this choice.
    let best: { v: Variant; r: BacktestResult } | null = null;
    for (const v of variants) {
      const r = simulate(ctx, v, trainRange);
      if (r.trades < 10) continue; // a handful of trades proves nothing
      if (!best || r.profitFactor > best.r.profitFactor) best = { v, r };
    }
    if (!best) {
      console.log(`${pad(inst.id, 10)} no variant produced enough training trades`);
      continue;
    }

    const tunedHold = simulate(ctx, best.v, holdRange);

    rows.push({
      id: inst.id,
      span: `${day(candles[0].openTime)}→${day(candles[candles.length - 1].openTime)}`,
      baseTrain: baseTrain.profitFactor,
      baseHold: baseHold.profitFactor,
      baseHoldNet: baseHold.netPnl,
      bestName: best.v.name,
      bestTrain: best.r.profitFactor,
      tunedHold: tunedHold.profitFactor,
      tunedHoldNet: tunedHold.netPnl,
      improved: tunedHold.profitFactor > baseHold.profitFactor,
      trades: tunedHold.trades,
    });

    console.log(`  ${pad(inst.id, 10)} done (${candles.length} bars)`);
  }

  console.log("\n" + "=".repeat(104));
  console.log(
    pad("INSTRUMENT", 10) + padL("BASE TR", 9) + padL("BASE HO", 9) +
    padL("TUNED TR", 10) + padL("TUNED HO", 10) + padL("HO DELTA", 10) + "  BEST-ON-TRAIN PARAMS"
  );
  console.log("=".repeat(104));

  for (const r of rows) {
    const delta = r.tunedHold - r.baseHold;
    console.log(
      pad(r.id, 10) +
      padL(fmt(r.baseTrain), 9) +
      padL(fmt(r.baseHold), 9) +
      padL(fmt(r.bestTrain), 10) +
      padL(fmt(r.tunedHold), 10) +
      padL((delta >= 0 ? "+" : "") + delta.toFixed(2), 10) +
      `  ${r.bestName}`
    );
  }

  const improved = rows.filter((r) => r.improved).length;
  const baseHoldAvg = avg(rows.map((r) => r.baseHold));
  const tunedHoldAvg = avg(rows.map((r) => r.tunedHold));
  const baseNet = rows.reduce((s, r) => s + r.baseHoldNet, 0);
  const tunedNet = rows.reduce((s, r) => s + r.tunedHoldNet, 0);

  console.log("\n" + "-".repeat(104));
  console.log(`Instruments where tuning beat the shared baseline out of sample: ${improved}/${rows.length}`);
  console.log(`Mean holdout profit factor — baseline ${baseHoldAvg.toFixed(3)} vs tuned ${tunedHoldAvg.toFixed(3)}`);
  console.log(`Total holdout net (each on its own $10k) — baseline ${baseNet.toFixed(0)} vs tuned ${tunedNet.toFixed(0)}`);
  console.log(
    `\n${variants.length} combinations x ${rows.length} instruments = ${variants.length * rows.length} fitted choices.\n` +
    "At that many tries the best TRAIN column is guaranteed to look good; only the\n" +
    "HOLDOUT columns carry information. Around half improving is what noise produces."
  );
  console.log("\nThis run changed nothing. The live bot keeps its shared parameters.");
}

function fmt(v: number): string {
  return !isFinite(v) ? "inf" : v.toFixed(2);
}
function avg(xs: number[]): number {
  const f = xs.filter((x) => isFinite(x));
  return f.length ? f.reduce((s, x) => s + x, 0) / f.length : 0;
}

main().catch((err) => {
  console.error("Optimize failed:", err);
  process.exit(1);
});
