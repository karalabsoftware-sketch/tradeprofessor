import { CONFIG, STRATEGY_VERSION } from "@/config/strategy";
import { db } from "@/lib/db";
import {
  computeMetrics,
  formatAge,
  nextCandleClose,
  nextPoll,
  schedulerHealth,
} from "@/lib/metrics";
import EquityChart from "@/components/EquityChart";
import EvaluationDetail, { EvalDetails } from "@/components/EvaluationDetail";
import { fmtDateTime, tzLabel } from "@/lib/format";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Dashboard() {
  let data: Awaited<ReturnType<typeof loadDashboard>>;
  try {
    data = await loadDashboard();
  } catch (err) {
    return (
      <main className="wrap">
        <Header />
        <div className="error-banner">
          Dashboard is not ready yet: {err instanceof Error ? err.message : String(err)}. Run the
          seed script and check DATABASE_URL.
        </div>
      </main>
    );
  }

  const { state, openTrade, trades, snapshots, signals, lastPrice } = data;

  if (!state) {
    return (
      <main className="wrap">
        <Header />
        <div className="error-banner">Bot not initialized — run <code>npm run seed</code> to backfill candles and create the initial state.</div>
      </main>
    );
  }

  const equitySeries = snapshots.map((s) => s.equity);
  const metrics = computeMetrics(trades, equitySeries);
  const markEquity = snapshots.length > 0 ? snapshots[snapshots.length - 1].equity : state.equity;
  const totalReturn = ((markEquity - CONFIG.account.startingEquity) / CONFIG.account.startingEquity) * 100;

  const now = Date.now();
  const health = schedulerHealth(state.last_eval_at, now, CONFIG.schedule.stalenessMs);
  const nextCheck = nextPoll(now, CONFIG.schedule.pollMinute);
  const nextDecision = nextCandleClose(now, CONFIG.intervalMs);
  const latest = signals.find((s) => s.action !== "skip") ?? null;

  return (
    <main className="wrap">
      <Header />

      {health.stale && (
        <div className="error-banner">
          🕓 <strong>Scheduler looks down.</strong>{" "}
          {health.ageMs === null
            ? "The bot has never completed an evaluation."
            : `No successful run for ${formatAge(health.ageMs)} (expected roughly hourly).`}{" "}
          Stops and targets are still replayed across every missed candle, but an
          entry signal on a candle that was skipped over is not backfilled — check
          the GitHub Actions tab.
        </div>
      )}
      {state.halted && (
        <div className="halt-banner">
          ⛔ <strong>Risk engine halt:</strong> new entries are blocked — {state.halt_reason}. Open
          positions still get managed. Reset requires the admin secret.
        </div>
      )}
      {state.last_error && (
        <div className="error-banner">
          ⚠ Last evaluation problem: {state.last_error} (cycle skipped — no fills were fabricated)
        </div>
      )}

      <div className="grid">
        {/* ---- Header stats ---- */}
        <section className="card span-4">
          <h2>Equity (mark-to-market)</h2>
          <div className="hero-number">{usd(markEquity)}</div>
          <div className="hero-sub">
            realized {usd(state.equity)} · started {usd(CONFIG.account.startingEquity)}
          </div>
        </section>

        <section className="card span-4">
          <h2>Total return</h2>
          <div className={`hero-number ${totalReturn >= 0 ? "pos" : "neg"}`}>{signPct(totalReturn)}</div>
          <div className="hero-sub">since inception · fees included</div>
        </section>

        <section className="card span-4">
          <h2>Open position</h2>
          {openTrade ? (
            <OpenPositionCard trade={openTrade} lastPrice={lastPrice} />
          ) : (
            <>
              <div className="hero-number muted">Flat</div>
              <div className="hero-sub">no open position</div>
            </>
          )}
        </section>

        {/* ---- Why the last evaluation did (or didn't) trade ---- */}
        <section className="card span-12">
          <h2>Latest decision — why the bot did or didn&apos;t trade</h2>
          {latest ? (
            <EvaluationDetail
              candleTime={latest.candle_time}
              action={latest.action}
              reason={latest.reason}
              details={latest.details}
            />
          ) : (
            <p className="muted" style={{ fontSize: 13 }}>
              No evaluation recorded yet.
            </p>
          )}
        </section>

        {/* ---- Equity curve ---- */}
        <section className="card span-12">
          <h2>Equity curve — one point per evaluation (USD)</h2>
          <EquityChart
            points={snapshots.map((s) => ({ t: s.candle_time, equity: s.equity }))}
            baseline={CONFIG.account.startingEquity}
          />
        </section>

        {/* ---- Metrics ---- */}
        <section className="card span-6">
          <h2>Performance metrics</h2>
          <div className="stat-row"><span className="k">Closed trades</span><span className="num">{metrics.totalTrades}</span></div>
          <div className="stat-row"><span className="k">Win rate</span><span className="num">{metrics.winRatePct === null ? "—" : `${metrics.winRatePct.toFixed(1)}% (${metrics.wins}W / ${metrics.losses}L)`}</span></div>
          <div className="stat-row"><span className="k">Profit factor</span><span className="num">{metrics.profitFactor === null ? "—" : metrics.profitFactor === Infinity ? "∞ (no losses yet)" : metrics.profitFactor.toFixed(2)}</span></div>
          <div className="stat-row"><span className="k">Max drawdown</span><span className="num">{metrics.maxDrawdownPct.toFixed(2)}%</span></div>
          <div className="stat-row"><span className="k">Avg trade</span><span className={`num ${metrics.avgTrade >= 0 ? "pos" : "neg"}`}>{metrics.totalTrades ? signUsd(metrics.avgTrade) : "—"}</span></div>
          <div className="stat-row"><span className="k">Total fees paid</span><span className="num">{usd(metrics.totalFees)}</span></div>
          <div className="stat-row"><span className="k">Current streak</span><span className="num">{streakLabel(metrics.currentStreak)}</span></div>
        </section>

        {/* ---- Bot status ---- */}
        <section className="card span-6">
          <h2>Bot status</h2>
          <div className="stat-row">
            <span className="k">State</span>
            <span>
              <span
                className="status-dot"
                style={{
                  background: state.halted ? "var(--bad)" : health.stale ? "var(--warn)" : "var(--good)",
                }}
              />
              {state.halted ? `HALTED — ${state.halt_reason}` : health.stale ? "scheduler down" : "active"}
            </span>
          </div>
          <div className="stat-row">
            <span className="k">Last successful run</span>
            <span className="num">
              {state.last_eval_at ? `${ts(state.last_eval_at)} (${formatAge(health.ageMs ?? 0)} ago)` : "never"}
            </span>
          </div>
          <div className="stat-row"><span className="k">Last candle evaluated</span><span className="num">{state.last_candle_time ? ts(new Date(state.last_candle_time)) : "—"}</span></div>
          <div className="stat-row"><span className="k">Next check</span><span className="num">{ts(nextCheck)}</span></div>
          <div className="stat-row"><span className="k">Next possible decision</span><span className="num">{ts(nextDecision)} (4h close)</span></div>
          <div className="stat-row"><span className="k">Consecutive losses</span><span className="num">{state.consecutive_losses} / {CONFIG.risk.maxConsecutiveLosses}</span></div>
          <div className="stat-row"><span className="k">Strategy version</span><span className="num">{STRATEGY_VERSION}</span></div>
          <div className="stat-row"><span className="k">Symbols</span><span className="num">{CONFIG.symbols.map((s) => `${s.symbol}${s.enabled ? "" : " (off)"}`).join(" · ")}</span></div>
        </section>

        {/* ---- Trade log ---- */}
        <section className="card span-12">
          <h2>Trade log — every trade, nothing hidden</h2>
          {trades.length === 0 && !openTrade ? (
            <p className="muted" style={{ fontSize: 13 }}>No trades yet. The bot only enters on an EMA21 crossover event that passes every filter.</p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Entry time</th><th>Side</th><th>Entry</th><th>Exit</th><th>Qty</th>
                    <th>Fees</th><th>P/L $</th><th>P/L %</th><th>Exit reason</th><th>Version</th>
                  </tr>
                </thead>
                <tbody>
                  {openTrade && (
                    <tr>
                      <td className="num">{ts(openTrade.entry_time)}</td>
                      <td><SideBadge side={openTrade.side} /></td>
                      <td className="num">{px(openTrade.entry_price)}</td>
                      <td className="num muted">open</td>
                      <td className="num">{openTrade.qty.toFixed(5)}</td>
                      <td className="num">{usd(openTrade.entry_fee)}</td>
                      <td className="num muted" colSpan={2}>unrealized {signUsd(openTradePnl(openTrade, lastPrice))}</td>
                      <td className="muted">—</td>
                      <td className="num muted">{openTrade.strategy_version}</td>
                    </tr>
                  )}
                  {trades.map((t) => (
                    <tr key={t.id}>
                      <td className="num">{ts(t.entry_time)}</td>
                      <td><SideBadge side={t.side} /></td>
                      <td className="num">{px(t.entry_price)}</td>
                      <td className="num">{px(t.exit_price)}</td>
                      <td className="num">{t.qty.toFixed(5)}</td>
                      <td className="num">{usd(t.entry_fee + t.exit_fee)}</td>
                      <td className={`num ${t.pnl >= 0 ? "pos" : "neg"}`}>{signUsd(t.pnl)}</td>
                      <td className={`num ${t.pnl >= 0 ? "pos" : "neg"}`}>{signPct(t.pnl_pct)}</td>
                      <td>{t.exit_reason}</td>
                      <td className="num muted">{t.strategy_version}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ---- Recent evaluations ---- */}
        <section className="card span-12">
          <h2>Recent evaluations — every decision logged, including why NOT to trade</h2>
          <ul className="signal-list">
            {signals.length === 0 && <li className="muted">No evaluations yet.</li>}
            {signals.map((s) => (
              <li key={s.id}>
                <span className="signal-time">{ts(s.created_at)}</span>
                <span className="signal-action" style={{ color: actionColor(s.action) }}>{s.action}</span>
                <span className="muted">{s.reason}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* ---- Strategy card ---- */}
        <section className="card span-12">
          <h2>Strategy — exact rules ({STRATEGY_VERSION})</h2>
          <ul className="rules">
            <li>Symbol: <code>BTCUSDT</code> on <code>4h</code> candles (ETH/SOL implemented but disabled by config).</li>
            <li>Indicators on 4h closes: <code>EMA21</code>, <code>EMA50</code>, <code>EMA200</code>, <code>RSI14</code>, <code>ATR14</code>.</li>
            <li>Regime filter: <code>EMA50 &gt; EMA200</code> → longs only; <code>EMA50 &lt; EMA200</code> → shorts only.</li>
            <li>Entry LONG: close crosses <em>above</em> EMA21 (crossover event) AND <code>RSI14 &gt; 52</code> AND bull regime AND no open position.</li>
            <li>Entry SHORT: close crosses <em>below</em> EMA21 AND <code>RSI14 &lt; 48</code> AND bear regime AND no open position.</li>
            <li>Dead band: no trades while <code>48 ≤ RSI ≤ 52</code>.</li>
            <li>Stop: entry ∓ <code>2.5 × ATR14</code>. Target: 3× the stop distance (1:3 RR). Max 1 open position.</li>
            <li>Emergency exit: regime flips while a position is open → closed at the next evaluation.</li>
            <li>Sizing: <code>qty = (equity × 0.015) / (2.5 × ATR14)</code> — 1.5% risk per trade.</li>
            <li>Paper fills: entry at candle close + 0.05% slippage against direction; if a candle touches both stop and target, the stop is assumed to hit first (worst case); 0.1% fee per fill.</li>
            <li>Risk engine: entries halt on daily loss ≥ 4%, 6 consecutive losses, or ≥ 10% drawdown from peak.</li>
          </ul>
          <div className="disclaimer">
            ⚠ PAPER TRADING — simulated fills on live market data. Educational project, not
            financial advice. No real orders are placed and no exchange keys exist.
          </div>
        </section>
      </div>

      <footer>
        Data: Binance public REST · scheduler checks hourly, decisions only on closed 4h candles · all
        times shown in Istanbul time ({tzLabel()}); candles and logs are stored in UTC
      </footer>
    </main>
  );
}

/* ---------------- data loading ---------------- */

interface StateRow {
  equity: number;
  consecutive_losses: number;
  halted: boolean;
  halt_reason: string | null;
  last_eval_at: Date | null;
  last_candle_time: number | null;
  last_error: string | null;
}

interface TradeRow {
  id: number;
  side: "long" | "short";
  entry_time: Date;
  entry_price: number;
  exit_price: number;
  qty: number;
  entry_fee: number;
  exit_fee: number;
  pnl: number;
  pnl_pct: number;
  exit_reason: string;
  strategy_version: string;
}

interface OpenTradeRow {
  side: "long" | "short";
  entry_time: Date;
  entry_price: number;
  qty: number;
  stop_price: number;
  target_price: number;
  entry_fee: number;
  strategy_version: string;
}

async function loadDashboard() {
  const sql = db();
  const [stateRows, openRows, tradeRows, snapRows, signalRows] = await Promise.all([
    sql`SELECT * FROM bot_state WHERE id = 1`,
    sql`SELECT * FROM trades WHERE status = 'open' ORDER BY id LIMIT 1`,
    sql`SELECT * FROM trades WHERE status = 'closed' ORDER BY exit_candle DESC, id DESC LIMIT 300`,
    sql`SELECT candle_time, equity FROM equity_snapshots ORDER BY id ASC LIMIT 2000`,
    sql`SELECT id, created_at, candle_time, action, reason, details FROM signals ORDER BY id DESC LIMIT 12`,
  ]);

  const state: StateRow | null = stateRows.length
    ? {
        equity: Number(stateRows[0].equity),
        consecutive_losses: Number(stateRows[0].consecutive_losses),
        halted: Boolean(stateRows[0].halted),
        halt_reason: stateRows[0].halt_reason,
        last_eval_at: stateRows[0].last_eval_at,
        last_candle_time:
          stateRows[0].last_candle_time === null ? null : Number(stateRows[0].last_candle_time),
        last_error: stateRows[0].last_error,
      }
    : null;

  const openTrade: OpenTradeRow | null = openRows.length
    ? {
        side: openRows[0].side,
        entry_time: openRows[0].entry_time,
        entry_price: Number(openRows[0].entry_price),
        qty: Number(openRows[0].qty),
        stop_price: Number(openRows[0].stop_price),
        target_price: Number(openRows[0].target_price),
        entry_fee: Number(openRows[0].entry_fee),
        strategy_version: openRows[0].strategy_version,
      }
    : null;

  const trades: TradeRow[] = tradeRows.map((r) => ({
    id: Number(r.id),
    side: r.side,
    entry_time: r.entry_time,
    entry_price: Number(r.entry_price),
    exit_price: Number(r.exit_price),
    qty: Number(r.qty),
    entry_fee: Number(r.entry_fee),
    exit_fee: Number(r.exit_fee),
    pnl: Number(r.pnl),
    pnl_pct: Number(r.pnl_pct),
    exit_reason: String(r.exit_reason),
    strategy_version: r.strategy_version,
  }));

  const snapshots = snapRows.map((r) => ({
    candle_time: Number(r.candle_time),
    equity: Number(r.equity),
  }));

  const signals = signalRows.map((r) => ({
    id: Number(r.id),
    created_at: r.created_at as Date,
    candle_time: r.candle_time === null ? null : Number(r.candle_time),
    action: String(r.action),
    reason: String(r.reason),
    details: (r.details ?? null) as EvalDetails | null,
  }));

  let lastPrice: number | null = null;
  if (openTrade) {
    const priceRows = await sql`
      SELECT close FROM candles WHERE symbol = ${CONFIG.symbols[0].symbol}
      ORDER BY open_time DESC LIMIT 1
    `;
    if (priceRows.length) lastPrice = Number(priceRows[0].close);
  }

  return { state, openTrade, trades, snapshots, signals, lastPrice };
}

/* ---------------- presentation helpers ---------------- */

function Header() {
  return (
    <div className="topbar">
      <h1>
        PaperTrade BTC
        <span className="paper-badge">Paper trading</span>
      </h1>
      <span className="muted" style={{ fontSize: 13 }}>
        BTCUSDT · 4h · public &amp; read-only · times in {tzLabel()}
      </span>
    </div>
  );
}

function OpenPositionCard({ trade, lastPrice }: { trade: OpenTradeRow; lastPrice: number | null }) {
  const pnl = openTradePnl(trade, lastPrice);
  return (
    <>
      <div className="hero-number" style={{ fontSize: 22 }}>
        <SideBadge side={trade.side} /> @ {px(trade.entry_price)}
      </div>
      <div className="hero-sub">
        P/L <span className={pnl >= 0 ? "pos" : "neg"}>{signUsd(pnl)}</span> · stop {px(trade.stop_price)} · target {px(trade.target_price)}
      </div>
    </>
  );
}

function SideBadge({ side }: { side: "long" | "short" }) {
  return <span className={`side-badge side-${side}`}>{side}</span>;
}

function openTradePnl(t: OpenTradeRow, lastPrice: number | null): number {
  if (lastPrice === null) return 0;
  const dir = t.side === "long" ? 1 : -1;
  return dir * (lastPrice - t.entry_price) * t.qty;
}

function actionColor(action: string): string {
  if (action.startsWith("entry")) return "var(--accent)";
  if (action === "exit") return "var(--ink)";
  if (action === "error" || action === "halt") return "var(--bad)";
  return "var(--ink-3)";
}

function usd(v: number): string {
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signUsd(v: number): string {
  return `${v >= 0 ? "+" : "−"}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signPct(v: number): string {
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}%`;
}

function px(v: number): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function streakLabel(streak: number): string {
  if (streak === 0) return "—";
  return streak > 0 ? `${streak} win${streak > 1 ? "s" : ""}` : `${-streak} loss${streak < -1 ? "es" : ""}`;
}

function ts(d: Date): string {
  return fmtDateTime(d);
}
