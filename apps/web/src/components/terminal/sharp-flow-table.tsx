"use client";

import { useState } from "react";
import type { SharpFlow } from "@/lib/api";
import { pnlColor } from "@/lib/utils";

interface SharpFlowTableProps {
  flows: SharpFlow[];
  onSelectToken: (coin: string) => void;
}

export function SharpFlowTable({ flows, onSelectToken }: SharpFlowTableProps) {
  const [showInfo, setShowInfo] = useState(false);
  const [expanded, setExpanded] = useState(false);

  if (!flows.length) {
    return (
      <div className="flex h-32 items-center justify-center text-[var(--hl-muted)] text-[11px]">
        Loading smart money data...
      </div>
    );
  }

  // Sort divergences to top, then by score
  const sorted = [...flows].sort((a, b) => {
    if (a.divergence && !b.divergence) return -1;
    if (!a.divergence && b.divergence) return 1;
    return (b.score ?? 0) - (a.score ?? 0);
  });
  const INLINE_LIMIT = 15;
  const visibleFlows = expanded ? sorted : sorted.slice(0, INLINE_LIMIT);

  const renderTable = (items: SharpFlow[], inModal = false) => (
    <table className="w-full text-[11px] min-w-[420px]">
      <thead>
        <tr className="border-b border-[var(--hl-border)] text-[var(--hl-muted)]">
          <th className="py-1.5 px-2 text-left font-normal">Token</th>
          <th className="py-1.5 px-2 text-right font-normal hidden sm:table-cell">Price</th>
          <th className="py-1.5 px-2 text-right font-normal">24h</th>
          <th className="py-1.5 px-2 text-center font-normal">Sharps</th>
          <th className="py-1.5 px-2 text-center font-normal">Squares</th>
          <th className="py-1.5 px-2 text-right font-normal">Score</th>
        </tr>
      </thead>
      <tbody>
        {items.map((f) => {
          let scoreColor = "text-[var(--hl-muted)]";
          if (f.score !== null) {
            if (f.score >= 70) scoreColor = "text-[var(--hl-green)]";
            else if (f.score <= 30) scoreColor = "text-[var(--hl-red)]";
            else scoreColor = "text-[var(--hl-text)]";
          }
          const divTooltip = f.divergenceScore > 0
            ? `Divergence: ${f.divergenceScore}/100 — Sharps ${f.sharpDirection.toUpperCase()} (${f.sharpStrength}%) vs Squares ${f.squareDirection.toUpperCase()} (${f.squareStrength}%).`
            : "";
          return (
            <tr key={f.coin} className={`border-b border-[var(--hl-border)] hover:bg-[var(--hl-surface-hover)] cursor-pointer transition-colors ${f.divergence ? "bg-yellow-500/5" : ""}`}>
              <td className="py-1.5 px-2">
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={(e) => { e.stopPropagation(); onSelectToken(f.coin); }}
                    className="font-medium text-[var(--foreground)] hover:text-[var(--hl-accent)] transition-colors"
                  >
                    {f.coin.includes(":") ? f.coin.split(":")[1] : f.coin}
                  </button>
                  {f.divergence && <span className="text-[9px] px-1 py-0.5 rounded bg-yellow-500/15 text-yellow-400 font-medium" title={divTooltip}>⚡{f.divergenceScore}</span>}
                </div>
              </td>
              <td className="py-1.5 px-2 text-right text-[var(--hl-text)] tabular-nums hidden sm:table-cell">${f.price >= 1 ? f.price.toLocaleString(undefined, { maximumFractionDigits: 2 }) : f.price.toPrecision(4)}</td>
              <td className={`py-1.5 px-2 text-right tabular-nums ${f.change24h >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>{f.change24h >= 0 ? "+" : ""}{f.change24h.toFixed(2)}%</td>
              <td className="py-1.5 px-2"><DirectionBar direction={f.sharpDirection} strength={f.sharpStrength} count={f.sharpLongCount + f.sharpShortCount} /></td>
              <td className="py-1.5 px-2"><DirectionBar direction={f.squareDirection} strength={f.squareStrength} count={f.squareLongCount + f.squareShortCount} /></td>
              <td className={`py-1.5 px-2 text-right tabular-nums font-medium ${scoreColor}`}>{f.score !== null ? f.score : "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <div>
    <div className="flex flex-col cursor-pointer" onClick={() => setExpanded(true)}>
      <div className="mb-2 px-1 shrink-0">
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-medium text-[var(--hl-accent)] uppercase tracking-wider">
            Sharp Flow
          </h2>
          <button
            onClick={(e) => { e.stopPropagation(); setShowInfo(!showInfo); }}
            className="text-[10px] text-[var(--hl-muted)] hover:text-[var(--foreground)] transition-colors"
          >
            ⓘ
          </button>
        </div>
        {showInfo && (
          <div className="mt-1.5 rounded border border-[var(--hl-border)] bg-[var(--hl-surface)] px-2.5 py-2 text-[10px] text-[var(--hl-text)] leading-relaxed space-y-1">
            <p><span className="text-[var(--foreground)] font-medium">Sharps</span> = top profitable traders ranked by 30-day ROI with accounts &gt;$10K.</p>
            <p><span className="text-[var(--foreground)] font-medium">Squares</span> = rest of the market (retail).</p>
            <p><span className="text-yellow-400 font-medium">⚡ Divergence</span> = sharps and squares strongly disagree on direction — potential edge.</p>
            <p><span className="text-[var(--foreground)] font-medium">Score</span> = HLOne composite (sharp conviction + whale flow + social + momentum).</p>
          </div>
        )}
      </div>
      <div className="overflow-hidden flex-1">
        {renderTable(visibleFlows)}
      </div>
      {!expanded && sorted.length > 15 && (
        <div className="text-[10px] text-[var(--hl-muted)] text-center py-1 shrink-0">Click to expand</div>
      )}
    </div>
    {/* Expanded modal */}
    {expanded && (
      <div className="fixed inset-0 z-[9998] flex items-center justify-center" onClick={() => setExpanded(false)}>
        <div className="absolute inset-0 bg-black/50" />
        <div className="relative bg-[var(--background)] border border-[var(--hl-border)] rounded-lg shadow-2xl w-[90vw] max-w-[700px] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between p-3 border-b border-[var(--hl-border)] shrink-0">
            <h2 className="text-[13px] font-medium text-[var(--hl-accent)] uppercase tracking-wider">Sharp Flow</h2>
            <button onClick={() => setExpanded(false)} className="text-[var(--hl-muted)] hover:text-[var(--foreground)] text-[16px]">&times;</button>
          </div>
          <div className="overflow-y-auto flex-1">
            {renderTable(flows, true)}
          </div>
        </div>
      </div>
    )}
    </div>
  );
}

/** Centered bar: green fills right for long, red fills left for short */
function DirectionBar({ direction, strength, count }: { direction: string; strength: number; count: number }) {
  if (strength === 0 || direction === "neutral") {
    return <div className="text-center text-[10px] text-[var(--hl-muted)]">—</div>;
  }

  const isLong = direction === "long";
  const pct = Math.min(strength, 100);
  const color = isLong ? "var(--hl-green)" : "var(--hl-red)";
  const label = isLong ? "LONG" : "SHORT";

  return (
    <div className="flex items-center gap-1 sm:gap-1.5 justify-center">
      {/* Bar: centered with directional fill */}
      <div className="w-10 sm:w-16 h-2 rounded-full bg-[var(--hl-border)] overflow-hidden relative">
        {isLong ? (
          <div
            className="absolute left-0 top-0 h-full rounded-full bg-[var(--hl-green)]"
            style={{ width: `${pct}%` }}
          />
        ) : (
          <div
            className="absolute right-0 top-0 h-full rounded-full bg-[var(--hl-red)]"
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
      <span
        className="text-[10px] tabular-nums font-semibold min-w-[44px]"
        style={{ color }}
      >
        {label} {count}
      </span>
    </div>
  );
}
