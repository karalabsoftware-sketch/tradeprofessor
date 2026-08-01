# PaperTrade BTC

A **paper-trading** bot for a 4h BTCUSDT trend strategy, with a public read-only
dashboard. Runs entirely on free tiers: Vercel Hobby + Neon/Supabase Postgres +
GitHub Actions as the scheduler. **No real orders, no exchange keys, no live
trading code paths.** Educational project — not financial advice.

Paper trading is the out-of-sample validation phase: the target is **90 days or
30+ closed trades** of clean data before any live discussion.

## How it works

```
GitHub Actions (cron: 5 */4 * * *)
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
  (`btc-4h-trend-v1.0.0`). Every trade and signal stores the version; results
  from different versions are never mixed. Changing any parameter requires a
  version bump.
- **Idempotent**: decisions key off the last *closed* candle's open time, so
  scheduler retries and a few minutes of GitHub cron drift are no-ops.
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

### 5. Scheduler (GitHub Actions)

[.github/workflows/trigger.yml](.github/workflows/trigger.yml) calls the
endpoint at 00:05, 04:05, 08:05 … UTC (:05 past the boundary so the candle is
closed; drift is harmless — see idempotency above).

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
  indicator values in `details`. The last 10 appear on the dashboard.

- **Binance geo-blocks**: the client tries `data-api.binance.vision` (Binance's
  market-data mirror) before `api.binance.com`, because the main host returns
  HTTP 451 from some Vercel regions.

## Strategy (v1.0.0 — exact rules)

- BTCUSDT 4h (ETH/SOL implemented, disabled by config flag). Indicators on 4h
  closes: EMA21, EMA50, EMA200, RSI14 (Wilder), ATR14 (Wilder).
- Regime: EMA50>EMA200 → longs only; EMA50<EMA200 → shorts only.
- Entry LONG: close crosses **above** EMA21 (event, not level) AND RSI14>52 AND
  bull regime AND flat. Entry SHORT: mirrored with RSI14<48 and bear regime.
- Dead band: no trades while 48 ≤ RSI ≤ 52.
- Stop: entry ∓ 2.5×ATR14; target 3× the stop distance (1:3 RR); max 1 open
  position; regime flip force-closes at the next evaluation.
- Size: `qty = (equity × 0.015) / (2.5 × ATR14)` — 1.5% risk per trade. Note:
  in very low-volatility regimes this formula can imply notional > equity
  (paper leverage); it is applied exactly as specified.
- Risk engine halts new entries on: daily realized loss ≥4%, 6 consecutive
  losses, or ≥10% drawdown from peak equity.

## Project layout

```
src/config/strategy.ts        versioned strategy parameters (the only place they live)
src/lib/indicators.ts         EMA / RSI / ATR / crossover — unit-tested
src/lib/fills.ts              pure paper-fill simulation — unit-tested
src/lib/engine.ts             evaluation state machine (exits → risk → entry → log)
src/lib/binance.ts            public klines client with host fallback
src/lib/schema.sql            Postgres schema (idempotent)
src/app/page.tsx              public dashboard (server-rendered)
src/app/api/cron/evaluate     scheduler endpoint (Bearer CRON_SECRET)
src/app/api/admin/reset-halt  manual halt reset (Bearer ADMIN_SECRET)
scripts/seed.ts               backfill 400 candles + init flat state
.github/workflows/trigger.yml 4h scheduler
tests/                        indicator + fill-simulation + entry-gate tests
```

## Disclaimer

**PAPER TRADING ONLY.** Simulated fills on live market data, for education and
strategy validation. Nothing here is financial advice, and this repository
contains no code capable of placing real orders.
