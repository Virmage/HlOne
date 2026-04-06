"use client";

import type { TokenOverview } from "@/lib/api";

interface OIPanelProps {
  tokens: TokenOverview[];
  onSelectToken: (coin: string) => void;
}

function formatOI(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function formatVol(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(0)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

export function OIPanel({ tokens, onSelectToken }: OIPanelProps) {
  // Sort by OI descending, filter out zero OI
  const sorted = tokens
    .filter(t => t.openInterest > 0)
    .sort((a, b) => b.openInterest - a.openInterest)
    .slice(0, 15);

  if (!sorted.length) {
    return (
      <div className="flex h-32 items-center justify-center text-[var(--hl-muted)] text-[12px]">
        Loading OI data...
      </div>
    );
  }

  const maxOI = sorted[0].openInterest;

  return (
    <div>
      <h2 className="text-[13px] font-medium text-[var(--hl-muted)] uppercase tracking-wider mb-2 px-1">
        Open Interest
      </h2>
      <div className="space-y-0">
        {/* Header */}
        <div className="flex items-center px-2 py-1 text-[10px] text-[var(--hl-muted)] uppercase tracking-wider border-b border-[var(--hl-border)]">
          <span className="w-14">Token</span>
          <span className="flex-1">OI</span>
          <span className="w-16 text-right">24h Vol</span>
          <span className="w-14 text-right">Vol/OI</span>
          <span className="w-16 text-right">Funding</span>
        </div>
        <div className="overflow-y-auto scroll-on-hover max-h-[220px]">
          {sorted.map((t) => {
            const volOiRatio = t.openInterest > 0 ? t.volume24h / t.openInterest : 0;
            const barWidth = (t.openInterest / maxOI) * 100;
            return (
              <div
                key={t.coin}
                className="flex items-center px-2 py-1 text-[11px] border-b border-[var(--hl-border)] hover:bg-[var(--hl-surface-hover)] cursor-pointer transition-colors relative"
                onClick={() => onSelectToken(t.coin)}
              >
                {/* OI bar background */}
                <div
                  className="absolute inset-y-0 left-0 opacity-10 bg-[var(--hl-green)]"
                  style={{ width: `${barWidth}%` }}
                />
                <span className="font-medium text-[var(--foreground)] w-14 relative z-10">{t.coin.includes(":") ? t.coin.split(":")[1] : t.coin}</span>
                <span className="text-[var(--foreground)] tabular-nums flex-1 relative z-10">
                  {formatOI(t.openInterest)}
                </span>
                <span className="text-[var(--hl-muted)] tabular-nums w-16 text-right relative z-10">
                  {formatVol(t.volume24h)}
                </span>
                <span className={`tabular-nums w-14 text-right relative z-10 ${volOiRatio > 1 ? "text-[var(--hl-green)]" : "text-[var(--hl-muted)]"}`}>
                  {volOiRatio.toFixed(2)}x
                </span>
                <span className={`tabular-nums w-16 text-right relative z-10 ${t.fundingRate >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                  {(t.fundingRate * 100).toFixed(4)}%
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
