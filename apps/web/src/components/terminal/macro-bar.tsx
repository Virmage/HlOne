"use client";

import type { MacroAsset } from "@/lib/api";
import { useTickerAnimation } from "@/hooks/use-ticker-animation";

interface MacroBarProps {
  macro: MacroAsset[];
  onSelectToken?: (coin: string) => void;
}

// Mapping from Yahoo Finance macro symbol → Hyperliquid HIP-3 coin
const MACRO_TO_HL: Record<string, string> = {
  "GC=F": "xyz:GOLD",
  "SI=F": "xyz:SILVER",
  "CL=F": "xyz:CL",
  "BZ=F": "flx:OIL",
  "HG=F": "xyz:COPPER",
  "NG=F": "xyz:NATGAS",
  "PL=F": "flx:PLATINUM",
  "^GSPC": "xyz:SP500",
  "^IXIC": "xyz:XYZ100",
  "^DJI": "xyz:SP500",
  "EURUSD=X": "xyz:EUR",
  "JPY=X": "xyz:JPY",
  "^TNX": "",
  "^TYX": "",
  "^IRX": "",
};

function formatPrice(a: MacroAsset): string {
  if (a.symbol.includes("TNX") || a.symbol.includes("TYX") || a.symbol.includes("IRX")) {
    return `${a.price.toFixed(2)}%`;
  }
  if (a.price >= 10000) return a.price.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (a.price >= 100) return a.price.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (a.price >= 1) return a.price.toFixed(2);
  return a.price.toFixed(4);
}

const badgeBase = "flex items-center gap-1 px-2 py-0.5 rounded-md border border-[var(--hl-border)] transition-colors text-[10px]";
const badgeHover = "hover:border-[var(--hl-accent)] cursor-pointer";

export function MacroBar({ macro, onSelectToken }: MacroBarProps) {
  const { trackRef, onMouseEnter, onMouseLeave } = useTickerAnimation(90, false);

  if (!macro.length) return null;

  return (
    <div className="overflow-hidden border-b border-[var(--hl-border)]">
      <div ref={trackRef} className="flex py-1 px-2 gap-1" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} style={{ willChange: "transform", backfaceVisibility: "hidden" }}>
        {[0, 1].map((copy) => (
          <div key={copy} className="flex shrink-0 gap-1" aria-hidden={copy === 1}>
            {macro.map((a) => {
              const isPositive = a.change24h >= 0;
              const hlCoin = MACRO_TO_HL[a.symbol];
              const isClickable = !!hlCoin && !!onSelectToken;

              return (
                <button
                  key={`${copy}-${a.symbol}`}
                  onClick={() => isClickable && onSelectToken!(hlCoin)}
                  className={`${badgeBase} ${isClickable ? badgeHover : ""}`}
                  title={isClickable ? `View ${a.name} on Hyperliquid (${hlCoin}-USDC)` : undefined}
                >
                  <span className="font-bold text-[var(--foreground)]">{a.name}</span>
                  <span className="text-[var(--hl-muted)] tabular-nums">{formatPrice(a)}</span>
                  <span className={`tabular-nums font-semibold ${isPositive ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                    {isPositive ? "+" : ""}{a.change24h.toFixed(2)}%
                  </span>
                  {isClickable && <span className="text-[var(--hl-accent)] text-[9px] font-medium">HL</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
