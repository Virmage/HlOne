"use client";

import type { DivergenceSignal } from "@/lib/api";
import { pnlColor } from "@/lib/utils";

interface DivergencePanelProps {
  divergences: DivergenceSignal[];
  onSelectToken: (coin: string) => void;
}

export function DivergencePanel({ divergences, onSelectToken }: DivergencePanelProps) {
  return (
    <div>
      <h2 className="text-[13px] font-medium text-[var(--hl-muted)] uppercase tracking-wider mb-2 px-1">
        Divergence Signals
      </h2>
      {divergences.length === 0 ? (
        <div className="text-center text-[var(--hl-muted)] text-[12px] py-6">
          No divergences detected
        </div>
      ) : (
        <div className="space-y-2">
          {divergences.map((d) => (
            <button
              key={d.coin}
              onClick={() => onSelectToken(d.coin)}
              className="w-full text-left rounded-md border border-[var(--hl-border)] bg-[var(--hl-surface)] p-2.5 hover:bg-[var(--hl-surface-hover)] transition-colors"
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-[var(--foreground)] text-[13px]">{d.coin}</span>
                  <span className={`text-[11px] tabular-nums ${pnlColor(d.change24h)}`}>
                    {d.change24h >= 0 ? "+" : ""}{d.change24h.toFixed(2)}%
                  </span>
                </div>
                {d.score !== null && (
                  <span className={`text-[11px] font-medium tabular-nums ${
                    d.score >= 60 ? "text-[var(--hl-green)]" : d.score <= 40 ? "text-[var(--hl-red)]" : "text-[var(--hl-text)]"
                  }`}>
                    CPYCAT {d.score}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 text-[11px]">
                <div className="flex items-center gap-1">
                  <span className="text-[var(--hl-muted)]">Sharps</span>
                  <span className={d.sharpDirection === "long" ? "text-[var(--hl-green)] font-medium" : "text-[var(--hl-red)] font-medium"}>
                    {d.sharpDirection.toUpperCase()} ({d.sharpCount})
                  </span>
                </div>
                <span className="text-[var(--hl-muted)]">vs</span>
                <div className="flex items-center gap-1">
                  <span className="text-[var(--hl-muted)]">Squares</span>
                  <span className={d.squareDirection === "long" ? "text-[var(--hl-green)] font-medium" : "text-[var(--hl-red)] font-medium"}>
                    {d.squareDirection.toUpperCase()} ({d.squareCount})
                  </span>
                </div>
              </div>
              <div className="mt-1 text-[10px] text-[var(--hl-muted)]">
                Sharp conviction: {d.sharpConviction}%
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
