"use client";

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

export function FundingLeaderboardPanel({ funding, onSelectToken }: FundingLeaderboardPanelProps) {
  const hasData = funding.topPositive.length > 0 || funding.topNegative.length > 0;

  if (!hasData) {
    return (
      <div className="flex h-32 items-center justify-center text-[var(--hl-muted)] text-[12px]">
        Loading funding data...
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-[13px] font-medium text-[var(--hl-muted)] uppercase tracking-wider mb-2 px-1">
        Funding Rates
      </h2>
      <div className="grid grid-cols-2 gap-px bg-[var(--hl-border)]">
        {/* Longs Paying (positive funding) */}
        <div className="bg-[var(--background)]">
          <div className="text-[10px] font-medium text-[var(--hl-red)] px-2 py-1 border-b border-[var(--hl-border)]">
            Longs Paying (Short to earn)
          </div>
          <div className="overflow-y-auto max-h-[180px]">
            {funding.topPositive.slice(0, 8).map((f) => (
              <div
                key={f.coin}
                className="flex items-center justify-between px-2 py-1 text-[11px] border-b border-[var(--hl-border)] hover:bg-[var(--hl-surface-hover)] cursor-pointer transition-colors"
                onClick={() => onSelectToken(f.coin)}
              >
                <span className="font-medium text-[var(--foreground)] w-16">{f.coin}</span>
                <span className="text-[var(--hl-red)] tabular-nums font-medium">
                  +{f.annualized.toFixed(1)}%
                </span>
                <span className="text-[var(--hl-muted)] tabular-nums text-[10px]">
                  {formatOI(f.openInterest)}
                </span>
              </div>
            ))}
          </div>
        </div>
        {/* Shorts Paying (negative funding) */}
        <div className="bg-[var(--background)]">
          <div className="text-[10px] font-medium text-[var(--hl-green)] px-2 py-1 border-b border-[var(--hl-border)]">
            Shorts Paying (Long to earn)
          </div>
          <div className="overflow-y-auto max-h-[180px]">
            {funding.topNegative.slice(0, 8).map((f) => (
              <div
                key={f.coin}
                className="flex items-center justify-between px-2 py-1 text-[11px] border-b border-[var(--hl-border)] hover:bg-[var(--hl-surface-hover)] cursor-pointer transition-colors"
                onClick={() => onSelectToken(f.coin)}
              >
                <span className="font-medium text-[var(--foreground)] w-16">{f.coin}</span>
                <span className="text-[var(--hl-green)] tabular-nums font-medium">
                  {f.annualized.toFixed(1)}%
                </span>
                <span className="text-[var(--hl-muted)] tabular-nums text-[10px]">
                  {formatOI(f.openInterest)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
