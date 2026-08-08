-- Multi-instrument schema (v1.1.0). Idempotent: safe to run repeatedly.
--
-- Capital model: ONE shared account, not one per instrument. Every open
-- position ties up its entry notional, so a signal can be correct and still
-- go untaken because the money is already working elsewhere. Those refusals
-- are recorded in `missed_opportunities` — they are data, not errors.

-- Shared account. Exactly one row.
CREATE TABLE IF NOT EXISTS account_state (
  id                 int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- Cash realised so far: starting capital +/- closed P/L, net of all fees.
  -- Open positions are NOT marked into this; the dashboard adds unrealised.
  realized_equity    double precision NOT NULL,
  peak_equity        double precision NOT NULL,
  day_start_equity   double precision NOT NULL,
  day_start_date     text,
  consecutive_losses int         NOT NULL DEFAULT 0,
  halted             boolean     NOT NULL DEFAULT false,
  halt_reason        text,
  last_eval_at       timestamptz,
  last_error         text,
  strategy_version   text        NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Idempotency is per instrument now: each one advances through its own bars.
CREATE TABLE IF NOT EXISTS instrument_state (
  instrument_id    text PRIMARY KEY,
  last_candle_time bigint,
  last_eval_at     timestamptz,
  last_error       text,
  warming_up       boolean     NOT NULL DEFAULT true,
  candles_seen     int         NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Which bar length the stored candles and last_candle_time belong to.
-- Changing a venue's timeframe invalidates both: daily bars carry different
-- open times than hourly ones, so a stale marker would make the engine think
-- every new bar had already been evaluated, and mixing the two in `candles`
-- would corrupt every indicator drawn from the table. The seed detects a
-- mismatch here and rebuilds that instrument.
ALTER TABLE instrument_state ADD COLUMN IF NOT EXISTS interval text;

-- Existing trades/signals/candles tables gain an instrument dimension.
ALTER TABLE trades  ADD COLUMN IF NOT EXISTS instrument_id text;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS instrument_id text;
ALTER TABLE trades  ADD COLUMN IF NOT EXISTS notional double precision;

-- Backfill the single-instrument era so old rows stay queryable.
UPDATE trades  SET instrument_id = symbol WHERE instrument_id IS NULL;
UPDATE signals SET instrument_id = symbol WHERE instrument_id IS NULL AND symbol <> '*';

-- Signals a correct setup produced but the account could not fund.
-- The point of the whole exercise: how often does a fixed budget cost us?
CREATE TABLE IF NOT EXISTS missed_opportunities (
  id                bigserial PRIMARY KEY,
  created_at        timestamptz NOT NULL DEFAULT now(),
  instrument_id     text        NOT NULL,
  candle_time       bigint      NOT NULL,
  side              text        NOT NULL,
  reason            text        NOT NULL, -- insufficient_capital | halted | max_positions
  wanted_notional   double precision NOT NULL,
  available_capital double precision NOT NULL,
  entry_price       double precision NOT NULL,
  stop_price        double precision NOT NULL,
  target_price      double precision NOT NULL,
  qty               double precision NOT NULL,
  strategy_version  text        NOT NULL,
  -- Filled in later by the replay script, once the outcome is knowable.
  hypothetical_pnl  double precision,
  hypothetical_exit text
);

-- Account-level equity curve gains capital-usage columns.
ALTER TABLE equity_snapshots ADD COLUMN IF NOT EXISTS deployed  double precision;
ALTER TABLE equity_snapshots ADD COLUMN IF NOT EXISTS available double precision;
ALTER TABLE equity_snapshots ADD COLUMN IF NOT EXISTS open_positions int;
-- The capital model changed in v1.1.0 (per-instrument accounts -> one shared
-- account), so curves from different versions describe different things and
-- must not be drawn on the same axis.
ALTER TABLE equity_snapshots ADD COLUMN IF NOT EXISTS strategy_version text;

CREATE INDEX IF NOT EXISTS idx_trades_instrument ON trades (instrument_id, status);
CREATE INDEX IF NOT EXISTS idx_signals_instrument ON signals (instrument_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_missed_instrument ON missed_opportunities (instrument_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_candles_symbol_time ON candles (symbol, open_time DESC);
