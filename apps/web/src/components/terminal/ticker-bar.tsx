"use client";

import type { TokenOverview, OptionsSnapshot, MacroAsset } from "@/lib/api";
import { useTickerAnimation } from "@/hooks/use-ticker-animation";

interface TickerBarProps {
  tokens: TokenOverview[];
  options?: Record<string, OptionsSnapshot>;
  macro?: MacroAsset[];
  onSelectToken: (coin: string) => void;
}

// Mapping from Yahoo Finance macro symbol -> Hyperliquid HIP-3 coin
const MACRO_TO_HL: Record<string, string> = {
  "GC=F": "xyz:GOLD", "SI=F": "xyz:SILVER", "CL=F": "xyz:CL", "BZ=F": "flx:OIL",
  "HG=F": "xyz:COPPER", "NG=F": "xyz:NATGAS", "PL=F": "flx:PLATINUM",
  "^GSPC": "xyz:SP500", "^IXIC": "xyz:XYZ100", "^DJI": "xyz:SP500",
  "EURUSD=X": "xyz:EUR", "JPY=X": "xyz:JPY", "^TNX": "", "^TYX": "", "^IRX": "",
};

type TickerItem = { key: string; label: string; change: number; onClick?: () => void; tag?: string };

function formatMacroPrice(a: MacroAsset): string {
  if (a.symbol.includes("TNX") || a.symbol.includes("TYX") || a.symbol.includes("IRX")) return `${a.price.toFixed(2)}%`;
  if (a.price >= 10000) return a.price.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (a.price >= 100) return a.price.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (a.price >= 1) return a.price.toFixed(2);
  return a.price.toFixed(4);
}

export function TickerBar({ tokens, options = {}, macro = [], onSelectToken }: TickerBarProps) {
  const { trackRef, onMouseEnter, onMouseLeave } = useTickerAnimation(100, true);

  // Build macro items
  const macroItems: TickerItem[] = macro.map(a => {
    const hlCoin = MACRO_TO_HL[a.symbol];
    return {
      key: `m-${a.symbol}`,
      label: `${a.name} ${formatMacroPrice(a)}`,
      change: a.change24h,
      onClick: hlCoin ? () => onSelectToken(hlCoin) : undefined,
      tag: hlCoin ? "HL" : undefined,
    };
  });

  // Build crypto items
  const TRADFI_PREFIXES = ["xyz:", "cash:", "flx:", "km:"];
  const cryptoItems: TickerItem[] = tokens
    .filter(t => !TRADFI_PREFIXES.some(p => t.coin.startsWith(p)) && t.coin !== "PAXG" && t.volume24h >= 1_000_000)
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, 20)
    .map(t => ({
      key: `c-${t.coin}`,
      label: t.displayName || (t.coin.includes(":") ? t.coin.split(":")[1] : t.coin),
      change: t.change24h,
      onClick: () => onSelectToken(t.displayName || t.coin),
    }));

  // Interleave: macro items spread among crypto items
  const items: TickerItem[] = [];
  let mi = 0, ci = 0;
  while (mi < macroItems.length || ci < cryptoItems.length) {
    // Every 3rd crypto, insert a macro
    if (ci < cryptoItems.length) items.push(cryptoItems[ci++]);
    if (ci < cryptoItems.length) items.push(cryptoItems[ci++]);
    if (mi < macroItems.length) items.push(macroItems[mi++]);
  }

  if (!items.length) return null;

  return (
    <div className="overflow-hidden border-b border-[var(--hl-border)]">
      <div ref={trackRef} className="flex py-1" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} style={{ willChange: "transform", backfaceVisibility: "hidden" }}>
        {[0, 1].map((copy) => (
          <div key={copy} className="flex shrink-0 gap-1 px-[2px]" aria-hidden={copy === 1}>
            {items.map((item) => {
              const isPositive = item.change >= 0;
              return (
                <button
                  key={`${copy}-${item.key}`}
                  onClick={item.onClick}
                  className={`flex items-center gap-1 px-2 py-0.5 rounded-md border border-[var(--hl-border)] transition-colors text-[10px] ${item.onClick ? "cursor-pointer hover:border-[var(--hl-accent)]" : ""}`}
                >
                  <span className="font-bold text-[var(--foreground)]">{item.label}</span>
                  <span className={`tabular-nums font-semibold ${isPositive ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                    {isPositive ? "+" : ""}{item.change.toFixed(2)}%
                  </span>
                  {item.tag && <span className="text-[var(--hl-accent)] text-[9px] font-medium">{item.tag}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
