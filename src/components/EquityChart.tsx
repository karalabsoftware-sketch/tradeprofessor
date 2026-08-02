"use client";

import { useMemo, useRef, useState } from "react";
import { fmtDate, fmtDateTimeTz } from "@/lib/format";

export interface EquityPoint {
  t: number; // candle open time, ms
  equity: number;
}

interface Props {
  points: EquityPoint[];
  baseline: number; // starting equity reference line
}

const W = 920;
const H = 260;
const PAD = { top: 14, right: 14, bottom: 26, left: 58 };

export default function EquityChart({ points, baseline }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const model = useMemo(() => {
    if (points.length === 0) return null;
    const values = points.map((p) => p.equity).concat(baseline);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const lo = min - span * 0.08;
    const hi = max + span * 0.08;

    const x = (i: number) =>
      points.length === 1
        ? (PAD.left + W - PAD.right) / 2
        : PAD.left + (i / (points.length - 1)) * (W - PAD.left - PAD.right);
    const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);

    const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(p.equity).toFixed(2)}`).join("");
    const area = `${line}L${x(points.length - 1).toFixed(2)},${H - PAD.bottom}L${x(0).toFixed(2)},${H - PAD.bottom}Z`;

    const ticks = [lo + (hi - lo) * 0.15, (lo + hi) / 2, lo + (hi - lo) * 0.85].map((v) => ({
      v,
      y: y(v),
    }));

    return { x, y, line, area, ticks, lo, hi };
  }, [points, baseline]);

  if (!model || points.length < 2) {
    return <p className="muted" style={{ fontSize: 13 }}>Not enough equity snapshots yet — the curve appears after a few evaluations.</p>;
  }

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const frac = (px - PAD.left) / (W - PAD.left - PAD.right);
    const i = Math.round(frac * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  };

  const h = hover !== null ? points[hover] : null;
  const hx = hover !== null ? model.x(hover) : 0;
  const hy = h ? model.y(h.equity) : 0;

  return (
    <div style={{ position: "relative" }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto", display: "block", touchAction: "none" }}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label="Equity curve, one point per evaluation"
      >
        {model.ticks.map((t) => (
          <g key={t.v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={t.y} y2={t.y} stroke="var(--border)" strokeWidth="1" />
            <text x={PAD.left - 8} y={t.y + 4} textAnchor="end" fontSize="11" fill="var(--ink-2)">
              {Math.round(t.v).toLocaleString("en-US")}
            </text>
          </g>
        ))}

        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={model.y(baseline)}
          y2={model.y(baseline)}
          stroke="var(--ink-3)"
          strokeWidth="1"
          strokeDasharray="4 4"
        />
        <text x={W - PAD.right} y={model.y(baseline) - 5} textAnchor="end" fontSize="10" fill="var(--ink-2)">
          start {baseline.toLocaleString("en-US")}
        </text>

        <path d={model.area} fill="var(--accent)" opacity="0.08" />
        <path d={model.line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />

        <text x={PAD.left} y={H - 8} textAnchor="start" fontSize="11" fill="var(--ink-2)">
          {fmtDate(points[0].t)}
        </text>
        <text x={W - PAD.right} y={H - 8} textAnchor="end" fontSize="11" fill="var(--ink-2)">
          {fmtDate(points[points.length - 1].t)}
        </text>

        {h && (
          <g>
            <line x1={hx} x2={hx} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--ink-3)" strokeWidth="1" />
            <circle cx={hx} cy={hy} r="4" fill="var(--accent)" stroke="var(--surface)" strokeWidth="2" />
          </g>
        )}
      </svg>

      {h && (
        <div
          style={{
            position: "absolute",
            left: `${(hx / W) * 100}%`,
            top: 0,
            transform: `translateX(${hover! > points.length / 2 ? "calc(-100% - 10px)" : "10px"})`,
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "6px 10px",
            fontSize: 12,
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          <div className="muted">{fmtDateTimeTz(h.t)}</div>
          <div style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
            ${h.equity.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        </div>
      )}
    </div>
  );
}

