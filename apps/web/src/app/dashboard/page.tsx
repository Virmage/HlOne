"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useTerminal } from "@/hooks/use-terminal";
import { TickerBar } from "@/components/terminal/ticker-bar";
import { SharpFlowTable } from "@/components/terminal/sharp-flow-table";
import { WhaleFeed } from "@/components/terminal/whale-feed";
import { DivergencePanel } from "@/components/terminal/divergence-panel";
import { TopTradersPanel } from "@/components/terminal/top-traders-panel";
import { MarketPulse } from "@/components/terminal/market-pulse";
import { SignalsPanel } from "@/components/terminal/signals-panel";
import { PriceChart } from "@/components/terminal/price-chart";
import { TradingPanel } from "@/components/terminal/trading-panel";
import { OrderBook } from "@/components/terminal/order-book";
import { TokenDrawer } from "@/components/terminal/token-drawer";
import { NewsFeed } from "@/components/terminal/news-feed";
import { SocialPanel } from "@/components/terminal/social-panel";
import { FundingLeaderboardPanel } from "@/components/terminal/funding-leaderboard";
import { LargeTradeTape } from "@/components/terminal/large-trade-tape";
import { MacroBar } from "@/components/terminal/macro-bar";
import { OIPanel } from "@/components/terminal/oi-panel";
import { VolIVPanel } from "@/components/terminal/vol-iv-panel";
import { TraderDetailPanel } from "@/components/traders/trader-detail-panel";
import { useSafeAccount } from "@/hooks/use-safe-account";

const CopyDialog = dynamic(
  () => import("@/components/traders/copy-dialog").then(mod => ({ default: mod.CopyDialog })),
  { ssr: false }
);

export default function DashboardPage() {
  const { data, loading, error } = useTerminal();
  const { address: walletAddress } = useSafeAccount();
  const [chartCoin, setChartCoin] = useState("BTC");
  const [selectedToken, setSelectedToken] = useState<string | null>(null);
  const [selectedTrader, setSelectedTrader] = useState<string | null>(null);
  const [copyTrader, setCopyTrader] = useState<string | null>(null);

  // When a token is selected from any panel, update chart
  const handleSelectToken = (coin: string) => {
    setChartCoin(coin);
  };

  // Deep-dive drawer on double-click or specific action
  const handleDeepDive = (coin: string) => {
    setSelectedToken(coin);
  };

  const chartOverview = data?.tokens?.find(t => t.coin === chartCoin) ?? null;

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
        onSelectToken={handleSelectToken}
      />

      {/* TradFi Macro Bar */}
      <MacroBar macro={data?.macro || []} />

      {/* Market Pulse — regime + Deribit options */}
      <div className="border-b border-[var(--hl-border)]">
        <MarketPulse
          regime={data?.regime || null}
          options={data?.options || {}}
          onSelectToken={handleSelectToken}
        />
      </div>

      {/* Chart + Trading Panel */}
      <div className="flex border-b border-[var(--hl-border)]" style={{ height: "420px" }}>
        {/* Chart — takes most of the width */}
        <div className="flex-1 min-w-0">
          <PriceChart
            coin={chartCoin}
            tokens={data?.tokens || []}
            onSelectToken={handleSelectToken}
            whaleAlerts={data?.whaleAlerts || []}
          />
        </div>
        {/* Order Book */}
        <div className="w-[180px] flex-shrink-0">
          <OrderBook coin={chartCoin} />
        </div>
        {/* Trading Panel — fixed width right side */}
        <div className="w-[240px] flex-shrink-0">
          <TradingPanel
            coin={chartCoin}
            overview={chartOverview}
            score={chartOverview?.score ?? null}
          />
        </div>
      </div>

      {/* Sharps vs Squares + Funding Arb + Signals — 3 columns */}
      <SignalsPanel
        signals={data?.signals || []}
        fundingOpps={data?.fundingOpps || []}
        callout={data?.callout || null}
        onSelectToken={handleSelectToken}
      />

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-0 lg:gap-px bg-[var(--hl-border)]">
        {/* Left: Sharp Flow */}
        <div className="bg-[var(--background)] p-2">
          <SharpFlowTable
            flows={data?.sharpFlow || []}
            onSelectToken={handleSelectToken}
          />
        </div>

        {/* Right: Whale Feed */}
        <div className="bg-[var(--background)] p-2">
          <WhaleFeed
            alerts={data?.whaleAlerts || []}
            onSelectToken={handleSelectToken}
            onCopy={setCopyTrader}
          />
        </div>

        {/* News Feed */}
        <div className="bg-[var(--background)] p-2">
          <NewsFeed
            news={data?.news || []}
            onSelectToken={handleSelectToken}
          />
        </div>

        {/* Social Sentiment */}
        <div className="bg-[var(--background)] p-2">
          <SocialPanel
            social={data?.social || []}
            onSelectToken={handleSelectToken}
          />
        </div>

        {/* Funding Leaderboard */}
        <div className="bg-[var(--background)] p-2">
          <FundingLeaderboardPanel
            funding={data?.funding || { topPositive: [], topNegative: [] }}
            onSelectToken={handleSelectToken}
          />
        </div>

        {/* Large Trade Tape */}
        <div className="bg-[var(--background)] p-2">
          <LargeTradeTape
            trades={data?.largeTrades || []}
            onSelectToken={handleSelectToken}
          />
        </div>

        {/* Open Interest Leaderboard */}
        <div className="bg-[var(--background)] p-2">
          <OIPanel
            tokens={data?.tokens || []}
            onSelectToken={handleSelectToken}
          />
        </div>

        {/* Volatility: IV vs Realized */}
        <div className="bg-[var(--background)] p-2">
          <VolIVPanel
            options={data?.options || {}}
            tokens={data?.tokens || []}
          />
        </div>

        {/* Divergence Signals */}
        <div className="bg-[var(--background)] p-2">
          <DivergencePanel
            divergences={data?.divergences || []}
            onSelectToken={handleSelectToken}
          />
        </div>

        {/* Top Traders */}
        <div className="bg-[var(--background)] p-2">
          <TopTradersPanel
            traders={data?.topTraders || []}
            onSelectTrader={setSelectedTrader}
          />
        </div>
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

      {/* Copy Dialog — only mount when needed to avoid wagmi hook crash */}
      {copyTrader && (
        <CopyDialog
          open={true}
          onOpenChange={(open) => !open && setCopyTrader(null)}
          traderAddress={copyTrader}
          walletAddress={walletAddress}
        />
      )}
    </div>
  );
}
