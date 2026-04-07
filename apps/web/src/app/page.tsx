"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useTerminal } from "@/hooks/use-terminal";
import { TickerBar } from "@/components/terminal/ticker-bar";
import { SharpFlowTable } from "@/components/terminal/sharp-flow-table";
import { WhaleFeed } from "@/components/terminal/whale-feed";
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
import { LendingRatesPanel } from "@/components/terminal/lending-rates-panel";
import { PositionConcentrationPanel } from "@/components/terminal/position-concentration";
import { PositionsPanel } from "@/components/terminal/positions-panel";
import { TraderDetailPanel } from "@/components/traders/trader-detail-panel";
import { OptionsChainModal } from "@/components/terminal/hype-options";
import { InlineOptionsChain } from "@/components/terminal/inline-options-chain";
import type { SelectedOption } from "@/components/terminal/inline-options-chain";
import { useSafeAccount } from "@/hooks/use-safe-account";

const CopyDialog = dynamic(
  () => import("@/components/traders/copy-dialog").then(mod => ({ default: mod.CopyDialog })),
  { ssr: false }
);

export default function HomePage() {
  const { data, loading, error } = useTerminal();
  const { address: walletAddress } = useSafeAccount();
  const [chartCoin, setChartCoin] = useState("BTC");
  const [selectedToken, setSelectedToken] = useState<string | null>(null);
  const [selectedTrader, setSelectedTrader] = useState<string | null>(null);
  const [copyTrader, setCopyTrader] = useState<string | null>(null);
  const [optionsChainCoin, setOptionsChainCoin] = useState<string | null>(null);
  const [tradingMode, setTradingMode] = useState<"perp" | "options">("perp");
  const [selectedOption, setSelectedOption] = useState<SelectedOption | null>(null);

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
      {/* Row 1: TradFi Macro — desktop only */}
      <div className="hidden md:block">
        <MacroBar macro={data?.macro || []} onSelectToken={handleSelectToken} />
      </div>

      {/* Row 2: Crypto Ticker — desktop only */}
      <div className="hidden md:block">
        <TickerBar
          tokens={data?.tokens || []}
          options={data?.options}
          onSelectToken={handleSelectToken}
        />
      </div>

      {/* Row 3: Market Regime + Deribit Options — desktop only */}
      <div className="hidden md:block">
        <MarketPulse
          regime={data?.regime || null}
          options={data?.options || {}}
          onSelectToken={handleSelectToken}
          onOpenOptions={(coin: string) => setOptionsChainCoin(coin)}
          avgCorrelation={data?.correlationMatrix?.avgCorrelation ?? null}
        />
      </div>

      {/* Chart / Options Chain + Trading Panel */}
      <div className="flex flex-col md:flex-row border-b border-[var(--hl-border)] overflow-hidden" style={{ minHeight: "320px" }}>
        {/* Main area: Chart or Options Chain */}
        {tradingMode === "options" ? (
          <div className="flex-1 min-w-0 h-[300px] md:h-[420px] overflow-hidden">
            <InlineOptionsChain
              coin={chartCoin.includes(":") ? chartCoin.split(":")[1] : chartCoin}
              onSelectOption={setSelectedOption}
              selectedOption={selectedOption}
              onChangeCoin={(c) => { setChartCoin(c); setSelectedOption(null); }}
            />
          </div>
        ) : (
          <>
            <div className="flex-1 min-w-0 h-[300px] md:h-[420px] overflow-hidden">
              <PriceChart
                coin={chartCoin}
                tokens={data?.tokens || []}
                onSelectToken={handleSelectToken}
                whaleAlerts={data?.whaleAlerts || []}
                liquidationBands={data?.liquidationHeatmap?.find(h => h.coin === chartCoin)?.bands}
              />
            </div>
            {/* Order Book — hidden on mobile */}
            <div className="hidden lg:block w-[180px] flex-shrink-0 h-[420px]">
              <OrderBook coin={chartCoin} />
            </div>
          </>
        )}
        {/* Trading Panel — full width on mobile, fixed on desktop */}
        <div className="w-full md:w-[280px] flex-shrink-0">
          <TradingPanel
            coin={chartCoin}
            overview={chartOverview}
            score={chartOverview?.score ?? null}
            onOpenOptionsChain={(coin) => setOptionsChainCoin(coin)}
            tradingMode={tradingMode}
            onTradingModeChange={setTradingMode}
            selectedOption={selectedOption}
            onClearOption={() => setSelectedOption(null)}
          />
        </div>
      </div>

      {/* Positions — shows when wallet connected */}
      <div className="border-b border-[var(--hl-border)] px-2 py-2">
        <PositionsPanel onSelectToken={handleSelectToken} />
      </div>

      {/* Sharps vs Squares + Funding Arb + Signals — 3 columns */}
      <SignalsPanel
        signals={data?.signals || []}
        fundingOpps={data?.fundingOpps || []}
        callout={data?.callout || null}
        onSelectToken={handleSelectToken}
      />

      {/* Mobile: App coming soon */}
      <div className="md:hidden border-t border-[var(--hl-border)] py-12 px-4 text-center">
        <div className="text-[var(--hl-muted)] text-[14px] font-medium mb-1">App coming soon.</div>
        <div className="text-[var(--hl-muted)] text-[11px] opacity-60">Full dashboard available on desktop</div>
      </div>

      {/* Main Grid — desktop only */}
      <div className="hidden md:grid grid-cols-1 lg:grid-cols-2 gap-0 lg:gap-px bg-[var(--hl-border)]">
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
            onSelectTrader={setSelectedTrader}
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

        {/* Lending & Borrowing Rates */}
        <div className="bg-[var(--background)] p-2">
          <LendingRatesPanel />
        </div>

        {/* Position Concentration */}
        <div className="bg-[var(--background)] p-2">
          <PositionConcentrationPanel
            data={data?.positionConcentration || []}
            onSelectToken={handleSelectToken}
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

      {/* Options Chain (Derive) */}
      <OptionsChainModal
        coin={optionsChainCoin || "BTC"}
        isOpen={!!optionsChainCoin}
        onClose={() => setOptionsChainCoin(null)}
      />

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
