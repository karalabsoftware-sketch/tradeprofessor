/**
 * Strategy backtest runner. READ-ONLY: touches no database and cannot affect
 * the running bot. Nothing here changes what the live bot trades — that is
 * fixed by src/config/strategy.ts.
 *
 *   npm run backtest                    # default: ~14000 4h candles, 70/30 split
 *   npm run backtest -- --candles 6000
 *   npm run backtest -- --split 0.6
 *   npm run backtest -- --variant baseline
 *
 * The split matters more than any single number: variants are DEVELOPED by
 * looking at the training half, and the holdout half is the honest estimate.
 * A variant that only shines in training is a fitted artefact, not an edge.
 */

import { fetchHistory } from "../src/backtest/history";
import { buildContext, simulate, BacktestResult } from "../src/backtest/simulate";
import { VARIANTS } from "../src/backtest/variants";
import { CONFIG } from "../src/config/strategy";

interface Args {
  candles: number;
  split: number;
  variant: string | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { candles: 14000, split: 0.7, variant: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    if (argv[i] === "--candles" && v) out.candles = Number(v);
    if (argv[i] === "--split" && v) out.split = Number(v);
    if (argv[i] === "--variant" && v) out.variant = v.toLowerCase();
  }
  if (!Number.isFinite(out.candles) || out.candles < 1000) out.candles = 14000;
  if (!(out.split > 0.2 && out.split < 0.9)) out.split = 0.7;
  return out;
}

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
const padL = (s: string, n: number) => s.padStart(n);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function table(title: string, rows: BacktestResult[]): void {
  console.log(`\n${title}`);
  console.log(
    pad("VARIANT", 28) + padL("TRADES", 7) + padL("WIN%", 7) + padL("PF", 7) +
    padL("NET $", 10) + padL("MAXDD%", 8) + padL("AVG $", 9) + padL("FEES $", 9)
  );
  console.log("-".repeat(85));
  for (const r of rows) {
    console.log(
      pad(r.variant, 28) +
        padL(String(r.trades), 7) +
        padL(r.trades ? r.winRatePct.toFixed(1) : "—", 7) +
        padL(r.trades ? (r.profitFactor === Infinity ? "inf" : r.profitFactor.toFixed(2)) : "—", 7) +
        padL(r.netPnl.toFixed(0), 10) +
        padL(r.maxDrawdownPct.toFixed(1), 8) +
        padL(r.trades ? r.avgTrade.toFixed(1) : "—", 9) +
        padL(r.fees.toFixed(0), 9)
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const symbol = CONFIG.symbols[0].symbol;

  const chosen = args.variant
    ? VARIANTS.filter((v) => v.name.toLowerCase().includes(args.variant as string))
    : VARIANTS;
  if (chosen.length === 0) {
    console.error(`No variant matches "${args.variant}". Available:`);
    for (const v of VARIANTS) console.error(`  - ${v.name}`);
    process.exit(1);
  }

  console.log(`Fetching ~${args.candles} ${CONFIG.interval} ${symbol} candles…`);
  const candles = await fetchHistory(symbol, CONFIG.interval, args.candles);
  const ctx = buildContext(candles);

  const splitIdx = Math.floor(candles.length * args.split);
  const years = (n: number) => ((n * 4) / 24 / 365).toFixed(1);

  console.log(
    `${candles.length} candles | ${day(candles[0].openTime)} -> ${day(candles[candles.length - 1].openTime)} (~${years(candles.length)}y)`
  );
  console.log(
    `TRAIN   : ${day(candles[CONFIG.minCandles].openTime)} -> ${day(candles[splitIdx - 1].openTime)} (~${years(splitIdx - CONFIG.minCandles)}y)`
  );
  console.log(
    `HOLDOUT : ${day(candles[splitIdx].openTime)} -> ${day(candles[candles.length - 1].openTime)} (~${years(candles.length - splitIdx)}y)`
  );
  console.log(`Daily candles available for the 1d regime filter: ${ctx.daily.length}`);

  const train = chosen.map((v) => simulate(ctx, v, { from: CONFIG.minCandles, to: splitIdx }));
  const holdout = chosen.map((v) => simulate(ctx, v, { from: splitIdx, to: candles.length }));

  table("=== TRAIN (used for choosing — expect these to flatter) ===", train);
  table("=== HOLDOUT (never used for choosing — the honest number) ===", holdout);

  console.log("\nEXIT REASONS (holdout)");
  holdout.forEach((r, i) => {
    const t = r.byReason;
    console.log(
      `  ${pad(chosen[i].name, 28)} target=${t.target ?? 0}  stop=${t.stop ?? 0}  regime-flip=${t["regime-flip"] ?? 0}`
    );
  });

  console.log(`\nVariants tested: ${chosen.length}.`);
  console.log(
    "With this many variants, the best HOLDOUT row is still partly luck. Treat a variant as\n" +
      "promising only if it beats the baseline in BOTH halves and its neighbours behave\n" +
      "similarly — a lone spike surrounded by bad settings is noise, not an edge."
  );
  console.log(
    "\nThis run changed nothing. The live bot keeps trading " +
      `${CONFIG.version} until src/config/strategy.ts is edited and its version bumped.`
  );
}

main().catch((err) => {
  console.error("Backtest failed:", err);
  process.exit(1);
});
