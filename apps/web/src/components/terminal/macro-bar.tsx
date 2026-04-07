"use client";

import type { MacroAsset } from "@/lib/api";
import { useTickerAnimation } from "@/hooks/use-ticker-animation";

interface MacroBarProps {
  macro: MacroAsset[];
  onSelectToken?: (coin: string) => void;
}

// Mapping from Yahoo Finance macro symbol → Hyperliquid HIP-3 coin
// HIP-3 coins use dex:name format (e.g., xyz:GOLD)
const MACRO_TO_HL: Record<string, string> = {
  "GC=F": "xyz:GOLD",        // Gold futures → xyz GOLD perp
  "SI=F": "xyz:SILVER",      // Silver futures → xyz SILVER perp
  "CL=F": "xyz:CL",          // WTI Crude Oil → xyz CL perp
  "BZ=F": "flx:OIL",         // Brent Oil → flx OIL perp
  "HG=F": "xyz:COPPER",      // Copper → xyz COPPER perp
  "NG=F": "xyz:NATGAS",      // Natural Gas → xyz NATGAS perp
  "PL=F": "flx:PLATINUM",    // Platinum → flx PLATINUM perp
  "^GSPC": "xyz:SP500",      // S&P 500 → xyz SP500 perp
  "^IXIC": "xyz:XYZ100",     // Nasdaq Composite → xyz XYZ100 (closest proxy)
  "^DJI": "xyz:SP500",       // Dow Jones → SP500 (best proxy)
  "EURUSD=X": "xyz:EUR",     // EUR/USD → xyz EUR perp
  "JPY=X": "xyz:JPY",        // USD/JPY → xyz JPY perp
  "^TNX": "",                 // 10Y yield — no HL equivalent, keep as display only
  "^TYX": "",                 // 30Y yield — no HL equivalent
  "^IRX": "",                 // 13W yield — no HL equivalent
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
    <div className="overflow-hidden border-b border-[var(--hl-border)]">
      <div ref={trackRef} className="flex py-1.5 px-2 gap-1.5" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} style={{ willChange: "transform", backfaceVisibility: "hidden" }}>
        {[0, 1].map((copy) => (
          <div key={copy} className="flex shrink-0 gap-1.5" aria-hidden={copy === 1}>
            <div className="ticker-chip text-[10px] font-medium text-[var(--hl-muted)] uppercase tracking-wider">
              TradFi
            </div>
            {macro.map((a) => {
              const isPositive = a.change24h >= 0;
              const hlCoin = MACRO_TO_HL[a.symbol];
              const isClickable = !!hlCoin && !!onSelectToken;

              if (isClickable) {
                return (
                  <button
                    key={`${copy}-${a.symbol}`}
                    onClick={() => onSelectToken(hlCoin)}
                    className="ticker-chip cursor-pointer"
                    title={`View ${a.name} on Hyperliquid (${hlCoin}-USDC)`}
                  >
                    <span className="font-semibold text-[var(--foreground)]">{a.name}</span>
                    <span className="text-[var(--foreground)] tabular-nums">{formatPrice(a)}</span>
                    <span className={`tabular-nums font-medium ${isPositive ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                      {isPositive ? "+" : ""}{a.change24h.toFixed(2)}%
                    </span>
                    <span className="text-[var(--hl-accent)] text-[9px] font-medium">HL</span>
                  </button>
                );
              }

              return (
                <div key={`${copy}-${a.symbol}`} className="ticker-chip">
                  <span className="font-medium text-[var(--hl-text)]">{a.name}</span>
                  <span className="text-[var(--foreground)] tabular-nums">{formatPrice(a)}</span>
                  <span className={`tabular-nums font-medium ${isPositive ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                    {isPositive ? "+" : ""}{a.change24h.toFixed(2)}%
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
