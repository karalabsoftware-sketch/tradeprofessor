/** Performance metrics computed from closed trades and equity snapshots. */

export interface ClosedTradeLike {
  pnl: number;
  entry_fee: number;
  exit_fee: number;
}

export interface Metrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  profitFactor: number | null; // null = undefined (no trades); Infinity = no losses
  avgTrade: number;
  totalFees: number;
  maxDrawdownPct: number;
  currentStreak: number; // positive = consecutive wins, negative = consecutive losses
}

export function computeMetrics(
  closedTradesNewestFirst: ClosedTradeLike[],
  equitySeries: number[]
): Metrics {
  const trades = closedTradesNewestFirst;
  const totalTrades = trades.length;
  const wins = trades.filter((t) => t.pnl >= 0).length;
  const losses = totalTrades - wins;

  const grossWin = trades.filter((t) => t.pnl >= 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));

  let profitFactor: number | null = null;
  if (totalTrades > 0) profitFactor = grossLoss === 0 ? Infinity : grossWin / grossLoss;

  const avgTrade = totalTrades === 0 ? 0 : trades.reduce((s, t) => s + t.pnl, 0) / totalTrades;
  const totalFees = trades.reduce((s, t) => s + t.entry_fee + t.exit_fee, 0);

  let streak = 0;
  for (const t of trades) {
    const win = t.pnl >= 0;
    if (streak === 0) streak = win ? 1 : -1;
    else if (streak > 0 && win) streak++;
    else if (streak < 0 && !win) streak--;
    else break;
  }

  let peak = -Infinity;
  let maxDd = 0;
  for (const eq of equitySeries) {
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? (peak - eq) / peak : 0;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    totalTrades,
    wins,
    losses,
    winRatePct: totalTrades === 0 ? null : (wins / totalTrades) * 100,
    profitFactor,
    avgTrade,
    totalFees,
    maxDrawdownPct: maxDd * 100,
    currentStreak: streak,
  };
}

/** Next expected scheduler run: 5 minutes past the next 4h UTC boundary. */
export function nextExpectedRun(nowMs: number, intervalMs: number): Date {
  const boundary = Math.floor(nowMs / intervalMs) * intervalMs + intervalMs;
  return new Date(boundary + 5 * 60 * 1000);
}
