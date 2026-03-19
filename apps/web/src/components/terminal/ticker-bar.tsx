"use client";

import { formatPercent } from "@/lib/utils";
import type { TokenOverview } from "@/lib/api";

interface TickerBarProps {
  tokens: TokenOverview[];
  onSelectToken: (coin: string) => void;
}

export function TickerBar({ tokens, onSelectToken }: TickerBarProps) {
  if (!tokens.length) return null;

  return (
    <div className="overflow-x-auto scrollbar-none border-b border-[var(--hl-border)] bg-[var(--hl-surface)]">
      <div className="flex gap-0 min-w-max">
        {tokens.slice(0, 25).map((t) => {
          const isPositive = t.change24h >= 0;
          const scoreColor = t.score
            ? t.score.score >= 70 ? "bg-[var(--hl-green)]"
            : t.score.score <= 30 ? "bg-[var(--hl-red)]"
            : "bg-[var(--hl-muted)]"
            : "";

          return (
            <button
              key={t.coin}
              onClick={() => onSelectToken(t.coin)}
              className="flex items-center gap-2 px-3 py-1.5 text-[11px] hover:bg-[var(--hl-surface-hover)] transition-colors border-r border-[var(--hl-border)] last:border-r-0"
            >
              <span className="font-medium text-[var(--hl-text)]">{t.coin}</span>
              <span className="text-[var(--foreground)] tabular-nums">
                ${t.price >= 1 ? t.price.toLocaleString(undefined, { maximumFractionDigits: 2 }) : t.price.toPrecision(4)}
              </span>
              <span className={`tabular-nums ${isPositive ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                {isPositive ? "+" : ""}{t.change24h.toFixed(2)}%
              </span>
              {t.score && (
                <span className={`w-1.5 h-1.5 rounded-full ${scoreColor}`} title={`CPYCAT: ${t.score.score}`} />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
