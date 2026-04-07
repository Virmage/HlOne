"use client";

import type { TopTrader } from "@/lib/api";
import { formatUsd, pnlColor } from "@/lib/utils";

interface TopTradersPanelProps {
  traders: TopTrader[];
  onSelectTrader: (address: string) => void;
}

export function TopTradersPanel({ traders, onSelectTrader }: TopTradersPanelProps) {
  return (
    <div>
      <h2 className="text-[13px] font-medium text-[var(--hl-muted)] uppercase tracking-wider mb-2 px-1">
        Top Traders (30d)
      </h2>
      <div className="overflow-y-auto scroll-on-hover max-h-[calc(50vh-60px)]">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-[var(--hl-border)] text-[var(--hl-muted)]">
              <th className="py-1.5 px-2 text-left font-normal">Trader</th>
              <th className="py-1.5 px-2 text-right font-normal">30d ROI</th>
              <th className="py-1.5 px-2 text-right font-normal">PnL</th>
            </tr>
          </thead>
          <tbody>
            {traders.map((t, i) => (
              <tr
                key={t.address}
                className="border-b border-[var(--hl-border)] hover:bg-[var(--hl-surface-hover)] cursor-pointer transition-colors"
                onClick={() => onSelectTrader(t.address)}
              >
                <td className="py-1.5 px-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[var(--hl-muted)] tabular-nums w-4">{i + 1}</span>
                    <span className="text-[var(--foreground)] font-medium truncate max-w-[120px]">
                      {t.displayName}
                    </span>
                    {t.isSharp && (
                      <span className="text-[8px] px-1 py-0 rounded bg-[var(--hl-accent)] text-[var(--background)] font-bold">
                        S
                      </span>
                    )}
                  </div>
                </td>
                <td className={`py-1.5 px-2 text-right tabular-nums ${pnlColor(t.roi30d)}`}>
                  {t.roi30d >= 0 ? "+" : ""}{t.roi30d.toFixed(1)}%
                </td>
                <td className={`py-1.5 px-2 text-right tabular-nums ${pnlColor(t.totalPnl)}`}>
                  {formatUsd(t.totalPnl)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
