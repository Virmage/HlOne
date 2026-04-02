"use client";

import type { DivergenceSignal } from "@/lib/api";

interface DivergencePanelProps {
  divergences: DivergenceSignal[];
  onSelectToken: (coin: string) => void;
}

export function DivergencePanel({ divergences, onSelectToken }: DivergencePanelProps) {
  return (
    <div>
      <h2 className="text-[13px] font-medium text-[var(--hl-muted)] uppercase tracking-wider mb-2 px-1">
        Sharp vs Square Divergences
      </h2>
      {divergences.length === 0 ? (
        <div className="text-center text-[var(--hl-muted)] text-[12px] py-6">
          No divergences detected
        </div>
      ) : (
        <div className="space-y-1.5">
          {divergences.map((d) => {
            // Sharp direction is the "smart money" signal
            const sharpBullish = d.sharpDirection === "long";
            return (
              <button
                key={d.coin}
                onClick={() => onSelectToken(d.coin)}
                className="w-full text-left rounded-md border border-[var(--hl-border)] bg-[var(--hl-surface)] p-2 hover:bg-[var(--hl-surface-hover)] transition-colors"
              >
                <div className="flex items-center justify-between mb-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[var(--foreground)] text-[13px]">{d.coin}</span>
                    <span className={`text-[11px] tabular-nums ${d.change24h >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                      {d.change24h >= 0 ? "+" : ""}{d.change24h.toFixed(2)}%
                    </span>
                  </div>
                  {d.score !== null && (
                    <span className={`text-[11px] font-medium tabular-nums ${
                      d.score >= 60 ? "text-[var(--hl-green)]" : d.score <= 40 ? "text-[var(--hl-red)]" : "text-[var(--hl-text)]"
                    }`}>
                      Score {d.score}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-[11px]">
                  <div className="flex items-center gap-1">
                    <span className="text-[var(--hl-muted)]">Sharps</span>
                    <span className={sharpBullish ? "text-[var(--hl-green)] font-medium" : "text-[var(--hl-red)] font-medium"}>
                      {d.sharpDirection.toUpperCase()}
                    </span>
                    <span className="text-[var(--hl-muted)] text-[10px]">{d.sharpConviction}%</span>
                  </div>
                  <span className="text-yellow-500 text-[10px]">vs</span>
                  <div className="flex items-center gap-1">
                    <span className="text-[var(--hl-muted)]">Squares</span>
                    <span className={d.squareDirection === "long" ? "text-[var(--hl-green)] font-medium" : "text-[var(--hl-red)] font-medium"}>
                      {d.squareDirection.toUpperCase()}
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
