"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { shortenAddress, formatUsd, formatPercent, pnlColor } from "@/lib/utils";
import type { TraderRow } from "@/lib/api";

interface LeaderboardTableProps {
  traders: TraderRow[];
  loading: boolean;
  onSelectTrader: (address: string) => void;
  onCopyTrader: (address: string) => void;
}

export function LeaderboardTable({
  traders,
  loading,
  onSelectTrader,
  onCopyTrader,
}: LeaderboardTableProps) {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (traders.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-zinc-500">
        No traders found. Try adjusting your filters.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 bg-zinc-900/50">
            <th className="px-4 py-3 text-left font-medium text-zinc-400">#</th>
            <th className="px-4 py-3 text-left font-medium text-zinc-400">Trader</th>
            <th className="px-4 py-3 text-right font-medium text-zinc-400">Account Size</th>
            <th className="px-4 py-3 text-right font-medium text-zinc-400">Total PnL</th>
            <th className="px-4 py-3 text-right font-medium text-zinc-400">ROI</th>
            <th className="px-4 py-3 text-right font-medium text-zinc-400">Win Rate</th>
            <th className="px-4 py-3 text-right font-medium text-zinc-400">Trades</th>
            <th className="px-4 py-3 text-right font-medium text-zinc-400">Max Lev.</th>
            <th className="px-4 py-3 text-right font-medium text-zinc-400">Score</th>
            <th className="px-4 py-3 text-right font-medium text-zinc-400"></th>
          </tr>
        </thead>
        <tbody>
          {traders.map((trader, idx) => (
            <tr
              key={trader.id}
              className="border-b border-zinc-800/50 transition-colors hover:bg-zinc-800/30 cursor-pointer"
              onClick={() => onSelectTrader(trader.address)}
            >
              <td className="px-4 py-3 text-zinc-500">{trader.rank || idx + 1}</td>
              <td className="px-4 py-3">
                <span className="font-mono text-zinc-200">
                  {shortenAddress(trader.address)}
                </span>
              </td>
              <td className="px-4 py-3 text-right text-zinc-300">
                {trader.accountSize ? formatUsd(trader.accountSize) : "—"}
              </td>
              <td className={`px-4 py-3 text-right font-medium ${pnlColor(trader.totalPnl || "0")}`}>
                {trader.totalPnl ? formatUsd(trader.totalPnl) : "—"}
              </td>
              <td className={`px-4 py-3 text-right ${pnlColor(trader.roiPercent || 0)}`}>
                {trader.roiPercent != null ? formatPercent(trader.roiPercent) : "—"}
              </td>
              <td className="px-4 py-3 text-right text-zinc-300">
                {trader.winRate != null ? `${(trader.winRate * 100).toFixed(1)}%` : "—"}
              </td>
              <td className="px-4 py-3 text-right text-zinc-400">
                {trader.tradeCount ?? "—"}
              </td>
              <td className="px-4 py-3 text-right text-zinc-400">
                {trader.maxLeverage != null ? `${trader.maxLeverage}x` : "—"}
              </td>
              <td className="px-4 py-3 text-right">
                {trader.compositeScore != null ? (
                  <Badge variant={trader.compositeScore > 0.7 ? "default" : trader.compositeScore > 0.4 ? "warning" : "secondary"}>
                    {(trader.compositeScore * 100).toFixed(0)}
                  </Badge>
                ) : (
                  "—"
                )}
              </td>
              <td className="px-4 py-3 text-right">
                <Button
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCopyTrader(trader.address);
                  }}
                >
                  Copy
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
