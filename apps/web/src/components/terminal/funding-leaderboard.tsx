"use client";

import { useState } from "react";
import type { FundingLeaderboard } from "@/lib/api";

interface FundingLeaderboardPanelProps {
  funding: FundingLeaderboard;
  onSelectToken: (coin: string) => void;
}

function formatOI(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function FundingRow({ f, isPositive, onSelectToken }: { f: { coin: string; annualized: number; openInterest: number }; isPositive: boolean; onSelectToken: (coin: string) => void }) {
  return (
    <div
      className="flex items-center justify-between px-2 py-1 text-[11px] border-b border-[var(--hl-border)] hover:bg-[var(--hl-surface-hover)] cursor-pointer transition-colors"
      onClick={(e) => { e.stopPropagation(); onSelectToken(f.coin); }}
    >
      <span className="font-medium text-[var(--foreground)] w-16">{f.coin.includes(":") ? f.coin.split(":")[1] : f.coin}</span>
      <span className={`tabular-nums font-medium ${isPositive ? "text-[var(--hl-red)]" : "text-[var(--hl-green)]"}`}>
        {isPositive ? "+" : ""}{f.annualized.toFixed(1)}%
      </span>
      <span className="text-[var(--hl-muted)] tabular-nums text-[10px]">
        {formatOI(f.openInterest)}
      </span>
    </div>
  );
}

export function FundingLeaderboardPanel({ funding, onSelectToken }: FundingLeaderboardPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const hasData = funding.topPositive.length > 0 || funding.topNegative.length > 0;

  if (!hasData) {
    return (
      <div className="flex h-32 items-center justify-center text-[var(--hl-muted)] text-[11px]">
        Loading funding data...
      </div>
    );
  }

  return (
    <div>
      <div className="cursor-pointer" onClick={() => setExpanded(true)}>
        <h2 className="text-[13px] font-medium text-[var(--hl-accent)] uppercase tracking-wider mb-2 px-1">
          Funding Rates
        </h2>
        <div className="grid grid-cols-2 gap-px bg-[var(--hl-border)] overflow-hidden">
          <div className="bg-[var(--background)]">
            <div className="text-[10px] font-medium text-[var(--hl-red)] uppercase tracking-wider px-2 py-1.5 border-b border-[var(--hl-border)]">
              Longs Paying (Short to earn)
            </div>
            <div className="overflow-hidden">
              {funding.topPositive.map((f) => (
                <FundingRow key={f.coin} f={f} isPositive={true} onSelectToken={onSelectToken} />
              ))}
            </div>
          </div>
          <div className="bg-[var(--background)]">
            <div className="text-[10px] font-medium text-[var(--hl-green)] uppercase tracking-wider px-2 py-1.5 border-b border-[var(--hl-border)]">
              Shorts Paying (Long to earn)
            </div>
            <div className="overflow-hidden">
              {funding.topNegative.map((f) => (
                <FundingRow key={f.coin} f={f} isPositive={false} onSelectToken={onSelectToken} />
              ))}
            </div>
          </div>
        </div>
        {(funding.topPositive.length > 7 || funding.topNegative.length > 7) && (
          <div className="text-[10px] text-[var(--hl-muted)] text-center py-1">Click to see all</div>
        )}
      </div>
      {expanded && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center" onClick={() => setExpanded(false)}>
          <div className="absolute inset-0 bg-black/50" />
          <div className="relative bg-[var(--background)] border border-[var(--hl-border)] rounded-lg shadow-2xl w-[90vw] max-w-[700px] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-3 border-b border-[var(--hl-border)] shrink-0">
              <h2 className="text-[13px] font-medium text-[var(--hl-accent)] uppercase tracking-wider">Funding Rates</h2>
              <button onClick={() => setExpanded(false)} className="text-[var(--hl-muted)] hover:text-[var(--foreground)] text-[16px]">&times;</button>
            </div>
            <div className="overflow-y-auto flex-1">
              <div className="grid grid-cols-2 gap-px bg-[var(--hl-border)]">
                <div className="bg-[var(--background)]">
                  <div className="text-[10px] font-medium text-[var(--hl-red)] uppercase tracking-wider px-2 py-1.5 border-b border-[var(--hl-border)]">Longs Paying</div>
                  {funding.topPositive.map((f) => (
                    <FundingRow key={`exp-${f.coin}`} f={f} isPositive={true} onSelectToken={onSelectToken} />
                  ))}
                </div>
                <div className="bg-[var(--background)]">
                  <div className="text-[10px] font-medium text-[var(--hl-green)] uppercase tracking-wider px-2 py-1.5 border-b border-[var(--hl-border)]">Shorts Paying</div>
                  {funding.topNegative.map((f) => (
                    <FundingRow key={`exp-${f.coin}`} f={f} isPositive={false} onSelectToken={onSelectToken} />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
