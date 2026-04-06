"use client";

import type { TokenOverview, OptionsSnapshot } from "@/lib/api";
import { useTickerAnimation } from "@/hooks/use-ticker-animation";

interface TickerBarProps {
  tokens: TokenOverview[];
  options?: Record<string, OptionsSnapshot>;
  onSelectToken: (coin: string) => void;
}

function formatFlow(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(0)}M`;
  return `$${(value / 1e3).toFixed(0)}K`;
}

export function TickerBar({ tokens, options = {}, onSelectToken }: TickerBarProps) {
  const { trackRef, onMouseEnter, onMouseLeave } = useTickerAnimation(60, true);

  if (!tokens.length) return null;

  // Total 24h volume across all tokens = USDC flow proxy
  const totalVolume = tokens.reduce((sum, t) => sum + t.volume24h, 0);
  // Net OI = sum of all open interest (positive = capital deployed)
  const totalOI = tokens.reduce((sum, t) => sum + t.openInterest, 0);

  // Duplicate items for seamless loop
  const items = tokens.slice(0, 25);

  return (
    <div className="overflow-hidden border-b border-[var(--hl-border)] bg-[var(--hl-surface)]">
      <div ref={trackRef} className="flex" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} style={{ willChange: "transform", backfaceVisibility: "hidden" }}>
        {[0, 1].map((copy) => (
          <div key={copy} className="flex shrink-0" aria-hidden={copy === 1}>
            {/* USDC flows indicator */}
            <div className="flex items-center gap-2 px-4 py-1.5 text-[11px] whitespace-nowrap border-r border-[var(--hl-border)]">
              <span className="text-[var(--hl-muted)] font-medium">USDC Flow</span>
              <span className="text-[var(--hl-green)] tabular-nums font-medium">
                {formatFlow(totalVolume)}/24h
              </span>
              <span className="text-[var(--hl-muted)] tabular-nums text-[10px]">
                OI:{formatFlow(totalOI)}
              </span>
              <span className="text-[var(--hl-border)]">|</span>
            </div>
            {items.map((t) => {
              const isPositive = t.change24h >= 0;
              const scoreColor = t.score
                ? t.score.score >= 70 ? "bg-[var(--hl-green)]"
                : t.score.score <= 30 ? "bg-[var(--hl-red)]"
                : "bg-[var(--hl-muted)]"
                : "";
              const opts = options[t.coin];

              return (
                <button
                  key={`${copy}-${t.coin}`}
                  onClick={() => onSelectToken(t.coin)}
                  className="flex items-center gap-2 px-4 py-1.5 text-[11px] hover:bg-[var(--hl-surface-hover)] transition-colors whitespace-nowrap"
                >
                  <span className="font-medium text-[var(--hl-text)]">{t.coin.includes(":") ? t.coin.split(":")[1] : t.coin}</span>
                  <span className="text-[var(--foreground)] tabular-nums" style={{ minWidth: "60px" }}>
                    ${t.price >= 1 ? t.price.toLocaleString(undefined, { maximumFractionDigits: 2 }) : t.price.toPrecision(4)}
                  </span>
                  <span className={`tabular-nums ${isPositive ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`} style={{ minWidth: "55px" }}>
                    {isPositive ? "+" : ""}{t.change24h.toFixed(2)}%
                  </span>
                  {opts && opts.dvol > 0 && (
                    <span className="text-[var(--hl-muted)] tabular-nums" title={`Deribit IV: ${opts.dvol.toFixed(0)}% | P/C: ${opts.putCallRatio.toFixed(2)} | Max Pain: $${opts.maxPain.toLocaleString()}`}>
                      IV:{opts.dvol.toFixed(0)}%
                    </span>
                  )}
                  {t.score && (
                    <span className={`w-1.5 h-1.5 rounded-full ${scoreColor}`} title={`HLOne: ${t.score.score}`} />
                  )}
                  <span className="text-[var(--hl-border)]">|</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
