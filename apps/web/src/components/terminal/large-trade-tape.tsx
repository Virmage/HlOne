"use client";

import { useState } from "react";
import type { LargeTrade } from "@/lib/api";

interface LargeTradeTapeProps {
  trades: LargeTrade[];
  onSelectToken: (coin: string) => void;
}

function formatSize(usd: number): string {
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(1)}M`;
  if (usd >= 1e3) return `$${(usd / 1e3).toFixed(0)}K`;
  return `$${usd.toFixed(0)}`;
}

function timeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

function TradeRow({ t, onSelectToken }: { t: LargeTrade; onSelectToken: (coin: string) => void }) {
  const isBuy = t.side === "buy";
  return (
    <div
      className="grid grid-cols-[1fr_50px_80px_1fr_50px] items-center px-2 py-1 text-[11px] border-b border-[var(--hl-border)] hover:bg-[var(--hl-surface-hover)] cursor-pointer transition-colors"
      onClick={() => onSelectToken(t.coin)}
    >
      <span className="font-medium text-[var(--foreground)]">{t.coin.includes(":") ? t.coin.split(":")[1] : t.coin}</span>
      <span className={`font-medium ${isBuy ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
        {isBuy ? "BUY" : "SELL"}
      </span>
      <span className={`tabular-nums font-medium text-right ${isBuy ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
        {formatSize(t.sizeUsd)}
      </span>
      <span className="text-[var(--hl-muted)] tabular-nums text-right">
        ${t.price >= 1 ? t.price.toLocaleString(undefined, { maximumFractionDigits: 2 }) : t.price.toPrecision(4)}
      </span>
      <span className="text-[var(--hl-muted)] tabular-nums text-right text-[10px]">
        {timeAgo(t.time)}
      </span>
    </div>
  );
}

export function LargeTradeTape({ trades, onSelectToken }: LargeTradeTapeProps) {
  const [expanded, setExpanded] = useState(false);

  if (!trades.length) {
    return (
      <div className="flex h-32 items-center justify-center text-[var(--hl-muted)] text-[11px]">
        Loading trade tape...
      </div>
    );
  }

  const INLINE_LIMIT = 15;
  const visibleTrades = expanded ? trades : trades.slice(0, INLINE_LIMIT);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex flex-col h-full min-h-0 cursor-pointer" onClick={() => setExpanded(true)}>
        <h2 className="text-[13px] font-medium text-[var(--hl-accent)] uppercase tracking-wider mb-2 px-1 shrink-0">
          Large Trades (&gt;$25K)
        </h2>
        <div className="overflow-y-auto flex-1 min-h-0">
          {visibleTrades.map((t, i) => (
            <TradeRow key={`${t.hash}-${i}`} t={t} onSelectToken={onSelectToken} />
          ))}
        </div>
        {trades.length > 8 && (
          <div className="text-[10px] text-[var(--hl-muted)] text-center py-1 shrink-0">Click to see all {trades.length} trades</div>
        )}
      </div>
      {expanded && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center" onClick={() => setExpanded(false)}>
          <div className="absolute inset-0 bg-black/50" />
          <div className="relative bg-[var(--background)] border border-[var(--hl-border)] rounded-lg shadow-2xl w-[90vw] max-w-[700px] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-3 border-b border-[var(--hl-border)] shrink-0">
              <h2 className="text-[13px] font-medium text-[var(--hl-accent)] uppercase tracking-wider">Large Trades</h2>
              <button onClick={() => setExpanded(false)} className="text-[var(--hl-muted)] hover:text-[var(--foreground)] text-[16px]">&times;</button>
            </div>
            <div className="overflow-y-auto flex-1">
              {trades.map((t, i) => (
                <TradeRow key={`exp-${t.hash}-${i}`} t={t} onSelectToken={onSelectToken} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
