"use client";

import type { PositionConcentration as PosConc } from "@/lib/api";
import { useState } from "react";

interface PositionConcentrationProps {
  data: PosConc[];
  onSelectToken: (coin: string) => void;
}

function formatUsd(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function ConcRow({ d, maxTop5, expandedCoin, onToggle, onSelectToken }: { d: PosConc; maxTop5: number; expandedCoin: string | null; onToggle: (coin: string) => void; onSelectToken: (coin: string) => void }) {
  const barWidth = (d.top5Pct / maxTop5) * 100;
  const isExpanded = expandedCoin === d.coin;
  return (
    <div>
      <div
        className="flex items-center px-2 py-1 text-[11px] border-b border-[var(--hl-border)] hover:bg-[var(--hl-surface-hover)] cursor-pointer transition-colors relative"
        onClick={(e) => { e.stopPropagation(); onToggle(d.coin); onSelectToken(d.coin); }}
      >
        <div className={`absolute inset-y-0 left-0 opacity-10 ${d.isCrowded ? "bg-[var(--hl-red)]" : "bg-[var(--hl-green)]"}`} style={{ width: `${barWidth}%` }} />
        <span className="font-medium text-[var(--foreground)] w-12 relative z-10 flex items-center gap-1">
          {d.coin}
          {d.isCrowded && <span className="w-1.5 h-1.5 rounded-full bg-[var(--hl-red)]" title="Crowded" />}
        </span>
        <span className="text-[var(--foreground)] tabular-nums flex-1 relative z-10">
          {d.top5Pct.toFixed(1)}%
          <span className="text-[var(--hl-muted)] text-[9px] ml-1">({d.topHolders.length} holders)</span>
        </span>
        <span className={`tabular-nums w-14 text-right relative z-10 ${d.longPct > 65 ? "text-[var(--hl-green)]" : d.longPct < 35 ? "text-[var(--hl-red)]" : "text-[var(--hl-muted)]"}`}>{d.longPct}%</span>
        <span className={`tabular-nums w-12 text-right relative z-10 ${d.herfindahl > 0.3 ? "text-[var(--hl-red)]" : "text-[var(--hl-muted)]"}`}>{d.herfindahl.toFixed(2)}</span>
        <span className="text-[var(--hl-muted)] tabular-nums w-14 text-right relative z-10 text-[10px]">{formatUsd(d.totalOI)}</span>
      </div>
      {isExpanded && d.topHolders.length > 0 && (
        <div className="bg-[var(--hl-surface)] border-b border-[var(--hl-border)]">
          {d.topHolders.map((h, i) => (
            <div key={i} className="flex items-center px-4 py-0.5 text-[10px] text-[var(--hl-muted)]">
              <span className="w-4 text-[var(--hl-border)]">{i + 1}.</span>
              <span className="flex-1 truncate">{h.displayName}</span>
              <span className={`w-10 ${h.side === "long" ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>{h.side}</span>
              <span className="w-14 text-right tabular-nums">{formatUsd(h.positionValue)}</span>
              <span className="w-10 text-right tabular-nums">{h.leverage}x</span>
              <span className="w-10 text-right tabular-nums">{h.pctOfOI}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function PositionConcentrationPanel({ data, onSelectToken }: PositionConcentrationProps) {
  const [expandedCoin, setExpandedCoin] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  if (!data.length) {
    return (
      <div className="flex h-32 items-center justify-center text-[var(--hl-muted)] text-[12px]">
        Loading concentration data...
      </div>
    );
  }

  const maxTop5 = Math.max(...data.map(d => d.top5Pct), 1);
  const toggleCoin = (coin: string) => setExpandedCoin(expandedCoin === coin ? null : coin);

  const header = (
    <div className="flex items-center px-2 py-1 text-[10px] text-[var(--hl-muted)] uppercase tracking-wider border-b border-[var(--hl-border)]">
      <span className="w-12">Token</span>
      <span className="flex-1">Top 5 %</span>
      <span className="w-14 text-right">Long%</span>
      <span className="w-12 text-right">HHI</span>
      <span className="w-14 text-right">Total OI</span>
    </div>
  );

  return (
    <div>
      <div className="cursor-pointer" onClick={() => setModalOpen(true)}>
        <h2 className="text-[13px] font-medium text-[var(--hl-accent)] uppercase tracking-wider mb-2 px-1">
          Position Concentration
        </h2>
        <div className="space-y-0">
          {header}
          <div className="overflow-hidden">
            {data.slice(0, 8).map((d) => (
              <ConcRow key={d.coin} d={d} maxTop5={maxTop5} expandedCoin={expandedCoin} onToggle={toggleCoin} onSelectToken={onSelectToken} />
            ))}
          </div>
        </div>
        {data.length > 8 && (
          <div className="text-[10px] text-[var(--hl-muted)] text-center py-1">Click to see all {data.length} tokens</div>
        )}
      </div>
      {modalOpen && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center" onClick={() => setModalOpen(false)}>
          <div className="absolute inset-0 bg-black/50" />
          <div className="relative bg-[var(--background)] border border-[var(--hl-border)] rounded-lg shadow-2xl w-[90vw] max-w-[700px] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-3 border-b border-[var(--hl-border)] shrink-0">
              <h2 className="text-[13px] font-medium text-[var(--hl-accent)] uppercase tracking-wider">Position Concentration</h2>
              <button onClick={() => setModalOpen(false)} className="text-[var(--hl-muted)] hover:text-[var(--foreground)] text-[16px]">&times;</button>
            </div>
            <div className="overflow-y-auto flex-1">
              {header}
              {data.map((d) => (
                <ConcRow key={`m-${d.coin}`} d={d} maxTop5={maxTop5} expandedCoin={expandedCoin} onToggle={toggleCoin} onSelectToken={onSelectToken} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
