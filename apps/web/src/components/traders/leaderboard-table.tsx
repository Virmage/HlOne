"use client";

import { shortenAddress, formatUsd, formatPercent, pnlColor } from "@/lib/utils";
import type { TraderRow } from "@/lib/api";

interface Column {
  key: string;
  label: string;
  align: "left" | "right";
  sortable: boolean;
}

const columns: Column[] = [
  { key: "rank", label: "Rank", align: "left", sortable: false },
  { key: "address", label: "Trader", align: "left", sortable: false },
  { key: "accountSize", label: "Account Value", align: "right", sortable: true },
  { key: "totalPnl", label: "PnL (All-time)", align: "right", sortable: true },
  { key: "roiWeekly", label: "7d ROI", align: "right", sortable: true },
  { key: "roi30d", label: "30d ROI", align: "right", sortable: true },
  { key: "_copy", label: "", align: "right", sortable: false },
];

interface LeaderboardTableProps {
  traders: TraderRow[];
  loading: boolean;
  sortBy: string;
  sortOrder: "asc" | "desc";
  onSort: (field: string) => void;
  onSelectTrader: (address: string) => void;
  onCopyTrader: (address: string) => void;
}

export function LeaderboardTable({
  traders,
  loading,
  sortBy,
  sortOrder,
  onSort,
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

  const arrow = sortOrder === "desc" ? " \u25BC" : " \u25B2";

  return (
    <div>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-[var(--hl-border)]">
            {columns.map((col) => (
              <th
                key={col.key}
                className={`py-2.5 px-4 font-normal whitespace-nowrap ${
                  col.align === "right" ? "text-right" : "text-left"
                } ${
                  col.sortable
                    ? "cursor-pointer select-none hover:text-[var(--hl-text)] transition-colors"
                    : ""
                } ${
                  sortBy === col.key
                    ? "text-[var(--hl-text)]"
                    : "text-[var(--hl-muted)]"
                } ${col.key === "rank" ? "w-12" : ""} ${col.key === "_copy" ? "w-20" : ""}`}
                onClick={() => col.sortable && onSort(col.key)}
              >
                {col.label}
                {sortBy === col.key && arrow}
              </th>
            ))}
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
                {trader.displayName ? (
                  <div>
                    <span className="text-[var(--foreground)] text-[13px]">
                      {trader.displayName}
                    </span>
                    <span className="font-mono text-[var(--hl-muted)] text-[11px] ml-1.5">
                      {shortenAddress(trader.address, 4)}
                    </span>
                  </div>
                ) : (
                  <span className="font-mono text-[var(--foreground)] text-[13px]">
                    {shortenAddress(trader.address, 6)}
                  </span>
                )}
              </td>
              <td className="py-2.5 px-4 text-right text-[var(--hl-text)] tabular-nums">
                {trader.accountSize ? formatUsd(trader.accountSize) : "\u2014"}
              </td>
              <td className={`py-2.5 px-4 text-right tabular-nums ${pnlColor(trader.totalPnl || "0")}`}>
                {trader.totalPnl ? formatUsd(trader.totalPnl) : "\u2014"}
              </td>
              <td className={`py-2.5 px-4 text-right tabular-nums ${pnlColor(trader.roiWeekly || 0)}`}>
                {trader.roiWeekly != null ? formatPercent(trader.roiWeekly) : "\u2014"}
              </td>
              <td className={`py-2.5 px-4 text-right tabular-nums ${pnlColor(trader.roi30d || 0)}`}>
                {trader.roi30d != null ? formatPercent(trader.roi30d) : "\u2014"}
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
