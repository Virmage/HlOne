"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { useTraders } from "@/hooks/use-traders";
import { LeaderboardTable } from "@/components/traders/leaderboard-table";
import { TraderDetailPanel } from "@/components/traders/trader-detail-panel";
import { CopyDialog } from "@/components/traders/copy-dialog";

export default function TradersPage() {
  const { address } = useAccount();
  const { traders, loading, error, filters, setFilters } = useTraders({
    sortBy: "winRate",
    order: "desc",
  });
  const [selectedTrader, setSelectedTrader] = useState<string | null>(null);
  const [copyTrader, setCopyTrader] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const filteredTraders = search
    ? traders.filter((t) =>
        t.address.toLowerCase().includes(search.toLowerCase())
      )
    : traders;

  return (
    <div>
      <h1 className="text-[28px] font-semibold tracking-tight mb-6">
        Leaderboard
      </h1>

      <div className="flex items-center justify-between mb-5">
        <div className="relative">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--hl-muted)]"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="text"
            placeholder="Search by wallet address..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 w-[280px] rounded-md border border-[var(--hl-border)] bg-[var(--hl-surface)] pl-9 pr-3 text-[13px] text-[var(--hl-text)] placeholder:text-[var(--hl-muted)] outline-none focus:border-[var(--hl-green-dim)] transition-colors"
          />
        </div>

        <div className="flex items-center gap-2">
          <select
            value={filters.sortBy || "winRate"}
            onChange={(e) =>
              setFilters({ ...filters, sortBy: e.target.value, order: "desc" })
            }
            className="h-9 rounded-md border border-[var(--hl-border)] bg-[var(--hl-surface)] px-3 text-[13px] text-[var(--hl-text)] outline-none cursor-pointer appearance-none pr-8 focus:border-[var(--hl-green-dim)] transition-colors"
            style={{
              backgroundImage: `url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1L5 5L9 1' stroke='%236e7181' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
              backgroundRepeat: "no-repeat",
              backgroundPosition: "right 10px center",
            }}
          >
            <option value="winRate">Win Rate</option>
            <option value="totalPnl">PnL (All-time)</option>
            <option value="roiPercent">ROI (All-time)</option>
            <option value="accountSize">Account Value</option>
            <option value="tradeCount">Trade Count</option>
          </select>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-[#f058581a] bg-[#f058580d] px-4 py-2.5 text-[13px] text-[var(--hl-red)] mb-4">
          {error}
        </div>
      )}

      <div className="flex gap-4">
        <div className={selectedTrader ? "flex-1 min-w-0" : "w-full"}>
          <LeaderboardTable
            traders={filteredTraders}
            loading={loading}
            sortBy={filters.sortBy || "winRate"}
            onSelectTrader={setSelectedTrader}
            onCopyTrader={setCopyTrader}
          />
        </div>

        {selectedTrader && (
          <TraderDetailPanel
            address={selectedTrader}
            onClose={() => setSelectedTrader(null)}
            onCopy={setCopyTrader}
          />
        )}
      </div>

      <CopyDialog
        open={!!copyTrader}
        onOpenChange={(open) => !open && setCopyTrader(null)}
        traderAddress={copyTrader || ""}
        walletAddress={address}
      />
    </div>
  );
}
