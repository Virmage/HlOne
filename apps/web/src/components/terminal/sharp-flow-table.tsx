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
  if (!flows.length) {
    return (
      <div className="flex h-40 items-center justify-center text-[var(--hl-muted)] text-[13px]">
        Loading smart money data...
      </div>
    );
  }

  return (
    <div className="max-h-[320px] flex flex-col">
      <div className="mb-2 px-1 shrink-0">
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-medium text-[var(--hl-accent)] uppercase tracking-wider">
            Sharp Flow
          </h2>
          <button
            onClick={() => setShowInfo(!showInfo)}
            className="text-[10px] text-[var(--hl-muted)] hover:text-[var(--foreground)] transition-colors"
          >
            ⓘ
          </button>
        </div>
        {showInfo && (
          <div className="mt-1.5 rounded border border-[var(--hl-border)] bg-[var(--hl-surface)] px-2.5 py-2 text-[10px] text-[var(--hl-text)] leading-relaxed space-y-1">
            <p><span className="text-[var(--foreground)] font-medium">Sharps</span> = top profitable traders ranked by 30-day ROI with accounts &gt;$10K.</p>
            <p><span className="text-[var(--foreground)] font-medium">Squares</span> = rest of the market (retail).</p>
            <p><span className="text-yellow-400 font-medium">⚡ Divergence</span> = sharps and squares strongly disagree on direction — potential edge. Higher score = stronger disagreement with more liquidity.</p>
            <p><span className="text-[var(--foreground)] font-medium">Score</span> = HLOne composite (sharp conviction + whale flow + social + momentum).</p>
          </div>
        )}
      </div>
      <div className="overflow-x-auto overflow-y-auto scroll-on-hover flex-1">
        <table className="w-full text-[12px] min-w-[420px]">
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
            {flows.map((f) => {
              let scoreColor = "text-[var(--hl-muted)]";
              if (f.score !== null) {
                if (f.score >= 70) scoreColor = "text-[var(--hl-green)]";
                else if (f.score <= 30) scoreColor = "text-[var(--hl-red)]";
                else scoreColor = "text-[var(--hl-text)]";
              }

              const divTooltip = f.divergenceScore > 0
                ? `Divergence: ${f.divergenceScore}/100 — Sharps ${f.sharpDirection.toUpperCase()} (${f.sharpStrength}%) vs Squares ${f.squareDirection.toUpperCase()} (${f.squareStrength}%). ${f.sharpLongCount + f.sharpShortCount} sharps, ${f.squareLongCount + f.squareShortCount} squares.`
                : "";

              return (
                <tr
                  key={f.coin}
                  className="border-b border-[var(--hl-border)] hover:bg-[var(--hl-surface-hover)] cursor-pointer transition-colors"
                  onClick={() => onSelectToken(f.coin)}
                >
                  <td className="py-1.5 px-2">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-[var(--foreground)]">{f.coin.includes(":") ? f.coin.split(":")[1] : f.coin}</span>
                      {f.divergence && (
                        <span
                          className="text-[9px] px-1 py-0.5 rounded bg-yellow-500/15 text-yellow-400 font-medium cursor-help"
                          title={divTooltip}
                        >
                          ⚡{f.divergenceScore}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-1.5 px-2 text-right text-[var(--hl-text)] tabular-nums hidden sm:table-cell">
                    ${f.price >= 1 ? f.price.toLocaleString(undefined, { maximumFractionDigits: 2 }) : f.price.toPrecision(4)}
                  </td>
                  <td className={`py-1.5 px-2 text-right tabular-nums ${pnlColor(f.change24h)}`}>
                    {f.change24h >= 0 ? "+" : ""}{f.change24h.toFixed(2)}%
                  </td>
                  {/* Sharps — direction + strength bar */}
                  <td className="py-1.5 px-2">
                    <DirectionBar
                      direction={f.sharpDirection}
                      strength={f.sharpStrength}
                      count={f.sharpLongCount + f.sharpShortCount}
                    />
                  </td>
                  {/* Squares — direction + strength bar */}
                  <td className="py-1.5 px-2">
                    <DirectionBar
                      direction={f.squareDirection}
                      strength={f.squareStrength}
                      count={f.squareLongCount + f.squareShortCount}
                    />
                  </td>
                  <td className={`py-1.5 px-2 text-right tabular-nums font-medium ${scoreColor}`}>
                    {f.score !== null ? f.score : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
