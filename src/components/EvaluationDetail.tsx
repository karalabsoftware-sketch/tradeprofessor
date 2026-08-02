import { CONFIG } from "@/config/strategy";

/**
 * Renders the full "why" behind one evaluation: the candle, the indicator
 * values, and every entry gate marked pass/fail. Answers "is the bot broken
 * or did the market just not qualify?" without reading logs.
 */

export interface EvalGates {
  warmedUp: boolean;
  regime: "bull" | "bear" | null;
  allowedSide: "long" | "short" | null;
  crossedAbove: boolean;
  crossedBelow: boolean;
  crossoverOk: boolean;
  rsi: number | null;
  inDeadBand: boolean;
  rsiOk: boolean;
  flat: boolean;
  notHalted: boolean;
}

export interface EvalDetails {
  candle?: { open: number; high: number; low: number; close: number };
  indicators?: {
    ema21: number | null;
    ema50: number | null;
    ema200: number | null;
    rsi14: number | null;
    atr14: number | null;
  };
  prev?: { close: number; ema21: number | null };
  gates?: EvalGates;
  exits?: string[];
}

interface Props {
  candleTime: number | null;
  action: string;
  reason: string;
  details: EvalDetails | null;
}

export default function EvaluationDetail({ candleTime, action, reason, details }: Props) {
  const g = details?.gates;
  const ind = details?.indicators;
  const traded = action.startsWith("entry");

  return (
    <>
      <div className="eval-head">
        <div>
          <span className="muted" style={{ fontSize: 12 }}>
            {candleTime ? `${utc(candleTime)} candle` : "no candle"}
          </span>
          <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>
            {traded ? (
              <span className="pos">TRADE OPENED — {action.replace("entry_", "").toUpperCase()}</span>
            ) : action === "exit" ? (
              <span>POSITION CLOSED</span>
            ) : action === "error" ? (
              <span className="neg">DATA ERROR — cycle skipped</span>
            ) : (
              <span className="muted">NO TRADE</span>
            )}
          </div>
        </div>
      </div>

      <p className="eval-reason">{reason}</p>

      {ind && details?.candle && (
        <div className="ind-strip">
          <Metric label="Close" value={num(details.candle.close)} />
          <Metric label="EMA21" value={num(ind.ema21)} />
          <Metric label="EMA50" value={num(ind.ema50)} />
          <Metric label="EMA200" value={num(ind.ema200)} />
          <Metric label="RSI14" value={ind.rsi14 === null ? "—" : ind.rsi14.toFixed(1)} />
          <Metric label="ATR14" value={num(ind.atr14)} />
        </div>
      )}

      {g && (
        <>
          <h3 className="gate-title">Entry conditions — all must pass</h3>
          <ul className="gate-list">
            <Gate
              ok={g.warmedUp}
              label="Indicators warmed up"
              detail={g.warmedUp ? "≥300 closed candles" : "not enough history yet"}
            />
            <Gate
              ok={g.regime !== null}
              neutral
              label="Regime"
              detail={
                g.regime === null
                  ? "unknown"
                  : `${g.regime.toUpperCase()} (EMA50 ${g.regime === "bull" ? ">" : "<"} EMA200) → only ${g.allowedSide?.toUpperCase()} entries allowed`
              }
            />
            <Gate
              ok={g.crossoverOk}
              label="EMA21 crossover event"
              detail={crossoverDetail(g, details?.prev, details?.candle, ind)}
            />
            <Gate
              ok={g.rsiOk}
              label="RSI filter"
              detail={rsiDetail(g)}
            />
            <Gate ok={g.flat} label="No open position" detail={g.flat ? "flat" : "already in a trade (max 1)"} />
            <Gate
              ok={g.notHalted}
              label="Risk engine"
              detail={g.notHalted ? "not halted" : "HALTED — new entries blocked"}
            />
          </ul>
        </>
      )}

      {details?.exits && details.exits.length > 0 && (
        <p className="eval-reason" style={{ marginTop: 10 }}>
          <strong>Exits this cycle:</strong> {details.exits.join(" · ")}
        </p>
      )}
    </>
  );
}

function Gate({
  ok,
  neutral,
  label,
  detail,
}: {
  ok: boolean;
  neutral?: boolean;
  label: string;
  detail: string;
}) {
  const mark = neutral ? "•" : ok ? "✓" : "✗";
  const cls = neutral ? "gate-neutral" : ok ? "gate-ok" : "gate-fail";
  return (
    <li className={`gate ${cls}`}>
      <span className="gate-mark">{mark}</span>
      <span className="gate-label">{label}</span>
      <span className="gate-detail">{detail}</span>
    </li>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="ind-cell">
      <div className="ind-label">{label}</div>
      <div className="ind-value">{value}</div>
    </div>
  );
}

function crossoverDetail(
  g: EvalGates,
  prev: EvalDetails["prev"],
  candle: EvalDetails["candle"],
  ind: EvalDetails["indicators"]
): string {
  if (g.crossoverOk) {
    return g.crossedAbove ? "close crossed ABOVE EMA21 this candle" : "close crossed BELOW EMA21 this candle";
  }
  const wrongWay =
    (g.crossedAbove && g.allowedSide === "short") || (g.crossedBelow && g.allowedSide === "long");
  if (wrongWay) {
    return `crossed ${g.crossedAbove ? "above" : "below"} EMA21, but the ${g.regime} regime blocks that direction`;
  }
  if (prev && candle && ind) {
    const prevSide = prev.ema21 === null ? "?" : prev.close > prev.ema21 ? "above" : "below";
    const nowSide = ind.ema21 === null ? "?" : candle.close > ind.ema21 ? "above" : "below";
    return `no crossing — close was ${prevSide} EMA21 last candle and is ${nowSide} now`;
  }
  return "no crossover event";
}

function rsiDetail(g: EvalGates): string {
  if (g.rsi === null) return "unavailable";
  const r = g.rsi.toFixed(1);
  if (g.inDeadBand) {
    return `RSI ${r} sits in the dead band [${CONFIG.entry.rsiShortMax}, ${CONFIG.entry.rsiLongMin}] — no trades either way`;
  }
  if (g.allowedSide === "long") {
    return g.rsiOk
      ? `RSI ${r} > ${CONFIG.entry.rsiLongMin}`
      : `RSI ${r} is not above ${CONFIG.entry.rsiLongMin} (needed for longs)`;
  }
  if (g.allowedSide === "short") {
    return g.rsiOk
      ? `RSI ${r} < ${CONFIG.entry.rsiShortMax}`
      : `RSI ${r} is not below ${CONFIG.entry.rsiShortMax} (needed for shorts)`;
  }
  return `RSI ${r}`;
}

function num(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function utc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}
