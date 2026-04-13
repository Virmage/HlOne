"use client";

import type { TopTrader } from "@/lib/api";
import { formatUsd, pnlColor } from "@/lib/utils";

interface CopyTradePanelProps {
  traders: TopTrader[];
  onSelectTrader: (address: string) => void;
  onCopy: (address: string) => void;
}

export function CopyTradePanel({ traders, onSelectTrader, onCopy }: CopyTradePanelProps) {
  if (!traders.length) {
    return (
      <div className="flex h-40 items-center justify-center text-[var(--hl-muted)] text-[12px]">
        Loading trader data...
      </div>
    );
  }

  // Sort by 30d ROI descending
  const sorted = [...traders].sort((a, b) => b.roi30d - a.roi30d);

  return (
    <div>
      <h2 className="text-[13px] font-medium text-[var(--hl-accent)] uppercase tracking-wider mb-2 px-1">
        Top Traders — Past 30 Days
      </h2>
      <p className="text-[10px] text-[var(--hl-muted)] mb-3 px-1">
        Ranked by 30-day ROI. Click a trader for details, or copy their trades directly.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-[var(--hl-border)] text-[var(--hl-muted)]">
              <th className="py-1.5 px-2 text-left font-normal w-6">#</th>
              <th className="py-1.5 px-2 text-left font-normal">Trader</th>
              <th className="py-1.5 px-2 text-right font-normal">Account</th>
              <th className="py-1.5 px-2 text-right font-normal">30d ROI</th>
              <th className="py-1.5 px-2 text-right font-normal">All-Time ROI</th>
              <th className="py-1.5 px-2 text-right font-normal">Total PnL</th>
              <th className="py-1.5 px-2 text-center font-normal">Type</th>
              <th className="py-1.5 px-2 text-right font-normal"></th>
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, 30).map((t, i) => (
              <tr
                key={t.address}
                className="border-b border-[var(--hl-border)]/50 hover:bg-[var(--hl-surface-hover)] cursor-pointer transition-colors"
                onClick={() => onSelectTrader(t.address)}
              >
                <td className="py-1.5 px-2 text-[var(--hl-muted)] tabular-nums">{i + 1}</td>
                <td className="py-1.5 px-2">
                  <span className="text-[var(--foreground)] font-medium truncate max-w-[140px] inline-block">
                    {t.displayName}
                  </span>
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums text-[var(--hl-muted)]">
                  {formatUsd(t.accountValue)}
                </td>
                <td className={`py-1.5 px-2 text-right tabular-nums font-medium ${pnlColor(t.roi30d)}`}>
                  {t.roi30d >= 0 ? "+" : ""}{t.roi30d.toFixed(1)}%
                </td>
                <td className={`py-1.5 px-2 text-right tabular-nums ${pnlColor(t.roiAllTime)}`}>
                  {t.roiAllTime >= 0 ? "+" : ""}{t.roiAllTime.toFixed(1)}%
                </td>
                <td className={`py-1.5 px-2 text-right tabular-nums ${pnlColor(t.totalPnl)}`}>
                  {formatUsd(t.totalPnl)}
                </td>
                <td className="py-1.5 px-2 text-center">
                  {t.isSharp ? (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--hl-accent)]/15 text-[var(--hl-accent)] font-bold">
                      SHARP
                    </span>
                  ) : (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--hl-surface)] text-[var(--hl-muted)]">
                      SQUARE
                    </span>
                  )}
                </td>
                <td className="py-1.5 px-2 text-right">
                  <button
                    onClick={(e) => { e.stopPropagation(); onCopy(t.address); }}
                    className="px-3 py-1 rounded text-[10px] font-medium bg-[var(--hl-accent)] text-[var(--background)] hover:brightness-110 transition-all"
                  >
                    Copy
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
