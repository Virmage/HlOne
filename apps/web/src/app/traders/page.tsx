"use client";

import { useState } from "react";
import { useSafeAccount as useAccount } from "@/hooks/use-safe-account";
import { useTraders } from "@/hooks/use-traders";
import { LeaderboardTable } from "@/components/traders/leaderboard-table";
import { TraderDetailPanel } from "@/components/traders/trader-detail-panel";
import { CopyDialog } from "@/components/traders/copy-dialog";

export default function TradersPage() {
  const { address } = useAccount();
  const [sortBy, setSortBy] = useState("roi30d");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const { traders, loading, error } = useTraders({
    sortBy,
    order: sortOrder,
  });
  const [selectedTrader, setSelectedTrader] = useState<string | null>(null);
  const [copyTrader, setCopyTrader] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const handleSort = (field: string) => {
    if (field === sortBy) {
      setSortOrder((prev) => (prev === "desc" ? "asc" : "desc"));
    } else {
      setSortBy(field);
      setSortOrder("desc");
    }
  };

  const filteredTraders = search
    ? traders.filter((t) => {
        const q = search.toLowerCase();
        return t.address.toLowerCase().includes(q) ||
          (t.displayName && t.displayName.toLowerCase().includes(q));
      })
    : traders;

  return (
    <div>
      <h1 className="text-[28px] font-semibold tracking-tight mb-6">
        Leaderboard
      </h1>

      <div className="mb-5">
        <div className="relative inline-block">
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
            placeholder="Search by name or address..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 w-[280px] rounded-md border border-[var(--hl-border)] bg-[var(--hl-surface)] pl-9 pr-3 text-[13px] text-[var(--hl-text)] placeholder:text-[var(--hl-muted)] outline-none focus:border-[var(--hl-green-dim)] transition-colors"
          />
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
            sortBy={sortBy}
            sortOrder={sortOrder}
            onSort={handleSort}
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
