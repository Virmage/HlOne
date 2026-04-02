"use client";

import type { MacroAsset } from "@/lib/api";

interface MacroBarProps {
  macro: MacroAsset[];
}

export function MacroBar({ macro }: MacroBarProps) {
  if (!macro.length) return null;

  return (
    <div className="flex items-center gap-0 overflow-x-auto border-b border-[var(--hl-border)] bg-[var(--hl-surface)] px-2">
      <span className="text-[10px] font-medium text-[var(--hl-muted)] uppercase tracking-wider shrink-0 pr-2">
        TradFi
      </span>
      {macro.map((a) => {
        const isPositive = a.change24h >= 0;
        return (
          <div
            key={a.symbol}
            className="flex items-center gap-1.5 px-3 py-1 text-[11px] whitespace-nowrap"
          >
            <span className="text-[var(--hl-text)] font-medium">{a.name}</span>
            <span className="text-[var(--foreground)] tabular-nums">
              {a.symbol === "^TNX"
                ? `${a.price.toFixed(2)}%`
                : a.price >= 1000
                  ? a.price.toLocaleString(undefined, { maximumFractionDigits: 0 })
                  : a.price.toFixed(2)}
            </span>
            <span className={`tabular-nums ${isPositive ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
              {isPositive ? "+" : ""}{a.change24h.toFixed(2)}%
            </span>
            <span className="text-[var(--hl-border)]">|</span>
          </div>
        );
      })}
    </div>
  );
}
