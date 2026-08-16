import Link from "next/link";
import { CONFIG, STRATEGY_VERSION } from "@/config/strategy";
import {
  instrumentById,
  instrumentsByVenue,
  enabledInstruments,
  intervalOf,
  intervalMsOf,
  Venue,
  VENUE_LABELS,
} from "@/config/instruments";
import { VENUE_RULES } from "@/config/strategy";
import { db } from "@/lib/db";
import { computeMetrics, formatAge, nextPoll, schedulerHealth } from "@/lib/metrics";
import { fmtDateTime, tzLabel } from "@/lib/format";
import { ema, rsi } from "@/lib/indicators";
import EquityChart from "@/components/EquityChart";
import EvaluationDetail, { EvalDetails } from "@/components/EvaluationDetail";
import PriceChart, { PricePoint, TradeMarker } from "@/components/PriceChart";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const CHART_CANDLES = 120;
const VENUES: Venue[] = ["crypto", "us-equity"];

export default async function Dashboard({
  searchParams,
}: {
  searchParams: { i?: string };
}) {
  const selected = (searchParams.i && instrumentById(searchParams.i)?.enabled ? searchParams.i : "BTCUSDT") as string;
  const inst = instrumentById(selected);

  let data: Awaited<ReturnType<typeof load>>;
  try {
    data = await load(selected);
  } catch (err) {
    return (
      <main className="wrap">
        <Header />
        <div className="error-banner">
          Dashboard is not ready yet: {err instanceof Error ? err.message : String(err)}. Run{" "}
          <code>npm run seed</code> and check DATABASE_URL.
        </div>
      </main>
    );
  }

  const { account, states, openPositions, trades, snapshots, signals, priceSeries, missed } = data;

  if (!account || !inst) {
    return (
      <main className="wrap">
        <Header />
        <div className="error-banner">
          Bot not initialized — run <code>npm run seed</code>.
        </div>
      </main>
    );
  }

  const now = Date.now();
  const health = schedulerHealth(account.last_eval_at, now, CONFIG.schedule.stalenessMs);
  const nextCheck = nextPoll(now, CONFIG.schedule.pollMinute);

  const deployed = openPositions.reduce((s, p) => s + p.notional, 0);
  const unrealized = openPositions.reduce((s, p) => s + p.unrealized, 0);
  const equity = account.realized_equity + unrealized;
  const available = account.realized_equity - deployed;
  const totalReturn = ((equity - CONFIG.account.startingEquity) / CONFIG.account.startingEquity) * 100;

  const metrics = computeMetrics(trades, snapshots.map((s) => s.equity));
  const missedResolved = missed.filter((m) => m.hypothetical_pnl !== null);
  // Positive = the skipped trades would have profited, so the budget cost us.
  const missedNet = missedResolved.reduce((s, m) => s + (m.hypothetical_pnl as number), 0);
  const missedWins = missedResolved.filter((m) => (m.hypothetical_pnl as number) >= 0).length;
  const state = states.get(selected);
  const instTrades = trades.filter((t) => t.instrument_id === selected);
  const instOpen = openPositions.filter((p) => p.instrument_id === selected);
  const latest = signals.find((s) => s.action !== "skip") ?? null;

  const markers: TradeMarker[] = [];
  for (const t of instTrades) {
    markers.push({ t: t.entry_candle, kind: "entry", side: t.side, price: t.entry_price });
    if (t.exit_candle !== null) markers.push({ t: t.exit_candle, kind: "exit", side: t.side, price: t.exit_price });
  }
  for (const p of instOpen) {
    markers.push({ t: p.entry_candle, kind: "entry", side: p.side, price: p.entry_price });
  }

  return (
    <main className="wrap">
      <Header />

      {health.stale && (
        <div className="error-banner">
          🕓 <strong>Scheduler looks down.</strong>{" "}
          {health.ageMs === null
            ? "The bot has never completed an evaluation."
            : `No successful run for ${formatAge(health.ageMs)} (expected roughly hourly).`}{" "}
          Check the scheduler&apos;s execution history.
        </div>
      )}
      {account.halted && (
        <div className="halt-banner">
          ⛔ <strong>Risk engine halt:</strong> new entries are blocked across every instrument —{" "}
          {account.halt_reason}. Open positions are still managed.
        </div>
      )}

      {/* ---------- shared account ---------- */}
      <section className="account-bar">
        <AccountStat label="Equity" value={usd(equity)} sub={`started ${usd(CONFIG.account.startingEquity)}`} />
        <AccountStat
          label="Total return"
          value={signPct(totalReturn)}
          tone={totalReturn >= 0 ? "pos" : "neg"}
          sub="fees included"
        />
        <AccountStat
          label="Deployed"
          value={usd(deployed)}
          sub={`${openPositions.length} open position${openPositions.length === 1 ? "" : "s"}`}
        />
        <AccountStat
          label="Available"
          value={usd(available)}
          tone={available <= 0 ? "neg" : undefined}
          sub={available <= 0 ? "fully invested — new signals will be missed" : "free to deploy"}
        />
      </section>
      <div className="capital-bar" title={`${((deployed / Math.max(equity, 1)) * 100).toFixed(0)}% deployed`}>
        <div
          className="capital-bar-fill"
          style={{ width: `${Math.min(100, (deployed / Math.max(equity, 1)) * 100)}%` }}
        />
      </div>
      <p className="capital-note">
        One shared account of {usd(CONFIG.account.startingEquity)} across all {enabledInstruments().length}{" "}
        instruments — exactly as it would be in real life. When it is fully deployed, a valid signal is
        recorded as a missed opportunity instead of being taken.
      </p>

      {/* ---------- instrument navigation ---------- */}
      <nav className="venue-nav">
        {VENUES.map((venue) => (
          <div key={venue} className="venue-group">
            <div className="venue-title">{VENUE_LABELS[venue]}</div>
            <div className="chip-row">
              {instrumentsByVenue(venue).map((it) => {
                const st = states.get(it.id);
                const hasPos = openPositions.some((p) => p.instrument_id === it.id);
                return (
                  <Link
                    key={it.id}
                    href={`/?i=${it.id}`}
                    className={`chip ${it.id === selected ? "chip-active" : ""} ${st?.warming_up ? "chip-warming" : ""}`}
                    scroll={false}
                  >
                    <span className="chip-id">{it.id.replace("USDT", "")}</span>
                    <span className="chip-label">{it.label}</span>
                    {hasPos && <span className="chip-dot" title="open position" />}
                    {st?.warming_up && <span className="chip-warm">warming up</span>}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="grid">
        {/* ---------- selected instrument ---------- */}
        <section className="card span-12">
          <div className="inst-head">
            <div>
              <h2 style={{ marginBottom: 2 }}>{VENUE_LABELS[inst.venue]}</h2>
              <div className="inst-title">
                {inst.label}{" "}
                <span className="muted">
                  · {inst.id} · {intervalOf(inst)} bars ·{" "}
                  {VENUE_RULES[inst.venue].allowShort ? "long + short" : "long only"}
                </span>
              </div>
            </div>
            <div className="inst-pos">
              {instOpen.length > 0 ? (
                instOpen.map((p) => (
                  <div key={p.id}>
                    <SideBadge side={p.side} /> @ {px(p.entry_price, inst.id)}{" "}
                    <span className={p.unrealized >= 0 ? "pos" : "neg"}>{signUsd(p.unrealized)}</span>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {usd(p.notional)} deployed · stop {px(p.stop_price, inst.id)} · target {px(p.target_price, inst.id)}
                    </div>
                  </div>
                ))
              ) : (
                <span className="muted">Flat</span>
              )}
            </div>
          </div>
          {inst.note && state?.warming_up && (
            <div className="warm-note">
              ⏳ {inst.note} — {state.candles_seen}/{CONFIG.minCandles} bars collected. The engine will not
              trade it until EMA200 is trustworthy.
            </div>
          )}
        </section>

        {!state?.warming_up && (
          <>
            <section className="card span-12">
              <h2>Latest decision — why the bot did or didn&apos;t trade</h2>
              {latest ? (
                <EvaluationDetail
                  candleTime={latest.candle_time}
                  action={latest.action}
                  reason={latest.reason}
                  details={latest.details}
                  evaluatedAt={latest.created_at}
                  stale={health.stale}
                  intervalMs={intervalMsOf(inst)}
                  intervalLabel={intervalOf(inst)}
                />
              ) : (
                <p className="muted" style={{ fontSize: 13 }}>No evaluation recorded yet for {inst.id}.</p>
              )}
            </section>

            <section className="card span-12">
              <h2>{inst.label} {intervalOf(inst)} — the same indicators the bot decides on</h2>
              <PriceChart
                points={priceSeries.slice(-CHART_CANDLES)}
                markers={markers}
                latestDecisionT={latest?.candle_time ?? null}
                title={`${inst.id} ${intervalOf(inst)}`}
              />
            </section>
          </>
        )}

        {/* ---------- account-wide ---------- */}
        <section className="card span-12">
          <h2>Equity curve — shared account (USD)</h2>
          <EquityChart
            points={snapshots.map((s) => ({ t: s.candle_time, equity: s.equity }))}
            baseline={CONFIG.account.startingEquity}
          />
        </section>

        <section className="card span-6">
          <h2>Performance — all instruments</h2>
          <Row k="Closed trades" v={String(metrics.totalTrades)} />
          <Row k="Win rate" v={metrics.winRatePct === null ? "—" : `${metrics.winRatePct.toFixed(1)}% (${metrics.wins}W / ${metrics.losses}L)`} />
          <Row k="Profit factor" v={metrics.profitFactor === null ? "—" : metrics.profitFactor === Infinity ? "∞" : metrics.profitFactor.toFixed(2)} />
          <Row k="Max drawdown" v={`${metrics.maxDrawdownPct.toFixed(2)}%`} />
          <Row k="Avg trade" v={metrics.totalTrades ? signUsd(metrics.avgTrade) : "—"} />
          <Row k="Total fees" v={usd(metrics.totalFees)} />
          <Row k="Current streak" v={streakLabel(metrics.currentStreak)} />
        </section>

        <section className="card span-6">
          <h2>Bot status</h2>
          <Row
            k="State"
            v={account.halted ? `HALTED — ${account.halt_reason}` : health.stale ? "scheduler down" : "active"}
            dot={account.halted ? "var(--bad)" : health.stale ? "var(--warn)" : "var(--good)"}
          />
          <Row k="Last run" v={account.last_eval_at ? `${fmtDateTime(account.last_eval_at)} (${formatAge(health.ageMs ?? 0)} ago)` : "never"} />
          <Row k="Next check" v={fmtDateTime(nextCheck)} />
          <Row k="Instruments" v={`${enabledInstruments().length} total · ${[...states.values()].filter((s) => s.warming_up).length} warming up`} />
          <Row k="Consecutive losses" v={`${account.consecutive_losses} / ${CONFIG.risk.maxConsecutiveLosses}`} />
          <Row k="Strategy version" v={STRATEGY_VERSION} />
        </section>

        {/* ---------- missed opportunities ---------- */}
        <section className="card span-12">
          <h2>Missed opportunities — what the budget actually cost</h2>
          {missed.length === 0 ? (
            <p className="muted" style={{ fontSize: 13 }}>
              None yet. Every valid signal so far has been affordable.
            </p>
          ) : (
            <>
              <div className="missed-summary">
                <div className="missed-stat">
                  <div className="account-label">Net effect of skipping</div>
                  <div className={`missed-total ${missedNet >= 0 ? "neg" : "pos"}`}>
                    {missedNet >= 0 ? `−${usd(missedNet)}` : `+${usd(-missedNet)}`}
                  </div>
                  <div className="account-sub">
                    {missedNet >= 0
                      ? "these trades would have made money — the budget cost us this"
                      : "these trades would have lost money — the budget saved us this"}
                  </div>
                </div>
                <div className="missed-stat">
                  <div className="account-label">Resolved</div>
                  <div className="missed-total">{missedResolved.length} / {missed.length}</div>
                  <div className="account-sub">
                    {missedWins} would have won · {missedResolved.length - missedWins} would have lost
                    {missed.length - missedResolved.length > 0 &&
                      ` · ${missed.length - missedResolved.length} still running`}
                  </div>
                </div>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>When</th><th>Instrument</th><th>Side</th><th>Entry</th>
                      <th>Needed</th><th>Available</th><th>Shortfall</th>
                      <th>Would have</th><th>P/L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {missed.map((m) => (
                      <tr key={m.id}>
                        <td className="num">{fmtDateTime(m.created_at)}</td>
                        <td>{m.instrument_id}</td>
                        <td><SideBadge side={m.side} /></td>
                        <td className="num">{px(m.entry_price, m.instrument_id)}</td>
                        <td className="num">{usd(m.wanted_notional)}</td>
                        <td className="num">{usd(m.available_capital)}</td>
                        <td className="num muted">{usd(m.wanted_notional - m.available_capital)}</td>
                        <td>
                          {m.hypothetical_exit === null ? (
                            <span className="muted">still running</span>
                          ) : (
                            <span>hit {m.hypothetical_exit}</span>
                          )}
                        </td>
                        <td className={`num ${m.hypothetical_pnl === null ? "muted" : m.hypothetical_pnl >= 0 ? "pos" : "neg"}`}>
                          {m.hypothetical_pnl === null ? "—" : signUsd(m.hypothetical_pnl)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="capital-note">
                Each skipped setup is replayed with the entry, stop and target recorded at the
                time and the same exit rules a real position gets, including the {CONFIG.exits.maxBarsHeld}-bar
                time stop. &quot;We missed N signals&quot; has no sign on its own — half of them may
                have been losers, in which case the fixed budget protected the account.
              </p>
            </>
          )}
        </section>

        {/* ---------- trade log ---------- */}
        <section className="card span-12">
          <h2>Trade log — every trade, nothing hidden</h2>
          {trades.length === 0 && openPositions.length === 0 ? (
            <p className="muted" style={{ fontSize: 13 }}>No trades yet.</p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Entry time</th><th>Instrument</th><th>Side</th><th>Entry</th><th>Exit</th>
                    <th>Notional</th><th>Fees</th><th>P/L $</th><th>P/L %</th><th>Exit reason</th>
                  </tr>
                </thead>
                <tbody>
                  {openPositions.map((p) => (
                    <tr key={`o${p.id}`}>
                      <td className="num">{fmtDateTime(p.entry_time)}</td>
                      <td>{p.instrument_id}</td>
                      <td><SideBadge side={p.side} /></td>
                      <td className="num">{px(p.entry_price, p.instrument_id)}</td>
                      <td className="num muted">open</td>
                      <td className="num">{usd(p.notional)}</td>
                      <td className="num">{usd(p.entry_fee)}</td>
                      <td className={`num ${p.unrealized >= 0 ? "pos" : "neg"}`} colSpan={2}>
                        unrealized {signUsd(p.unrealized)}
                      </td>
                      <td className="muted">—</td>
                    </tr>
                  ))}
                  {trades.map((t) => (
                    <tr key={t.id}>
                      <td className="num">{fmtDateTime(t.entry_time)}</td>
                      <td>{t.instrument_id}</td>
                      <td><SideBadge side={t.side} /></td>
                      <td className="num">{px(t.entry_price, t.instrument_id)}</td>
                      <td className="num">{px(t.exit_price, t.instrument_id)}</td>
                      <td className="num">{usd(t.notional)}</td>
                      <td className="num">{usd(t.entry_fee + t.exit_fee)}</td>
                      <td className={`num ${t.pnl >= 0 ? "pos" : "neg"}`}>{signUsd(t.pnl)}</td>
                      <td className={`num ${t.pnl >= 0 ? "pos" : "neg"}`}>{signPct(t.pnl_pct)}</td>
                      <td>{t.exit_reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ---------- strategy ---------- */}
        <section className="card span-12">
          <h2>Strategy — identical rules on every instrument ({STRATEGY_VERSION})</h2>
          <ul className="rules">
            <li>Indicators on each instrument&apos;s own bars: <code>EMA21</code>, <code>EMA50</code>, <code>EMA200</code>, <code>RSI14</code>, <code>ATR14</code>. Identical entry rule everywhere — only two venue-level settings differ, each forced by market structure rather than chosen for performance.</li>
            <li><strong>Crypto:</strong> <code>4h</code> bars, long <em>and</em> short. Trades 24/7, so a 4h grid lines up with the clock.</li>
            <li><strong>US stocks:</strong> <code>1d</code> bars, <strong>long only</strong>. A 6.5-hour session does not divide into 4h, and equities drift upward over time, so shorting single names fights that drift — measured, daily beat hourly and long-only beat long+short in every paired comparison.</li>
            <li>Regime: <code>EMA50 &gt; EMA200</code> → longs only; <code>EMA50 &lt; EMA200</code> → shorts only (US stocks simply stand aside instead).</li>
            <li>Entry LONG: close crosses <em>above</em> EMA21 AND <code>RSI14 &gt; 52</code> AND bull regime. SHORT mirrors it with <code>RSI14 &lt; 48</code>.</li>
            <li>Dead band: no trades while <code>48 ≤ RSI ≤ 52</code>.</li>
            <li>Stop: entry ∓ <code>3.5 × ATR14</code>. Target: 4× the stop distance. One position per instrument. A tighter 2.5× stop sat inside normal noise and was taken out before moves developed.</li>
            <li>Size: <code>qty = (equity × 0.015) / (2.5 × ATR14)</code> — 1.5% of the shared account risked per trade, so a volatile instrument automatically gets a smaller position than a calm one.</li>
            <li>Capital: one shared {usd(CONFIG.account.startingEquity)}. A signal is only taken if its notional fits the free balance; otherwise it is logged as missed.</li>
            <li>Fills: entry at bar close + 0.05% slippage against the trade; if a bar touches both stop and target the stop is assumed first; a bar that <em>gaps</em> past the stop fills at the open, not the stop; 0.1% fee per fill.</li>
          </ul>
          <div className="disclaimer">
            ⚠ PAPER TRADING — simulated fills on live market data. Educational project, not financial
            advice. No real orders are placed and no broker or exchange keys exist.
          </div>
        </section>
      </div>

      <footer>
        Crypto via Binance public REST · US stocks via Yahoo Finance · scheduler checks hourly,
        decisions only on closed bars · times in Istanbul ({tzLabel()})
      </footer>
    </main>
  );
}

/* ---------------- data ---------------- */

type Json = Record<string, unknown>;

/** Shape of the single json_build_object the page fetches. */
interface RawPayload {
  account: Json | null;
  states: Json[];
  open_trades: Json[];
  closed_trades: Json[];
  snapshots: Json[];
  signals: Json[];
  candles: Json[];
  missed: Json[];
  last_close: Record<string, number>;
}

/**
 * The whole page in ONE round trip.
 *
 * This used to be nine queries. Against Supabase's free-tier pooler that was
 * enough concurrent connections to intermittently exhaust it: roughly half of
 * all page loads hung until the client gave up, and which instrument you had
 * selected made no difference. Collapsing everything into a single
 * json_build_object removes the contention entirely — one connection, one
 * statement, one result.
 */
async function load(selectedId: string) {
  const sql = db();

  const [{ payload }] = await sql<{ payload: RawPayload }[]>`
    SELECT json_build_object(
      'account', (SELECT row_to_json(a) FROM account_state a WHERE a.id = 1),
      'states', (SELECT coalesce(json_agg(s), '[]'::json) FROM instrument_state s),
      'open_trades', (SELECT coalesce(json_agg(t ORDER BY t.id), '[]'::json)
                      FROM trades t WHERE t.status = 'open'),
      'closed_trades', (SELECT coalesce(json_agg(x), '[]'::json) FROM (
          SELECT * FROM trades
          WHERE status = 'closed' AND strategy_version = ${STRATEGY_VERSION}
          ORDER BY exit_candle DESC, id DESC LIMIT 300) x),
      'snapshots', (SELECT coalesce(json_agg(y ORDER BY y.id), '[]'::json) FROM (
          SELECT id, candle_time, equity FROM equity_snapshots
          WHERE strategy_version = ${STRATEGY_VERSION} ORDER BY id DESC LIMIT 3000) y),
      'signals', (SELECT coalesce(json_agg(z ORDER BY z.id DESC), '[]'::json) FROM (
          SELECT id, created_at, candle_time, action, reason, details FROM signals
          WHERE instrument_id = ${selectedId} ORDER BY id DESC LIMIT 12) z),
      'candles', (SELECT coalesce(json_agg(c ORDER BY c.open_time), '[]'::json) FROM (
          SELECT open_time, open, high, low, close FROM candles
          WHERE symbol = ${selectedId} ORDER BY open_time DESC LIMIT 1200) c),
      'missed', (SELECT coalesce(json_agg(m ORDER BY m.id DESC), '[]'::json) FROM (
          SELECT * FROM missed_opportunities ORDER BY id DESC LIMIT 50) m),
      'last_close', (SELECT coalesce(json_object_agg(l.symbol, l.close), '{}'::json) FROM (
          SELECT DISTINCT ON (symbol) symbol, close FROM candles
          ORDER BY symbol, open_time DESC) l)
    ) AS payload
  `;

  const accountRows = payload.account ? [payload.account] : [];
  const stateRows = payload.states;
  const openRows = payload.open_trades;
  const tradeRows = payload.closed_trades;
  const snapRows = payload.snapshots;
  const signalRows = payload.signals;
  const candleRows = payload.candles;
  const missedRows = payload.missed;
  const lastClose = new Map<string, number>(
    Object.entries(payload.last_close).map(([k, v]) => [k, Number(v)])
  );

  const account = accountRows.length
    ? {
        realized_equity: Number(accountRows[0].realized_equity),
        consecutive_losses: Number(accountRows[0].consecutive_losses),
        halted: Boolean(accountRows[0].halted),
        halt_reason: accountRows[0].halt_reason as string | null,
        last_eval_at: asDate(accountRows[0].last_eval_at),
      }
    : null;

  const states = new Map(
    stateRows.map((r) => [
      String(r.instrument_id),
      { warming_up: Boolean(r.warming_up), candles_seen: Number(r.candles_seen) },
    ])
  );

  const openPositions = openRows.map((r) => {
    const side = r.side as "long" | "short";
    const entry = Number(r.entry_price);
    const qty = Number(r.qty);
    const mark = lastClose.get(String(r.instrument_id)) ?? entry;
    return {
      id: Number(r.id),
      instrument_id: String(r.instrument_id),
      side,
      entry_time: asDate(r.entry_time) as Date,
      entry_candle: Number(r.entry_candle),
      entry_price: entry,
      qty,
      stop_price: Number(r.stop_price),
      target_price: Number(r.target_price),
      entry_fee: Number(r.entry_fee),
      notional: Number(r.notional ?? entry * qty),
      unrealized: (side === "long" ? 1 : -1) * (mark - entry) * qty,
    };
  });

  const trades = tradeRows.map((r) => ({
    id: Number(r.id),
    instrument_id: String(r.instrument_id),
    side: r.side as "long" | "short",
    entry_time: asDate(r.entry_time) as Date,
    entry_candle: Number(r.entry_candle),
    exit_candle: r.exit_candle === null || r.exit_candle === undefined ? null : Number(r.exit_candle),
    entry_price: Number(r.entry_price),
    exit_price: Number(r.exit_price),
    qty: Number(r.qty),
    notional: Number(r.notional ?? Number(r.entry_price) * Number(r.qty)),
    entry_fee: Number(r.entry_fee),
    exit_fee: Number(r.exit_fee),
    pnl: Number(r.pnl),
    pnl_pct: Number(r.pnl_pct),
    exit_reason: String(r.exit_reason),
  }));

  return {
    account,
    states,
    openPositions,
    trades,
    snapshots: snapRows.map((r) => ({ candle_time: Number(r.candle_time), equity: Number(r.equity) })),
    signals: signalRows.map((r) => ({
      id: Number(r.id),
      created_at: asDate(r.created_at) as Date,
      candle_time: r.candle_time === null || r.candle_time === undefined ? null : Number(r.candle_time),
      action: String(r.action),
      reason: String(r.reason),
      details: (r.details ?? null) as EvalDetails | null,
    })),
    priceSeries: buildPriceSeries(candleRows),
    missed: missedRows.map((r) => ({
      id: Number(r.id),
      created_at: asDate(r.created_at) as Date,
      instrument_id: String(r.instrument_id),
      side: r.side as "long" | "short",
      entry_price: Number(r.entry_price),
      wanted_notional: Number(r.wanted_notional),
      available_capital: Number(r.available_capital),
      hypothetical_pnl:
        r.hypothetical_pnl === null || r.hypothetical_pnl === undefined ? null : Number(r.hypothetical_pnl),
      hypothetical_exit: (r.hypothetical_exit ?? null) as string | null,
    })),
  };
}

/** JSON has no date type, so timestamps arrive as ISO strings. */
function asDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v : new Date(String(v));
}

function buildPriceSeries(rows: readonly Record<string, unknown>[]): PricePoint[] {
  const candles = rows.map((r) => ({
    t: Number(r.open_time),
    o: Number(r.open),
    h: Number(r.high),
    l: Number(r.low),
    c: Number(r.close),
  }));
  if (candles.length === 0) return [];
  const closes = candles.map((c) => c.c);
  const e21 = ema(closes, CONFIG.indicators.emaFast);
  const e50 = ema(closes, CONFIG.indicators.emaMid);
  const e200 = ema(closes, CONFIG.indicators.emaSlow);
  const r14 = rsi(closes, CONFIG.indicators.rsiPeriod);
  return candles.map((c, i) => ({ ...c, ema21: e21[i], ema50: e50[i], ema200: e200[i], rsi: r14[i] }));
}

/* ---------------- presentation ---------------- */

function Header() {
  return (
    <div className="topbar">
      <h1>
        PaperTrade
        <span className="paper-badge">Paper trading</span>
      </h1>
      <span className="muted" style={{ fontSize: 13 }}>public &amp; read-only · times in {tzLabel()}</span>
    </div>
  );
}

function AccountStat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "pos" | "neg" }) {
  return (
    <div className="account-stat">
      <div className="account-label">{label}</div>
      <div className={`account-value ${tone ?? ""}`}>{value}</div>
      {sub && <div className="account-sub">{sub}</div>}
    </div>
  );
}

function Row({ k, v, dot }: { k: string; v: string; dot?: string }) {
  return (
    <div className="stat-row">
      <span className="k">{k}</span>
      <span className="num">
        {dot && <span className="status-dot" style={{ background: dot }} />}
        {v}
      </span>
    </div>
  );
}

function SideBadge({ side }: { side: "long" | "short" }) {
  return <span className={`side-badge side-${side}`}>{side}</span>;
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
/** Sub-dollar instruments need more decimals than BTC does. */
function px(v: number, instrumentId: string): string {
  const small = v < 10 || instrumentId === "SUIUSDT" || instrumentId === "HBARUSDT" || instrumentId === "XRPUSDT";
  return v.toLocaleString("en-US", {
    minimumFractionDigits: small ? 4 : 2,
    maximumFractionDigits: small ? 6 : 2,
  });
}
function streakLabel(streak: number): string {
  if (streak === 0) return "—";
  return streak > 0 ? `${streak} win${streak > 1 ? "s" : ""}` : `${-streak} loss${streak < -1 ? "es" : ""}`;
}
