"use client";

import type { SharpFlow } from "@/lib/api";

/**
 * Mobile-only compact signals strip — top 3 sharp-flow signals shown
 * under the chart so users don't have to jump to the Data tab for
 * the most important reads. Tapping a token swaps the chart.
 *
 * Prioritises divergences (sharps disagree with squares) over raw score —
 * that's where the edge is.
 */
interface MobileSignalsStripProps {
  flows: SharpFlow[];
  onSelectToken: (coin: string) => void;
}

const displayCoin = (c: string) => (c.includes(":") ? c.split(":")[1] : c);

export function MobileSignalsStrip({ flows, onSelectToken }: MobileSignalsStripProps) {
  if (!flows?.length) return null;

  // Divergences first, then by score desc — same order logic as the full table.
  const sorted = [...flows].sort((a, b) => {
    if (a.divergence && !b.divergence) return -1;
    if (!a.divergence && b.divergence) return 1;
    return (b.score ?? 0) - (a.score ?? 0);
  });
  const top3 = sorted.slice(0, 3);
  if (top3.length === 0) return null;

  return (
    <div className="md:hidden border-b border-[var(--hl-border)] bg-[var(--hl-surface)]">
      <div className="flex items-center justify-between px-2.5 py-1">
        <span className="text-[9px] font-medium text-[var(--hl-accent)] uppercase tracking-wider">Top Signals</span>
        <span className="text-[9px] text-[var(--hl-muted)]">See Data tab →</span>
      </div>
      <div className="grid grid-cols-3 gap-px bg-[var(--hl-border)]">
        {top3.map(f => {
          const isDivergence = f.divergence;
          const direction = f.sharpDirection === "long" ? "LONG" : f.sharpDirection === "short" ? "SHORT" : "FLAT";
          const dirColor = f.sharpDirection === "long"
            ? "text-[var(--hl-green)]"
            : f.sharpDirection === "short"
              ? "text-[var(--hl-red)]"
              : "text-[var(--hl-muted)]";
          return (
            <button
              key={f.coin}
              onClick={() => onSelectToken(f.coin)}
              className={`flex flex-col items-start gap-0.5 px-2 py-1.5 bg-[var(--background)] active:bg-[var(--hl-surface-hover)] transition-colors ${
                isDivergence ? "ring-1 ring-inset ring-yellow-500/25" : ""
              }`}
            >
              <div className="flex items-center gap-1 w-full">
                <span className="text-[11px] font-bold text-[var(--foreground)] truncate">
                  {displayCoin(f.coin)}
                </span>
                {isDivergence && (
                  <span className="text-[8px] text-yellow-400 font-semibold ml-auto shrink-0">⚡{f.divergenceScore}</span>
                )}
              </div>
              <div className="flex items-baseline gap-1 w-full">
                <span className={`text-[10px] font-semibold ${dirColor}`}>{direction}</span>
                <span className="text-[9px] text-[var(--hl-muted)] tabular-nums ml-auto">
                  {f.sharpStrength}%
                </span>
              </div>
              <div className={`text-[9px] tabular-nums ${f.change24h >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                {f.change24h >= 0 ? "+" : ""}{f.change24h.toFixed(2)}%
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
