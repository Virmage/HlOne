"use client";

import { shortenAddress, formatUsd, formatPercent, pnlColor } from "@/lib/utils";
import type { TraderRow } from "@/lib/api";

interface LeaderboardTableProps {
  traders: TraderRow[];
  loading: boolean;
  sortBy: string;
  onSelectTrader: (address: string) => void;
  onCopyTrader: (address: string) => void;
}

export function LeaderboardTable({
  traders,
  loading,
  sortBy,
  onSelectTrader,
  onCopyTrader,
}: LeaderboardTableProps) {
  if (loading) {
    return (
      <div className="space-y-0">
        {Array.from({ length: 10 }).map((_, i) => (
          <div
            key={i}
            className="h-[44px] border-b border-[var(--hl-border)] animate-pulse"
          >
            <div className="h-full flex items-center gap-8 px-4">
              <div className="h-3 w-6 rounded bg-[var(--hl-surface-hover)]" />
              <div className="h-3 w-24 rounded bg-[var(--hl-surface-hover)]" />
              <div className="h-3 w-20 rounded bg-[var(--hl-surface-hover)] ml-auto" />
              <div className="h-3 w-20 rounded bg-[var(--hl-surface-hover)]" />
              <div className="h-3 w-16 rounded bg-[var(--hl-surface-hover)]" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (traders.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-[var(--hl-muted)] text-[14px]">
        No traders found.
      </div>
    );
  }

  return (
    <div>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-[var(--hl-border)]">
            <th className="py-2.5 px-4 text-left font-normal text-[var(--hl-muted)] w-12">
              Rank
            </th>
            <th className="py-2.5 px-4 text-left font-normal text-[var(--hl-muted)]">
              Trader
            </th>
            <th className="py-2.5 px-4 text-right font-normal text-[var(--hl-muted)]">
              Account Value
            </th>
            <th className="py-2.5 px-4 text-right font-normal text-[var(--hl-muted)]">
              PnL (All-time)
            </th>
            <th className="py-2.5 px-4 text-right font-normal text-[var(--hl-muted)]">
              {sortBy === "winRate" ? (
                <span className="text-[var(--hl-text)]">Win Rate &#9660;</span>
              ) : (
                "Win Rate"
              )}
            </th>
            <th className="py-2.5 px-4 text-right font-normal text-[var(--hl-muted)]">
              ROI
            </th>
            <th className="py-2.5 px-4 text-right font-normal text-[var(--hl-muted)]">
              Trades
            </th>
            <th className="py-2.5 px-4 text-right font-normal text-[var(--hl-muted)] w-20">
            </th>
          </tr>
        </thead>
        <tbody>
          {traders.map((trader, idx) => (
            <tr
              key={trader.id}
              className="border-b border-[var(--hl-border)] transition-colors hover:bg-[var(--hl-surface-hover)] cursor-pointer group"
              onClick={() => onSelectTrader(trader.address)}
            >
              <td className="py-2.5 px-4 text-[var(--hl-muted)] tabular-nums">
                {trader.rank || idx + 1}
              </td>
              <td className="py-2.5 px-4">
                <span className="font-mono text-[var(--foreground)] text-[13px]">
                  {shortenAddress(trader.address, 6)}
                </span>
              </td>
              <td className="py-2.5 px-4 text-right text-[var(--hl-text)] tabular-nums">
                {trader.accountSize ? formatUsd(trader.accountSize) : "—"}
              </td>
              <td className={`py-2.5 px-4 text-right tabular-nums ${pnlColor(trader.totalPnl || "0")}`}>
                {trader.totalPnl ? formatUsd(trader.totalPnl) : "—"}
              </td>
              <td className="py-2.5 px-4 text-right tabular-nums">
                {trader.winRate != null ? (
                  <span className={trader.winRate >= 0.5 ? "text-[var(--hl-green)]" : "text-[var(--hl-text)]"}>
                    {(trader.winRate * 100).toFixed(2)}%
                  </span>
                ) : (
                  "—"
                )}
              </td>
              <td className={`py-2.5 px-4 text-right tabular-nums ${pnlColor(trader.roiPercent || 0)}`}>
                {trader.roiPercent != null ? formatPercent(trader.roiPercent) : "—"}
              </td>
              <td className="py-2.5 px-4 text-right text-[var(--hl-muted)] tabular-nums">
                {trader.tradeCount?.toLocaleString() ?? "—"}
              </td>
              <td className="py-2.5 px-4 text-right">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onCopyTrader(trader.address);
                  }}
                  className="opacity-0 group-hover:opacity-100 transition-opacity px-3 py-1 rounded text-[12px] font-medium bg-[var(--hl-green)] text-[var(--background)] hover:brightness-110"
                >
                  Copy
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex items-center justify-end py-3 px-4 text-[12px] text-[var(--hl-muted)]">
        1-{traders.length} of {traders.length}
      </div>
    </div>
  );
}
