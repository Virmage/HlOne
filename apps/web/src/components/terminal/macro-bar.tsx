"use client";

import type { MacroAsset } from "@/lib/api";
import { useTickerAnimation } from "@/hooks/use-ticker-animation";

interface MacroBarProps {
  macro: MacroAsset[];
  onSelectToken?: (coin: string) => void;
}

// Mapping from macro symbol → Hyperliquid perp coin name
// Only include assets that actually have HL perps
const MACRO_TO_HL: Record<string, string> = {
  "GC=F": "GOLD",       // Gold → kGOLD / GOLD perp
  "SI=F": "SILVER",     // Silver → SILVER perp
  "CL=F": "WTIOIL",     // WTI Oil → WTIOIL perp
  // Note: SPX on HL is a memecoin, NOT the real S&P 500
  // "^GSPC": "SPX" — intentionally NOT mapped
};

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

export function MacroBar({ macro, onSelectToken }: MacroBarProps) {
  const { trackRef, onMouseEnter, onMouseLeave } = useTickerAnimation(90, false);

  if (!macro.length) return null;

  return (
    <div className="overflow-hidden border-b border-[var(--hl-border)] bg-[var(--hl-surface)]">
      <div ref={trackRef} className="flex" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} style={{ willChange: "transform", backfaceVisibility: "hidden" }}>
        {[0, 1].map((copy) => (
          <div key={copy} className="flex shrink-0" aria-hidden={copy === 1}>
            <div className="flex items-center gap-1.5 px-3 py-1 text-[10px] font-medium text-[var(--hl-muted)] uppercase tracking-wider whitespace-nowrap border-r border-[var(--hl-border)]">
              TradFi
            </div>
            {macro.map((a) => {
              const isPositive = a.change24h >= 0;
              const hlCoin = MACRO_TO_HL[a.symbol];
              const isClickable = !!hlCoin && !!onSelectToken;

              const content = (
                <>
                  <span className={`font-medium ${isClickable ? "text-[var(--foreground)]" : "text-[var(--hl-text)]"}`}>
                    {a.name}
                  </span>
                  <span className="text-[var(--foreground)] tabular-nums">
                    {formatPrice(a)}
                  </span>
                  <span className={`tabular-nums ${isPositive ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                    {isPositive ? "+" : ""}{a.change24h.toFixed(2)}%
                  </span>
                  {isClickable && (
                    <span className="text-[var(--hl-green)] text-[9px] font-medium">HL</span>
                  )}
                  <span className="text-[var(--hl-border)]">|</span>
                </>
              );

              if (isClickable) {
                return (
                  <button
                    key={`${copy}-${a.symbol}`}
                    onClick={() => onSelectToken(hlCoin)}
                    className="flex items-center gap-1.5 px-3 py-1 text-[11px] whitespace-nowrap hover:bg-[var(--hl-surface-hover)] transition-colors"
                    title={`View ${a.name} on Hyperliquid (${hlCoin}-USDC)`}
                  >
                    {content}
                  </button>
                );
              }

              return (
                <div
                  key={`${copy}-${a.symbol}`}
                  className="flex items-center gap-1.5 px-3 py-1 text-[11px] whitespace-nowrap"
                >
                  {content}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
