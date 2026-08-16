# PaperTrade

**Twelve instruments, two venues, one shared $10,000 account.** The same trend
rules run on crypto (Binance, 4h bars) and US stocks (Yahoo Finance, 1h bars).
Capital is finite and shared: when it is fully deployed, a valid signal is
recorded as a **missed opportunity** rather than taken — measuring what a fixed
budget costs is one of the goals, not a side effect.

| Venue | Bars | Direction | Instruments |
|---|---|---|---|
| Crypto | 4h | long + short | BTC, ETH, SOL, XRP, SUI, HBAR |
| US stocks | 1d | **long only** | AAPL, AMZN, INTC, META, NVDA, SPCX |

The two venue settings are the *only* differences, and each was measured
rather than assumed (see [Per-instrument study](#per-instrument-study)):

- **Bars.** A 6.5-hour session does not divide into 4h. Across the five
  stocks, daily beat hourly in every configuration tested — long-only
  3.5×ATR/1:4 scored holdout PF **0.64 on 1h vs 1.51 on 1d**.
- **Direction.** Equity prices drift upward, so shorting single names fights
  that drift. Skipping shorts improved the holdout in all four paired
  comparisons (1d 2.5×/1:3: 0.79 → 1.06; 1d 3.5×/1:4: 0.99 → 1.51).

Stop fills are gap-aware — a bar that opens past the stop fills at the open,
which matters for equities that gap overnight.

> **No per-instrument tuning — and it was tested, not assumed.** See
> [Per-instrument study](#per-instrument-study) below: a 45-cell grid was
> searched per instrument on the training half and judged on the holdout.
> Tuning beat shared parameters on 8 of 11 instruments, which sounds like a
> result until you run the binomial test (p ≈ 0.11 — not significant), and the
> tuned portfolio still lost money. What the grid actually found was a
> *shared* direction, not instrument-specific settings.



A **paper-trading** bot for a 4h BTCUSDT trend strategy, with a public read-only
dashboard. Runs entirely on free tiers: Vercel Hobby + Neon/Supabase Postgres +
GitHub Actions as the scheduler. **No real orders, no exchange keys, no live
trading code paths.** Educational project — not financial advice.

Paper trading is the out-of-sample validation phase: the target is **90 days or
30+ closed trades** of clean data before any live discussion.

## How it works

```
External scheduler (cron-job.org, hourly at :23)   [+ GitHub Actions as backup]
        │  POST /api/cron/evaluate  (Authorization: Bearer CRON_SECRET)
        ▼
Vercel (Next.js App Router, Node runtime, <10s)
        │  1. fetch 4h klines (Binance public REST — no auth)
        │  2. exits: stop / target / regime-flip on every candle since last run
        │  3. risk engine: daily loss ≥4% · 6 consecutive losses · drawdown ≥10%
        │  4. entry signal on the last CLOSED candle only (idempotent per candle)
        │  5. log decision + snapshot equity
        ▼
Postgres (Neon/Supabase free tier): candles · signals · trades · equity_snapshots · bot_state
        ▲
        └── public dashboard (server-rendered, read-only) at /
```

- **Strategy rules** live in one versioned config: [src/config/strategy.ts](src/config/strategy.ts)
  (`btc-4h-trend-v1.0.1`). Every trade and signal stores the version; results
  from different versions are never mixed. Changing any parameter requires a
  version bump.

  > **v1.0.1** — trading rules identical to v1.0.0; only the indicator warmup
  > was fixed. v1.0.0 fetched 320 candles, which left EMA200 with just 120
  > update steps after its SMA seed, so ~30% of the value was still the seed.
  > Measured against a full-history EMA200 it was off by ~319 points (0.5%),
  > which **flipped the bull/bear regime on 36% of recent candles** — the
  > strategy's primary directional gate. `fetchLimit` is now 1000 (Binance's
  > per-request max), giving EMA200 ~800 steps and cutting the seed's
  > influence below 0.05%. The version was bumped because decisions differ
  > materially, so the two versions' results must never be pooled.
- **Idempotent**: decisions key off the last *closed* candle's open time, so
  scheduler retries and a few minutes of GitHub cron drift are no-ops. A poll
  that finds nothing new updates a heartbeat (`bot_state.last_eval_at`) and
  writes no signal row, which is what the dashboard's "scheduler down"
  indicator watches.
- **Hourly polling for a 4h strategy**: the scheduler polls hourly rather than
  every 4h. This cannot change a trade — decisions are still made only on
  closed 4h candles — it just means a dropped run heals within an hour instead
  of costing a full cycle. Caveat: stops/targets are replayed across every
  missed candle, but an entry signal on a candle the bot skipped over is
  **not** backfilled, which is why trigger reliability matters.
- **Every decision is auditable**: each evaluation stores the candle, all
  indicator values, the previous candle's close/EMA21 (so the crossover check
  can be re-verified independently) and a gate-by-gate pass/fail breakdown.
  The dashboard renders that breakdown, so "the bot is broken" and "the market
  did not qualify" are never confused.
- **Conservative fills**: entry at close ±0.05% slippage against direction;
  0.1% fee per fill; if one candle touches both stop and target, the **stop is
  assumed to hit first**; stop/forced exits also pay slippage, targets fill at
  the limit price.
- **Failure honesty**: if the data fetch fails, the cycle is skipped, the error
  is logged to `signals` and `bot_state.last_error`, and shown on the
  dashboard. Fills are never fabricated.

## Setup

### 0. Prerequisites

- Node 18.17+ (Node 20 recommended)
- A free Postgres database:
  - **Neon**: create a project → copy the connection string
  - **Supabase**: Project Settings → Database → **Transaction pooler** URI

### 1. Local install

```bash
npm install
cp .env.example .env.local
```

Fill `.env.local`:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (Neon or Supabase pooler) |
| `CRON_SECRET` | Bearer token the scheduler must send to `/api/cron/evaluate` |
| `ADMIN_SECRET` | Separate bearer token for `/api/admin/reset-halt` |

Generate secrets:

```bash
openssl rand -hex 32
```

### 2. Seed the database

Backfills the last 400 closed 4h candles, prints an indicator sanity check, and
initializes the bot **flat at $10,000**:

```bash
npm run seed
```

Re-running is safe: the schema is idempotent and an existing `bot_state` is
never overwritten.

### 3. Run tests + local dev

```bash
npm test
```

```bash
npm run dev
```

Trigger an evaluation locally:

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/evaluate
```

### 4. Deploy to Vercel (Hobby)

1. Push this repo to GitHub.
2. In Vercel: **Add New Project** → import the repo (defaults are fine).
3. Project → Settings → Environment Variables: add `DATABASE_URL`,
   `CRON_SECRET`, `ADMIN_SECRET` (Production).
4. Deploy. The dashboard is public at the root URL; the evaluate endpoint
   rejects anything without the bearer secret (401).

> Deliberately **no `vercel.json` crons**: Hobby allows only one cron/day and
> the deploy would fail with a 4h schedule. Scheduling lives in GitHub Actions.

### 5. Scheduler (cron-job.org)

The bot does nothing unless something calls `POST /api/cron/evaluate` on a
schedule. **This is the single most failure-prone part of the system**, so it
is worth setting up carefully and verifying.

> **Why not GitHub Actions?** This project originally used a GitHub Actions
> `schedule:` trigger. Across two different cron expressions it fired **zero**
> times over many hours, while every `workflow_dispatch` succeeded — Actions
> was enabled, the workflow `active`, the YAML valid, the file on the default
> branch, the repo public. GitHub's scheduled triggers are explicitly
> best-effort and are dropped under load. The workflow is kept as harmless
> backup; the real trigger is external.

Set up at [cron-job.org](https://cron-job.org) (free, supports custom headers):

1. Create an account and click **Create cronjob**.
2. **URL**: `https://<your-app>.vercel.app/api/cron/evaluate`
3. **Schedule**: every hour at minute **23**. (Any minute works, but the
   dashboard's "Next check" is computed from `CONFIG.schedule.pollMinute`,
   which is 23 — change one or the other to keep them consistent.)
4. Expand **Advanced** →
   - **Request method**: `POST`
   - **Headers**: add `Authorization` with value `Bearer <your CRON_SECRET>`
     (the exact value from the Vercel env var — anything else gets a 401)
5. Enable **Save responses** so failures are diagnosable, then **Create**.
6. Hit **Test run** once. A healthy response is HTTP 200 with a JSON body like
   `{"ok":true,...}`. HTTP 401 means the header is wrong.

Why hourly for a 4h strategy: decisions are only ever taken on closed 4h
candles, so polling more often cannot change a single trade. It just means a
dropped run heals within an hour instead of costing a full 4h cycle. Polls
that find nothing new update a heartbeat and write no log row.

**Verifying it works**: the dashboard's *Bot status* panel shows *Last
successful run* with an age. If nothing runs for 2.5 hours the page shows a
"Scheduler looks down" banner. That banner is the thing to watch — a bot that
is never triggered looks exactly like a bot that keeps deciding not to trade,
which is precisely the failure this project hit.

In the GitHub repo: **Settings → Secrets and variables → Actions → New
repository secret**:

| Secret | Value |
|---|---|
| `CRON_SECRET` | same value as the Vercel env var |
| `EVALUATE_URL` | `https://<your-app>.vercel.app/api/cron/evaluate` |

Test it once via **Actions → papertrade-evaluate → Run workflow**. A non-200
response fails the run, so scheduler-side failures are visible in the Actions
tab (and data-side failures on the dashboard).

## Operations

- **Halt state**: the risk engine only blocks *new entries* (exits keep
  running). The dashboard shows the halt reason. Manual reset:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_SECRET" https://<your-app>.vercel.app/api/admin/reset-halt
```

  The reset also re-bases the loss streak, daily baseline and equity peak so
  the bot doesn't immediately re-halt on stale numbers.

- **Every decision is logged** to `signals`, including *why no trade happened*
  (no crossover / RSI dead band / wrong regime / halted / warmup), with full
  indicator values and the gate breakdown in `details`. The dashboard shows the
  newest decision in full plus a feed of recent ones.

- **Is it broken, or did the market just not qualify?** The "Latest decision"
  card answers this directly: a red ✗ next to a specific gate means the rules
  were evaluated and one failed. A "scheduler looks down" banner (or a stale
  "Last successful run") means the bot is not being triggered at all.

- **Times**: everything is stored and reasoned about in UTC (candle
  boundaries, cron slots, Binance timestamps); the dashboard *displays*
  Istanbul time. The zone is set once in `CONFIG.display.timeZone` and passed
  explicitly to `Intl`, never read from the runtime's local clock — so the
  server render, the browser and CI all agree. Change that one value to
  re-target the display; nothing else needs touching.

- **Binance geo-blocks**: the client tries `data-api.binance.vision` (Binance's
  market-data mirror) before `api.binance.com`, because the main host returns
  HTTP 451 from some Vercel regions.

## Backtesting variants

```bash
npm run backtest
```

Read-only: no database, no effect on the live bot. What the bot trades is
fixed by [src/config/strategy.ts](src/config/strategy.ts) and changes only
when that file is edited and its version bumped.

```bash
npm run backtest -- --candles 6000 --split 0.6 --variant donchian
```

The harness **reuses the live paper-fill code** (`src/lib/fills.ts`), so
slippage, fees and the stop-before-target rule are literally the same code
path the bot runs; only strategy parameters vary. A test asserts that the
`baseline` variant produces the same entry decision as the engine's
`decideEntry` on every candle — if they ever drift, the suite fails rather
than silently reporting numbers for a strategy the bot does not run.

**Read the HOLDOUT table, not the TRAIN one.** History is split in two;
variants are chosen by looking at the training half, and the holdout half is
the honest estimate. This is not ceremony — in the first run, the
`donchian 20` variant was the *best* performer in training (+$6,814, PF 1.39)
and the *worst* in holdout (−$1,166, PF 0.84). Picking by backtest alone would
have selected exactly the wrong strategy.

Other guards against fooling yourself: keep the variant list short (the runner
prints the count — the more you try, the more the winner is luck), prefer a
parameter *plateau* over a lone spike, and remember that paper trading is the
final out-of-sample test.

Lookahead is guarded structurally: indicators are causal, the daily regime for
a 4h candle uses only daily candles that had already closed, Donchian windows
exclude the current candle, entries fill at the signal candle's close with
exits checked from the next candle, and trailing stops move only after the
candle they derive from has closed. Tests cover each of these.

## Shared-capital backtest

```bash
npm run portfolio
```

Every other backtest here gives each instrument its own $10,000, which makes
capital free and infinite and hides the cost the live bot actually pays: a
position ties up part of ONE account, and while it is open every other
instrument's signals go untaken. This simulator walks a single merged timeline
ordered by bar close — the same order the live engine uses — and enforces the
shared balance.

It changed two decisions that the isolated backtests got wrong:

| Config (holdout) | Trades | Missed | Win% | PF | Net | Avg bars held |
|---|---|---|---|---|---|---|
| 1:4 (v1.2.0) | 46 | 147 | 23.9 | 1.01 | +$50 | 138.6 |
| 1:3 + partial | 69 | 74 | 24.6 | 0.88 | −$733 | 103.6 |
| 1:2 + partial | 92 | 60 | 31.5 | 1.01 | +$48 | 80.0 |
| **1:4 + partial + 60-bar stop** | **131** | 99 | **43.5** | **1.08** | **+$650** | **43.1** |

**Moving the target closer does not work**, even with capital competition
modelled — the freed capital does not pay for the worse per-trade expectancy.
**A time stop does.** The problem was never the target distance; it was trades
that go nowhere holding the account hostage. Tightening the limit further
backfires (42 bars: −$364, 30 bars: −$1,879) — winners need room.

## Per-instrument study

```bash
npm run optimize
```

Read-only. Searches a 45-cell grid (stop multiple × RR × dead-band width) on
each instrument's **training** half, locks the winner in, then judges it on the
**holdout** half against the shared baseline. The question is not "what are the
best parameters for X" — a grid always answers that — but "does per-instrument
tuning survive out of sample?"

Result (2026-08-08, 495 fitted choices):

| | Baseline | Per-instrument tuned |
|---|---|---|
| Mean holdout profit factor | 0.834 | 0.893 |
| Instruments improved out of sample | — | 8 / 11 |
| Total holdout net (each on own $10k) | −$3,980 | −$56 |

8 of 11 looks convincing until you test it: under the null hypothesis, P(≥8 of
11) = 0.11. Not significant. And the tuned portfolio still lost.

**What the grid did find was a shared direction.** It independently chose a
wider stop on 6 of 11 instruments (3.5×ATR rather than 2.5) and a bigger target
on 5 of 11 (1:4 rather than 1:3). Testing that as ONE shared change — no
per-instrument fitting — across all instruments and both halves:

| Shared params | Mean holdout PF | Holdout PF > 1 | Holdout net |
|---|---|---|---|
| 2.5×ATR, 1:3 (current) | 0.834 | 2 / 11 | −$3,980 |
| 3.5×ATR, 1:3 | 0.838 | 5 / 11 | −$2,712 |
| 2.5×ATR, 1:4 | 0.828 | 5 / 11 | −$4,010 |
| **3.5×ATR, 1:4** | **0.869** | 5 / 11 | **+$653** |

On crypto specifically, 3.5×ATR / 1:4 improves in *both* halves for BTC
(1.30→1.65 train, 1.22→1.54 holdout), ETH, SOL and HBAR. Two independent
procedures — a per-instrument grid and a shared-parameter sweep — pointed the
same way, which is stronger evidence than either alone. The plausible mechanism
is that a 2.5×ATR stop sits inside normal noise and gets taken out before the
move develops.

**US equities failed under every configuration tested** — 1h and daily bars,
all four parameter sets. On 1h their *training* profit factors are mostly below
1.0, so it is not even overfitting; the rules simply do not transfer. On daily
bars training looks excellent (NVDA 2.64, META 1.91) and the holdout collapses
(0.57, 0.64) on 8–15 trades.

None of this has been applied to the live bot. Changing it requires editing
`src/config/strategy.ts` and bumping the version.

## Strategy (v1.2.0 — exact rules)

> **v1.2.0** widened the stop from 2.5×ATR to **3.5×ATR** and the target from
> 1:3 to **1:4**, on every instrument. Two independent procedures found it: a
> per-instrument grid picked a wider stop on 6 of 11 instruments, and testing
> it as a single *shared* change turned the holdout total from −$3,980 to
> **+$653**, improving in both halves for BTC, ETH, SOL and HBAR. A wider stop
> does not raise risk — position size is derived from the stop distance, so a
> wider stop simply buys less and ties up less of the shared account. The
> plausible mechanism is that a 2.5×ATR stop sits inside normal noise and is
> taken out before the move develops.

Identical indicators and entry logic on every instrument. Only bar length and
allowed direction vary by venue (see the table at the top).

- Indicators on each instrument's own closes: EMA21, EMA50, EMA200, RSI14
  (Wilder), ATR14 (Wilder).
- Regime: EMA50>EMA200 → longs only; EMA50<EMA200 → shorts only. On a
  long-only venue a bear regime means stand aside, not short.
- Entry LONG: close crosses **above** EMA21 (event, not level) AND RSI14>52 AND
  bull regime AND flat. Entry SHORT: mirrored with RSI14<48 and bear regime.
- Dead band: no trades while 48 ≤ RSI ≤ 52.
- Stop: entry ∓ 3.5×ATR14; target 4× the stop distance (1:4 RR); one position
  per instrument; regime flip force-closes at the next evaluation.
- Size: `qty = (equity × 0.015) / (3.5 × ATR14)` — 1.5% of the **shared**
  account risked per trade, so a volatile instrument automatically takes a
  smaller position than a calm one.
- Time stop: a position is closed after **60 of its own bars**, but **only if
  it is at or above break-even**. ~10 days on crypto 4h, ~3 months on daily
  equities, so in practice it binds crypto, which is where the problem was.
  A losing trade is left to its stop: that exit is already planned and sized
  so the loss costs exactly 1.5%, and closing early on a timer would convert a
  budgeted risk into an unplanned partial loss. The worry that losers would
  accumulate did not survive measurement — holding averaged 44 bars vs 43 and
  deployment 77% vs 78%, because a losing trade reaches its stop anyway.
- Capital: one shared $10,000. A signal that does not fit the free balance is
  taken **smaller** (risk scales down with it, so a half-size trade risks
  0.75%) rather than skipped; below 25% of the intended size it is recorded in
  `missed_opportunities` instead.
- Missed setups are **replayed** each cycle with their recorded
  entry/stop/target and the same exit rules, so the dashboard reports what the
  budget cost — or saved — in dollars rather than as a count.
- Risk engine halts new entries on: daily realized loss ≥4%, 6 consecutive
  losses, or ≥10% drawdown from peak equity. **Note:** these thresholds were
  designed for a single instrument. With eleven trading at once, six
  consecutive losses across the whole account will occur far more often, so
  they are due a review once real halt data exists.

## Project layout

```
src/config/strategy.ts        versioned strategy parameters (the only place they live)
src/lib/indicators.ts         EMA / RSI / ATR / crossover — unit-tested
src/lib/fills.ts              pure paper-fill simulation — unit-tested
src/lib/engine.ts             evaluation state machine (exits → risk → entry → log)
src/lib/binance.ts            public klines client with host fallback
src/lib/schema.sql            Postgres schema (idempotent)
src/app/page.tsx              public dashboard (server-rendered)
src/components/EvaluationDetail.tsx  per-evaluation gate checklist ("why no trade")
src/components/PriceChart.tsx        4h candles + EMA21/50/200 + RSI panel (hand-rolled SVG)
src/app/api/cron/evaluate     scheduler endpoint (Bearer CRON_SECRET)
src/app/api/admin/reset-halt  manual halt reset (Bearer ADMIN_SECRET)
scripts/seed.ts               backfill CONFIG.fetchLimit candles + init flat state
scripts/backtest.ts           variant comparison with train/holdout split (read-only)
src/backtest/                 simulator, variants, history loading — shares src/lib/fills.ts
.github/workflows/trigger.yml 4h scheduler
tests/                        indicator + fill-simulation + entry-gate tests
```

## Disclaimer

**PAPER TRADING ONLY.** Simulated fills on live market data, for education and
strategy validation. Nothing here is financial advice, and this repository
contains no code capable of placing real orders.
