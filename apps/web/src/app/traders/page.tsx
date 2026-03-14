"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { useTraders } from "@/hooks/use-traders";
import { LeaderboardFilters } from "@/components/traders/leaderboard-filters";
import { LeaderboardTable } from "@/components/traders/leaderboard-table";
import { TraderDetailPanel } from "@/components/traders/trader-detail-panel";
import { CopyDialog } from "@/components/traders/copy-dialog";

export default function TradersPage() {
  const { address } = useAccount();
  const { traders, loading, error, filters, setFilters } = useTraders();
  const [selectedTrader, setSelectedTrader] = useState<string | null>(null);
  const [copyTrader, setCopyTrader] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Top Traders</h1>
        <p className="text-sm text-zinc-400 mt-1">
          Discover and copy profitable Hyperliquid traders
        </p>
      </div>

      <LeaderboardFilters filters={filters} onApply={setFilters} />

      {error && (
        <div className="rounded-md border border-red-800 bg-red-900/20 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="flex gap-4">
        <div className={selectedTrader ? "flex-1" : "w-full"}>
          <LeaderboardTable
            traders={traders}
            loading={loading}
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
