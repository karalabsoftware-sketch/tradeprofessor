-- PaperTrade BTC schema. Idempotent: safe to run repeatedly.

CREATE TABLE IF NOT EXISTS candles (
  symbol      text        NOT NULL,
  open_time   bigint      NOT NULL,
  open        double precision NOT NULL,
  high        double precision NOT NULL,
  low         double precision NOT NULL,
  close       double precision NOT NULL,
  volume      double precision NOT NULL,
  close_time  bigint      NOT NULL,
  PRIMARY KEY (symbol, open_time)
);

CREATE TABLE IF NOT EXISTS signals (
  id               bigserial PRIMARY KEY,
  created_at       timestamptz NOT NULL DEFAULT now(),
  symbol           text        NOT NULL,
  candle_time      bigint,
  action           text        NOT NULL, -- entry_long | entry_short | exit | none | skip | error | halt
  reason           text        NOT NULL,
  details          jsonb,
  strategy_version text        NOT NULL
);

CREATE TABLE IF NOT EXISTS trades (
  id               bigserial PRIMARY KEY,
  symbol           text        NOT NULL,
  side             text        NOT NULL, -- long | short
  status           text        NOT NULL, -- open | closed
  strategy_version text        NOT NULL,
  entry_time       timestamptz NOT NULL,
  entry_candle     bigint      NOT NULL,
  entry_price      double precision NOT NULL,
  qty              double precision NOT NULL,
  stop_price       double precision NOT NULL,
  target_price     double precision NOT NULL,
  atr_at_entry     double precision NOT NULL,
  entry_fee        double precision NOT NULL,
  exit_time        timestamptz,
  exit_candle      bigint,
  exit_price       double precision,
  exit_reason      text, -- stop | target | regime-flip
  exit_fee         double precision,
  pnl              double precision, -- net of entry + exit fees
  pnl_pct          double precision  -- net pnl / entry notional * 100
);

CREATE TABLE IF NOT EXISTS equity_snapshots (
  id          bigserial PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  candle_time bigint      NOT NULL,
  equity      double precision NOT NULL, -- realized + unrealized (mark-to-market)
  realized    double precision NOT NULL,
  open_pnl    double precision NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_state (
  id                 int PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- singleton row
  equity             double precision NOT NULL, -- realized equity (cash)
  peak_equity        double precision NOT NULL,
  day_start_equity   double precision NOT NULL,
  day_start_date     text,
  consecutive_losses int         NOT NULL DEFAULT 0,
  halted             boolean     NOT NULL DEFAULT false,
  halt_reason        text,
  last_eval_at       timestamptz,
  last_candle_time   bigint,
  last_error         text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signals_created ON signals (id DESC);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades (status);
CREATE INDEX IF NOT EXISTS idx_snapshots_candle ON equity_snapshots (candle_time);
