"use client";

import type { MacroAsset } from "@/lib/api";

interface MacroBarProps {
  macro: MacroAsset[];
}

function formatPrice(a: MacroAsset): string {
  // Yields are already percentages
  if (a.symbol.includes("TNX") || a.symbol.includes("TYX") || a.symbol.includes("IRX")) {
    return `${a.price.toFixed(2)}%`;
  }
  // JPY is inverted (large numbers)
  if (a.price >= 10000) return a.price.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (a.price >= 100) return a.price.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (a.price >= 1) return a.price.toFixed(2);
  return a.price.toFixed(4);
}

export function MacroBar({ macro }: MacroBarProps) {
  if (!macro.length) return null;

  return (
    <div className="overflow-hidden border-b border-[var(--hl-border)] bg-[var(--hl-surface)]">
      <div className="flex animate-ticker-slow hover:[animation-play-state:paused]">
        {[0, 1].map((copy) => (
          <div key={copy} className="flex shrink-0">
            <div className="flex items-center gap-1.5 px-3 py-1 text-[10px] font-medium text-[var(--hl-muted)] uppercase tracking-wider whitespace-nowrap border-r border-[var(--hl-border)]">
              TradFi
            </div>
            {macro.map((a) => {
              const isPositive = a.change24h >= 0;
              return (
                <div
                  key={`${copy}-${a.symbol}`}
                  className="flex items-center gap-1.5 px-3 py-1 text-[11px] whitespace-nowrap"
                >
                  <span className="text-[var(--hl-text)] font-medium">{a.name}</span>
                  <span className="text-[var(--foreground)] tabular-nums">
                    {formatPrice(a)}
                  </span>
                  <span className={`tabular-nums ${isPositive ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                    {isPositive ? "+" : ""}{a.change24h.toFixed(2)}%
                  </span>
                  <span className="text-[var(--hl-border)]">|</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
