"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { usePortfolio } from "@/hooks/use-portfolio";
import { AccountOverview } from "@/components/portfolio/account-overview";
import { CopiedTradersList } from "@/components/portfolio/copied-traders-list";
import { OpenPositionsTable } from "@/components/portfolio/open-positions-table";
import { SuggestionsPanel } from "@/components/portfolio/suggestions-panel";
import { EditAllocationDialog } from "@/components/portfolio/edit-allocation-dialog";

export default function PortfolioPage() {
  const { address } = useAccount();
  const { data, loading, refetch } = usePortfolio(address);
  const [editingId, setEditingId] = useState<string | null>(null);

  if (!address) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <div className="text-center space-y-2">
          <h2 className="text-xl font-semibold text-zinc-300">Connect Your Wallet</h2>
          <p className="text-sm text-zinc-500">
            Connect your wallet to view your portfolio and manage copied trades
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <div className="text-zinc-400 animate-pulse">Loading portfolio...</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Portfolio</h1>
        <p className="text-sm text-zinc-400 mt-1">
          Monitor performance and manage copied trades
        </p>
      </div>

      <AccountOverview overview={data?.overview || null} />

      <SuggestionsPanel suggestions={data?.suggestions || []} />

      <CopiedTradersList
        traders={data?.copiedTraders || []}
        walletAddress={address}
        onRefresh={refetch}
        onEditAllocation={setEditingId}
      />

      <OpenPositionsTable
        positions={data?.openPositions || []}
        onRefresh={refetch}
      />

      <EditAllocationDialog
        open={!!editingId}
        onOpenChange={(open) => !open && setEditingId(null)}
        copyRelationshipId={editingId || ""}
        onSaved={refetch}
      />
    </div>
  );
}
