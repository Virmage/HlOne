"use client";

import { useState } from "react";
import type { WhaleAccumulation } from "@/lib/api";

const displayCoin = (c: string) => c.includes(":") ? c.split(":")[1] : c;

function formatUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

interface Props {
  data: WhaleAccumulation[];
  onSelectToken: (coin: string) => void;
}

function AccumulationRow({ row, onSelectToken }: { row: WhaleAccumulation; onSelectToken: (coin: string) => void }) {
  return (
    <tr
      className="border-b border-[var(--hl-border)] hover:bg-[var(--hl-surface-hover)] cursor-pointer transition-colors"
    >
      <td className="py-1.5 px-2">
        <button
          onClick={(e) => { e.stopPropagation(); onSelectToken(row.coin); }}
          className="font-medium text-[var(--foreground)] hover:text-[var(--hl-accent)] transition-colors"
        >
          {displayCoin(row.coin)}
        </button>
      </td>
      <td className={`py-1.5 px-2 text-right tabular-nums ${row.net1h > 0 ? "text-[var(--hl-green)]" : row.net1h < 0 ? "text-[var(--hl-red)]" : "text-[var(--hl-muted)]"}`}>
        {row.net1h > 0 ? "+" : ""}{formatUsd(row.net1h)}
      </td>
      <td className={`py-1.5 px-2 text-right tabular-nums font-medium ${row.net24h > 0 ? "text-[var(--hl-green)]" : row.net24h < 0 ? "text-[var(--hl-red)]" : "text-[var(--hl-muted)]"}`}>
        {row.net24h > 0 ? "+" : ""}{formatUsd(row.net24h)}
      </td>
      <td className={`py-1.5 px-2 text-right tabular-nums ${row.net7d > 0 ? "text-[var(--hl-green)]" : row.net7d < 0 ? "text-[var(--hl-red)]" : "text-[var(--hl-muted)]"}`}>
        {row.net7d > 0 ? "+" : ""}{formatUsd(row.net7d)}
      </td>
      <td className="py-1.5 px-2 text-right tabular-nums text-[var(--hl-muted)]">{row.whales24h}</td>
      <td className="py-1.5 px-2 text-center">
        <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
          row.trend === "accumulating" ? "bg-[var(--hl-green)]/15 text-[var(--hl-green)]" :
          row.trend === "distributing" ? "bg-[var(--hl-red)]/15 text-[var(--hl-red)]" :
          "bg-[var(--hl-surface)] text-[var(--hl-muted)]"
        }`}>
          {row.trend === "accumulating" ? "ACCUM" : row.trend === "distributing" ? "DIST" : "—"}
        </span>
      </td>
    </tr>
  );
}

function AccumulationTableHead() {
  return (
    <thead>
      <tr className="border-b border-[var(--hl-border)] text-[var(--hl-muted)]">
        <th className="text-left py-1.5 px-2 font-normal">Coin</th>
        <th className="text-right py-1.5 px-2 font-normal">1h</th>
        <th className="text-right py-1.5 px-2 font-normal">24h</th>
        <th className="text-right py-1.5 px-2 font-normal">7d</th>
        <th className="text-right py-1.5 px-2 font-normal">Whales</th>
        <th className="text-center py-1.5 px-2 font-normal">Trend</th>
      </tr>
    </thead>
  );
}

export function WhaleAccumulationPanel({ data, onSelectToken }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (!data.length) {
    return (
      <div className="flex h-32 items-center justify-center text-[var(--hl-muted)] text-[11px]">
        Collecting whale data...
      </div>
    );
  }

  const INLINE_LIMIT = 15;
  const visibleData = expanded ? data : data.slice(0, INLINE_LIMIT);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex flex-col h-full min-h-0 cursor-pointer" onClick={() => data.length > INLINE_LIMIT && setExpanded(true)}>
        <h2 className="text-[13px] font-medium text-[var(--hl-accent)] uppercase tracking-wider mb-2 px-1 shrink-0">
          Whale Accumulation
        </h2>
        <div className="overflow-auto flex-1 min-h-0">
          <table className="w-full text-[11px]">
            <AccumulationTableHead />
            <tbody>
              {visibleData.map(row => (
                <AccumulationRow key={row.coin} row={row} onSelectToken={onSelectToken} />
              ))}
            </tbody>
          </table>
        </div>
        {data.length > INLINE_LIMIT && (
          <div className="text-[10px] text-[var(--hl-muted)] text-center py-1 shrink-0">Click to see all {data.length} tokens</div>
        )}
      </div>
      {expanded && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center" onClick={() => setExpanded(false)}>
          <div className="absolute inset-0 bg-black/50" />
          <div className="relative bg-[var(--background)] border border-[var(--hl-border)] rounded-lg shadow-2xl w-[90vw] max-w-[700px] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-3 border-b border-[var(--hl-border)] shrink-0">
              <h2 className="text-[13px] font-medium text-[var(--hl-accent)] uppercase tracking-wider">Whale Accumulation ({data.length} tokens)</h2>
              <button onClick={() => setExpanded(false)} className="text-[var(--hl-muted)] hover:text-[var(--foreground)] text-[16px]">&times;</button>
            </div>
            <div className="overflow-y-auto flex-1">
              <table className="w-full text-[11px]">
                <AccumulationTableHead />
                <tbody>
                  {data.map(row => (
                    <AccumulationRow key={row.coin} row={row} onSelectToken={onSelectToken} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
