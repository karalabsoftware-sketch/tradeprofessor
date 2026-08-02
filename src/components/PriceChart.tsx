"use client";

import { useMemo, useRef, useState } from "react";
import { CONFIG } from "@/config/strategy";
import { fmtDateTime } from "@/lib/format";

/**
 * BTCUSDT 4h price chart with the strategy's own indicators drawn on it, so
 * the numbers on the decision card can be read straight off the chart.
 *
 * Two stacked panels in one SVG: price (candles + EMA21/50/200) and RSI14
 * with the 48-52 dead band shaded. Hand-rolled SVG — no chart dependency, so
 * it adds nothing to the bundle beyond this file.
 */

export interface PricePoint {
  t: number; // candle open time (ms)
  o: number;
  h: number;
  l: number;
  c: number;
  ema21: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi: number | null;
}

export interface TradeMarker {
  t: number;
  kind: "entry" | "exit";
  side: "long" | "short";
  price: number;
}

interface Props {
  points: PricePoint[];
  markers?: TradeMarker[];
  /** Candle the most recent decision was taken on — highlighted. */
  latestDecisionT?: number | null;
}

const W = 920;
const PRICE_H = 300;
const RSI_H = 110;
const GAP = 18;
const H = PRICE_H + GAP + RSI_H;
const PAD = { left: 62, right: 12, top: 12, bottom: 22 };

const EMA_COLORS = { ema21: "#5aa9ff", ema50: "#e8b44a", ema200: "#b98cff" };

export default function PriceChart({ points, markers = [], latestDecisionT }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const m = useMemo(() => {
    if (points.length < 2) return null;

    const plotW = W - PAD.left - PAD.right;
    const step = plotW / points.length;
    const bodyW = Math.max(1.5, Math.min(9, step * 0.62));

    let lo = Infinity;
    let hi = -Infinity;
    for (const p of points) {
      lo = Math.min(lo, p.l);
      hi = Math.max(hi, p.h);
      for (const v of [p.ema21, p.ema50, p.ema200]) {
        if (v !== null) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
    }
    const padY = (hi - lo) * 0.06;
    lo -= padY;
    hi += padY;

    const rsis = points.map((p) => p.rsi).filter((v): v is number => v !== null);
    const rLo = Math.min(25, ...(rsis.length ? [Math.min(...rsis) - 4] : [25]));
    const rHi = Math.max(75, ...(rsis.length ? [Math.max(...rsis) + 4] : [75]));

    const x = (i: number) => PAD.left + i * step + step / 2;
    const yP = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * (PRICE_H - PAD.top - PAD.bottom);
    const rsiTop = PRICE_H + GAP;
    const yR = (v: number) => rsiTop + (1 - (v - rLo) / (rHi - rLo)) * (RSI_H - PAD.bottom);

    const emaPath = (key: "ema21" | "ema50" | "ema200") => {
      let d = "";
      let started = false;
      points.forEach((p, i) => {
        const v = p[key];
        if (v === null) {
          started = false;
          return;
        }
        d += `${started ? "L" : "M"}${x(i).toFixed(2)},${yP(v).toFixed(2)}`;
        started = true;
      });
      return d;
    };

    let rsiPath = "";
    let rStarted = false;
    points.forEach((p, i) => {
      if (p.rsi === null) {
        rStarted = false;
        return;
      }
      rsiPath += `${rStarted ? "L" : "M"}${x(i).toFixed(2)},${yR(p.rsi).toFixed(2)}`;
      rStarted = true;
    });

    const priceTicks = [0.12, 0.5, 0.88].map((f) => {
      const v = lo + (hi - lo) * f;
      return { v, y: yP(v) };
    });

    const dateTicks: { i: number; label: string }[] = [];
    const every = Math.max(1, Math.floor(points.length / 6));
    for (let i = 0; i < points.length; i += every) {
      dateTicks.push({ i, label: fmtDateTime(points[i].t).slice(5, 10) });
    }

    const indexByT = new Map(points.map((p, i) => [p.t, i]));

    return { x, yP, yR, step, bodyW, emaPath, rsiPath, priceTicks, dateTicks, rsiTop, rLo, rHi, indexByT, lo, hi };
  }, [points]);

  if (!m) {
    return <p className="muted" style={{ fontSize: 13 }}>Not enough candles stored yet to draw the chart.</p>;
  }

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.floor((px - PAD.left) / m.step);
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  };

  const hp = hover !== null ? points[hover] : null;
  const deadLoY = m.yR(CONFIG.entry.rsiShortMax);
  const deadHiY = m.yR(CONFIG.entry.rsiLongMin);

  return (
    <div style={{ position: "relative" }}>
      <div className="chart-legend">
        <LegendItem color={EMA_COLORS.ema21} label="EMA21" />
        <LegendItem color={EMA_COLORS.ema50} label="EMA50" />
        <LegendItem color={EMA_COLORS.ema200} label="EMA200" />
        <LegendItem color="var(--ink-2)" label="RSI14 (lower panel, shaded = dead band 48–52)" dashed />
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto", display: "block", touchAction: "none" }}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label="BTCUSDT 4h price with EMA21, EMA50, EMA200 and RSI14"
      >
        {/* price gridlines */}
        {m.priceTicks.map((t) => (
          <g key={`p${t.v}`}>
            <line x1={PAD.left} x2={W - PAD.right} y1={t.y} y2={t.y} stroke="var(--border)" strokeWidth="1" />
            <text x={PAD.left - 7} y={t.y + 4} textAnchor="end" fontSize="10" fill="var(--ink-2)">
              {Math.round(t.v).toLocaleString("en-US")}
            </text>
          </g>
        ))}

        {/* highlight the candle the latest decision was taken on */}
        {latestDecisionT != null && m.indexByT.has(latestDecisionT) && (
          <rect
            x={m.x(m.indexByT.get(latestDecisionT)!) - m.step / 2}
            y={PAD.top}
            width={m.step}
            height={PRICE_H - PAD.top - PAD.bottom}
            fill="var(--accent)"
            opacity="0.12"
          />
        )}

        {/* candles */}
        {points.map((p, i) => {
          const up = p.c >= p.o;
          const color = up ? "var(--good)" : "var(--bad)";
          const yHigh = m.yP(p.h);
          const yLow = m.yP(p.l);
          const yOpen = m.yP(p.o);
          const yClose = m.yP(p.c);
          const top = Math.min(yOpen, yClose);
          const bh = Math.max(1, Math.abs(yClose - yOpen));
          return (
            <g key={p.t} opacity="0.85">
              <line x1={m.x(i)} x2={m.x(i)} y1={yHigh} y2={yLow} stroke={color} strokeWidth="1" />
              <rect x={m.x(i) - m.bodyW / 2} y={top} width={m.bodyW} height={bh} fill={color} />
            </g>
          );
        })}

        {/* EMAs */}
        <path d={m.emaPath("ema200")} fill="none" stroke={EMA_COLORS.ema200} strokeWidth="1.5" />
        <path d={m.emaPath("ema50")} fill="none" stroke={EMA_COLORS.ema50} strokeWidth="1.5" />
        <path d={m.emaPath("ema21")} fill="none" stroke={EMA_COLORS.ema21} strokeWidth="2" />

        {/* trade markers */}
        {markers.map((mk, idx) => {
          const i = m.indexByT.get(mk.t);
          if (i === undefined) return null;
          const y = m.yP(mk.price);
          const isEntry = mk.kind === "entry";
          const up = mk.side === "long";
          const tri = isEntry
            ? up
              ? `${m.x(i)},${y - 9} ${m.x(i) - 5},${y + 1} ${m.x(i) + 5},${y + 1}`
              : `${m.x(i)},${y + 9} ${m.x(i) - 5},${y - 1} ${m.x(i) + 5},${y - 1}`
            : "";
          return isEntry ? (
            <polygon key={idx} points={tri} fill={up ? "var(--good)" : "var(--bad)"} stroke="var(--surface)" strokeWidth="1" />
          ) : (
            <g key={idx}>
              <circle cx={m.x(i)} cy={y} r="4" fill="var(--ink)" stroke="var(--surface)" strokeWidth="1.5" />
            </g>
          );
        })}

        {/* RSI panel */}
        <rect
          x={PAD.left}
          y={deadHiY}
          width={W - PAD.left - PAD.right}
          height={Math.max(1, deadLoY - deadHiY)}
          fill="var(--warn)"
          opacity="0.13"
        />
        <line x1={PAD.left} x2={W - PAD.right} y1={deadHiY} y2={deadHiY} stroke="var(--warn)" strokeWidth="1" opacity="0.5" />
        <line x1={PAD.left} x2={W - PAD.right} y1={deadLoY} y2={deadLoY} stroke="var(--warn)" strokeWidth="1" opacity="0.5" />
        <text x={PAD.left - 7} y={deadHiY + 4} textAnchor="end" fontSize="10" fill="var(--ink-2)">
          {CONFIG.entry.rsiLongMin}
        </text>
        <text x={PAD.left - 7} y={deadLoY + 4} textAnchor="end" fontSize="10" fill="var(--ink-2)">
          {CONFIG.entry.rsiShortMax}
        </text>
        <path d={m.rsiPath} fill="none" stroke="var(--ink-2)" strokeWidth="1.5" />

        {/* date axis */}
        {m.dateTicks.map((d) => (
          <text key={d.i} x={m.x(d.i)} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--ink-2)">
            {d.label}
          </text>
        ))}

        {/* crosshair */}
        {hp && hover !== null && (
          <g>
            <line x1={m.x(hover)} x2={m.x(hover)} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--ink-3)" strokeWidth="1" />
          </g>
        )}
      </svg>

      {hp && hover !== null && (
        <div
          className="chart-tip"
          style={{
            left: `${(m.x(hover) / W) * 100}%`,
            transform: `translateX(${hover > points.length / 2 ? "calc(-100% - 12px)" : "12px"})`,
          }}
        >
          <div className="muted" style={{ marginBottom: 3 }}>{fmtDateTime(hp.t)}</div>
          <Row k="O / C" v={`${n2(hp.o)} → ${n2(hp.c)}`} />
          <Row k="H / L" v={`${n2(hp.h)} / ${n2(hp.l)}`} />
          <Row k="EMA21" v={n2(hp.ema21)} color={EMA_COLORS.ema21} />
          <Row k="EMA50" v={n2(hp.ema50)} color={EMA_COLORS.ema50} />
          <Row k="EMA200" v={n2(hp.ema200)} color={EMA_COLORS.ema200} />
          <Row k="RSI14" v={hp.rsi === null ? "—" : hp.rsi.toFixed(1)} />
        </div>
      )}
    </div>
  );
}

function Row({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div className="chart-tip-row">
      <span>
        {color && <span className="tip-swatch" style={{ background: color }} />}
        {k}
      </span>
      <span className="num">{v}</span>
    </div>
  );
}

function LegendItem({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="legend-item">
      <span
        className="legend-swatch"
        style={{ background: dashed ? "transparent" : color, borderTop: dashed ? `2px dashed ${color}` : undefined }}
      />
      {label}
    </span>
  );
}

function n2(v: number | null): string {
  if (v === null) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
