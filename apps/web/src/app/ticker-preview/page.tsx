"use client";

import { useState, useEffect } from "react";
import { getTerminalData } from "@/lib/api";
import type { TokenOverview } from "@/lib/api";
import { useTickerAnimation } from "@/hooks/use-ticker-animation";

function formatFlow(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(0)}M`;
  return `$${(value / 1e3).toFixed(0)}K`;
}

const TRADFI_PREFIXES = ["xyz:", "cash:", "flx:", "km:"];

function getItems(tokens: TokenOverview[]) {
  return tokens
    .filter(t => {
      if (TRADFI_PREFIXES.some(p => t.coin.startsWith(p))) return false;
      if (t.coin === "PAXG") return false;
      return t.volume24h >= 1_000_000;
    })
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, 25);
}

// ─── Style A: Current bubble/chip style ──────────────────────────────
function BubbleStyle({ tokens }: { tokens: TokenOverview[] }) {
  const { trackRef, onMouseEnter, onMouseLeave } = useTickerAnimation(120, false);
  const items = getItems(tokens);
  const totalVolume = tokens.reduce((sum, t) => sum + t.volume24h, 0);
  const totalOI = tokens.reduce((sum, t) => sum + t.openInterest, 0);

  return (
    <div className="overflow-hidden border-b border-[var(--hl-border)]">
      <div ref={trackRef} className="flex py-1.5 px-2 gap-1.5" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} style={{ willChange: "transform", backfaceVisibility: "hidden" }}>
        {[0, 1].map((copy) => (
          <div key={copy} className="flex shrink-0 gap-1.5" aria-hidden={copy === 1}>
            <div className="ticker-chip">
              <span className="text-[var(--hl-muted)] font-medium">USDC Flow</span>
              <span className="text-[var(--hl-accent)] tabular-nums font-medium">{formatFlow(totalVolume)}/24h</span>
              <span className="text-[var(--hl-muted)] tabular-nums text-[10px]">OI:{formatFlow(totalOI)}</span>
            </div>
            {items.map((t) => {
              const isPositive = t.change24h >= 0;
              return (
                <button key={`${copy}-${t.coin}`} className="ticker-chip cursor-pointer">
                  <span className="font-semibold text-[var(--foreground)]">{t.displayName || t.coin}</span>
                  <span className="text-[var(--hl-text)] tabular-nums">${t.price >= 1 ? t.price.toLocaleString(undefined, { maximumFractionDigits: 2 }) : t.price.toPrecision(4)}</span>
                  <span className={`tabular-nums font-medium ${isPositive ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>{isPositive ? "+" : ""}{t.change24h.toFixed(2)}%</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Style B: Flat / no bubbles — just text with separators ──────────
function FlatStyle({ tokens }: { tokens: TokenOverview[] }) {
  const { trackRef, onMouseEnter, onMouseLeave } = useTickerAnimation(100, false);
  const items = getItems(tokens);

  return (
    <div className="overflow-hidden border-b border-[var(--hl-border)]">
      <div ref={trackRef} className="flex py-1 px-2 items-center" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} style={{ willChange: "transform", backfaceVisibility: "hidden" }}>
        {[0, 1].map((copy) => (
          <div key={copy} className="flex shrink-0 items-center" aria-hidden={copy === 1}>
            {items.map((t, i) => {
              const isPositive = t.change24h >= 0;
              return (
                <button key={`${copy}-${t.coin}`} className="flex items-center gap-1.5 px-3 py-0.5 cursor-pointer hover:bg-[rgba(255,255,255,0.04)] transition-colors text-[11px]">
                  <span className="font-semibold text-[var(--foreground)]">{t.displayName || t.coin}</span>
                  <span className="text-[var(--hl-muted)] tabular-nums">${t.price >= 1 ? t.price.toLocaleString(undefined, { maximumFractionDigits: 2 }) : t.price.toPrecision(4)}</span>
                  <span className={`tabular-nums font-semibold ${isPositive ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>{isPositive ? "+" : ""}{t.change24h.toFixed(2)}%</span>
                  {i < items.length - 1 && <span className="ml-1.5 text-[var(--hl-border)]">|</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Style C: Compact badges — tighter bubbles, more data density ────
function CompactStyle({ tokens }: { tokens: TokenOverview[] }) {
  const { trackRef, onMouseEnter, onMouseLeave } = useTickerAnimation(110, false);
  const items = getItems(tokens);

  return (
    <div className="overflow-hidden border-b border-[var(--hl-border)]">
      <div ref={trackRef} className="flex py-1 px-2 gap-1" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} style={{ willChange: "transform", backfaceVisibility: "hidden" }}>
        {[0, 1].map((copy) => (
          <div key={copy} className="flex shrink-0 gap-1" aria-hidden={copy === 1}>
            {items.map((t) => {
              const isPositive = t.change24h >= 0;
              return (
                <button key={`${copy}-${t.coin}`} className="flex items-center gap-1 px-2 py-0.5 rounded-md border border-[var(--hl-border)] cursor-pointer hover:border-[var(--hl-accent)] transition-colors text-[10px]">
                  <span className="font-bold text-[var(--foreground)]">{t.displayName || t.coin}</span>
                  <span className={`tabular-nums font-semibold ${isPositive ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>{isPositive ? "+" : ""}{t.change24h.toFixed(2)}%</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function TickerPreview() {
  const [tokens, setTokens] = useState<TokenOverview[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getTerminalData()
      .then(d => setTokens(d.tokens || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-8 text-[var(--hl-muted)]">Loading...</div>;

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <div className="p-4 border-b border-[var(--hl-border)]">
        <h1 className="text-[16px] font-bold text-[var(--foreground)]">Ticker Bar Comparison</h1>
        <p className="text-[12px] text-[var(--hl-muted)] mt-1">Hover to pause scrolling</p>
      </div>

      {/* Style A */}
      <div className="mt-6">
        <div className="px-4 mb-2">
          <span className="text-[13px] font-semibold text-[var(--foreground)]">A — Current (Bubbles / Chips)</span>
          <span className="text-[11px] text-[var(--hl-muted)] ml-2">Rounded pill background, price + % + IV</span>
        </div>
        <BubbleStyle tokens={tokens} />
      </div>

      {/* Style B */}
      <div className="mt-8">
        <div className="px-4 mb-2">
          <span className="text-[13px] font-semibold text-[var(--foreground)]">B — Flat (No Bubbles)</span>
          <span className="text-[11px] text-[var(--hl-muted)] ml-2">Plain text with pipe separators, minimal</span>
        </div>
        <FlatStyle tokens={tokens} />
      </div>

      {/* Style C */}
      <div className="mt-8">
        <div className="px-4 mb-2">
          <span className="text-[13px] font-semibold text-[var(--foreground)]">C — Compact Badges</span>
          <span className="text-[11px] text-[var(--hl-muted)] ml-2">Tight bordered badges, coin + % only</span>
        </div>
        <CompactStyle tokens={tokens} />
      </div>

      {/* Spacer */}
      <div className="h-20" />
    </div>
  );
}
