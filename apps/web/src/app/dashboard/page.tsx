"use client";

import { useState } from "react";
import { useTerminal } from "@/hooks/use-terminal";
import { TickerBar } from "@/components/terminal/ticker-bar";
import { SharpFlowTable } from "@/components/terminal/sharp-flow-table";
import { WhaleFeed } from "@/components/terminal/whale-feed";
import { DivergencePanel } from "@/components/terminal/divergence-panel";
import { TopTradersPanel } from "@/components/terminal/top-traders-panel";
import { SharpSquareCalloutPanel } from "@/components/terminal/sharp-square-callout";
import { MarketPulse } from "@/components/terminal/market-pulse";
import { TokenDrawer } from "@/components/terminal/token-drawer";
import { TraderDetailPanel } from "@/components/traders/trader-detail-panel";
import { CopyDialog } from "@/components/traders/copy-dialog";
import { useAccount } from "wagmi";

export default function DashboardPage() {
  const { data, loading, error } = useTerminal();
  const { address: walletAddress } = useAccount();
  const [selectedToken, setSelectedToken] = useState<string | null>(null);
  const [selectedTrader, setSelectedTrader] = useState<string | null>(null);
  const [copyTrader, setCopyTrader] = useState<string | null>(null);

  if (loading && !data) {
    return (
      <div className="flex h-[80vh] items-center justify-center">
        <div className="text-center">
          <div className="text-[var(--hl-muted)] text-[14px] mb-2">Loading terminal data...</div>
          <div className="text-[var(--hl-muted)] text-[11px]">Analyzing 32K+ traders across Hyperliquid</div>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex h-[80vh] items-center justify-center">
        <div className="rounded-md border border-[#f058581a] bg-[#f058580d] px-6 py-4 text-[13px] text-[var(--hl-red)]">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="-mx-4 sm:-mx-6 lg:-mx-8 -mt-6">
      {/* Ticker Bar */}
      <TickerBar
        tokens={data?.tokens || []}
        options={data?.options}
        onSelectToken={setSelectedToken}
      />

      {/* Sharps vs Squares Callout */}
      <SharpSquareCalloutPanel
        callout={data?.callout || null}
        onSelectToken={setSelectedToken}
      />

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-0 lg:gap-px bg-[var(--hl-border)]">
        {/* Top Left: Sharp Flow */}
        <div className="bg-[var(--background)] p-3">
          <SharpFlowTable
            flows={data?.sharpFlow || []}
            onSelectToken={setSelectedToken}
          />
        </div>

        {/* Top Right: Whale Feed */}
        <div className="bg-[var(--background)] p-3">
          <WhaleFeed
            alerts={data?.whaleAlerts || []}
            onSelectToken={setSelectedToken}
            onCopy={setCopyTrader}
          />
        </div>

        {/* Bottom Left: Divergence Signals */}
        <div className="bg-[var(--background)] p-3">
          <DivergencePanel
            divergences={data?.divergences || []}
            onSelectToken={setSelectedToken}
          />
        </div>

        {/* Bottom Right: Top Traders */}
        <div className="bg-[var(--background)] p-3">
          <TopTradersPanel
            traders={data?.topTraders || []}
            onSelectTrader={setSelectedTrader}
          />
        </div>
      </div>

      {/* Market Pulse — full width module */}
      <div className="border-t border-[var(--hl-border)]">
        <MarketPulse
          signals={data?.signals || []}
          fundingOpps={data?.fundingOpps || []}
          regime={data?.regime || null}
          options={data?.options || {}}
          onSelectToken={setSelectedToken}
        />
      </div>

      {/* Token Drawer Slide-in */}
      {selectedToken && (
        <TokenDrawer
          coin={selectedToken}
          onClose={() => setSelectedToken(null)}
          onCopy={setCopyTrader}
        />
      )}

      {/* Trader Detail Slide-in */}
      {selectedTrader && !selectedToken && (
        <div className="fixed inset-y-0 right-0 z-50 w-full max-w-[480px] overflow-y-auto bg-[var(--background)] border-l border-[var(--hl-border)] shadow-2xl">
          <TraderDetailPanel
            address={selectedTrader}
            onClose={() => setSelectedTrader(null)}
            onCopy={setCopyTrader}
          />
        </div>
      )}

      {/* Copy Dialog */}
      <CopyDialog
        open={!!copyTrader}
        onOpenChange={(open) => !open && setCopyTrader(null)}
        traderAddress={copyTrader || ""}
        walletAddress={walletAddress}
      />
    </div>
  );
}
