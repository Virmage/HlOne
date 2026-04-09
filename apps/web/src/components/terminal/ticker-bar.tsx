"use client";

import type { TokenOverview, OptionsSnapshot } from "@/lib/api";
import { useTickerAnimation } from "@/hooks/use-ticker-animation";

interface TickerBarProps {
  tokens: TokenOverview[];
  options?: Record<string, OptionsSnapshot>;
  onSelectToken: (coin: string) => void;
}

export function TickerBar({ tokens, options = {}, onSelectToken }: TickerBarProps) {
  const { trackRef, onMouseEnter, onMouseLeave } = useTickerAnimation(110, true); // scroll RIGHT

  if (!tokens.length) return null;

  const TRADFI_PREFIXES = ["xyz:", "cash:", "flx:", "km:"];
  const cryptoTokens = tokens
    .filter(t => {
      if (TRADFI_PREFIXES.some(p => t.coin.startsWith(p))) return false;
      if (t.coin === "PAXG") return false;
      return t.volume24h >= 1_000_000;
    })
    .sort((a, b) => b.volume24h - a.volume24h);

  const items = cryptoTokens.slice(0, 25);

  return (
    <div className="overflow-hidden border-b border-[var(--hl-border)]">
      <div ref={trackRef} className="flex py-1 px-2 gap-1" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} style={{ willChange: "transform", backfaceVisibility: "hidden" }}>
        {[0, 1].map((copy) => (
          <div key={copy} className="flex shrink-0 gap-1" aria-hidden={copy === 1}>
            {items.map((t) => {
              const isPositive = t.change24h >= 0;
              return (
                <button
                  key={`${copy}-${t.coin}`}
                  onClick={() => onSelectToken(t.displayName || t.coin)}
                  className="flex items-center gap-1 px-2 py-0.5 rounded-md border border-[var(--hl-border)] cursor-pointer hover:border-[var(--hl-accent)] transition-colors text-[10px]"
                >
                  <span className="font-bold text-[var(--foreground)]">{t.displayName || (t.coin.includes(":") ? t.coin.split(":")[1] : t.coin)}</span>
                  <span className={`tabular-nums font-semibold ${isPositive ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                    {isPositive ? "+" : ""}{t.change24h.toFixed(2)}%
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
