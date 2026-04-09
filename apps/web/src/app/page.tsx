"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import dynamic from "next/dynamic";
import { useTerminal } from "@/hooks/use-terminal";
import { TickerBar } from "@/components/terminal/ticker-bar";
import { MarketPulse } from "@/components/terminal/market-pulse";
import { PriceChart } from "@/components/terminal/price-chart";
import { TradingPanel } from "@/components/terminal/trading-panel";
import { OrderBook } from "@/components/terminal/order-book";
import { MacroBar } from "@/components/terminal/macro-bar";
import { PositionsPanel } from "@/components/terminal/positions-panel";
import type { SelectedOption } from "@/components/terminal/inline-options-chain";
import { useSafeAccount } from "@/hooks/use-safe-account";

/* ── PanelSkeleton: placeholder while lazy panels load ────────────────────── */
function PanelSkeleton() {
  return <div className="h-[200px] animate-pulse bg-[var(--hl-surface)]" />;
}

/* ── Below-fold panels (lazy, code-split) ─────────────────────────────────── */
const SharpFlowTable = dynamic(
  () => import("@/components/terminal/sharp-flow-table").then(m => ({ default: m.SharpFlowTable })),
  { ssr: false, loading: () => <PanelSkeleton /> }
);
const WhaleFeed = dynamic(
  () => import("@/components/terminal/whale-feed").then(m => ({ default: m.WhaleFeed })),
  { ssr: false, loading: () => <PanelSkeleton /> }
);
const SignalsPanel = dynamic(
  () => import("@/components/terminal/signals-panel").then(m => ({ default: m.SignalsPanel })),
  { ssr: false, loading: () => <PanelSkeleton /> }
);
const NewsFeed = dynamic(
  () => import("@/components/terminal/news-feed").then(m => ({ default: m.NewsFeed })),
  { ssr: false, loading: () => <PanelSkeleton /> }
);
const SocialPanel = dynamic(
  () => import("@/components/terminal/social-panel").then(m => ({ default: m.SocialPanel })),
  { ssr: false, loading: () => <PanelSkeleton /> }
);
const FundingLeaderboardPanel = dynamic(
  () => import("@/components/terminal/funding-leaderboard").then(m => ({ default: m.FundingLeaderboardPanel })),
  { ssr: false, loading: () => <PanelSkeleton /> }
);
const LargeTradeTape = dynamic(
  () => import("@/components/terminal/large-trade-tape").then(m => ({ default: m.LargeTradeTape })),
  { ssr: false, loading: () => <PanelSkeleton /> }
);
const LendingRatesPanel = dynamic(
  () => import("@/components/terminal/lending-rates-panel").then(m => ({ default: m.LendingRatesPanel })),
  { ssr: false, loading: () => <PanelSkeleton /> }
);
const PositionConcentrationPanel = dynamic(
  () => import("@/components/terminal/position-concentration").then(m => ({ default: m.PositionConcentrationPanel })),
  { ssr: false, loading: () => <PanelSkeleton /> }
);

/* ── Modals & drawers (lazy, only needed on interaction) ──────────────────── */
const TokenDrawer = dynamic(
  () => import("@/components/terminal/token-drawer").then(m => ({ default: m.TokenDrawer })),
  { ssr: false }
);
const TraderDetailPanel = dynamic(
  () => import("@/components/traders/trader-detail-panel").then(m => ({ default: m.TraderDetailPanel })),
  { ssr: false }
);
const OptionsChainModal = dynamic(
  () => import("@/components/terminal/hype-options").then(m => ({ default: m.OptionsChainModal })),
  { ssr: false }
);
const InlineOptionsChain = dynamic(
  () => import("@/components/terminal/inline-options-chain").then(m => ({ default: m.InlineOptionsChain })),
  { ssr: false }
);
const CopyDialog = dynamic(
  () => import("@/components/traders/copy-dialog").then(mod => ({ default: mod.CopyDialog })),
  { ssr: false }
);

const LOADING_LINES = [
  "Ringing House of all Finance doorbell.",
  "Considering Derive options.",
  "Getting edge from a cat in a tank.",
  "Feeling liquid.",
  "Front running whales.",
];

function LoadingScreen() {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const t = globalThis.setInterval(() => setIdx(i => (i + 1) % LOADING_LINES.length), 1600);
    return () => globalThis.clearInterval(t);
  }, []);
  return (
    <div className="fixed inset-0 z-[9999] overflow-hidden" style={{ background: '#060a0c' }}>
      <div className="absolute inset-0" style={{ background: '#060a0c' }} />
      <div className="relative flex items-center justify-center h-full w-full">
        <div className="text-center px-4 py-2 rounded" style={{ background: '#060a0c' }}>
          <div
            key={idx}
            className="text-[var(--hl-accent)] text-[14px] animate-fade-in"
          >
            {LOADING_LINES[idx]}
          </div>
        </div>
      </div>
    </div>
  );
}

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

  // Defer below-fold grid rendering until the main thread is idle
  const [showBelow, setShowBelow] = useState(false);
  useEffect(() => {
    if (!data) return;
    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      const id = (window as unknown as { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback(() => setShowBelow(true));
      return () => (window as unknown as { cancelIdleCallback: (id: number) => void }).cancelIdleCallback(id);
    } else {
      // Fallback for Safari / older browsers
      const t = setTimeout(() => setShowBelow(true), 100);
      return () => clearTimeout(t);
    }
  }, [data]);

  // Stable callbacks — prevent child re-renders
  const handleSelectToken = useCallback((coin: string) => {
    setChartCoin(coin);
  }, []);

  const handleDeepDive = useCallback((coin: string) => {
    setSelectedToken(coin);
  }, []);

  const handleSelectTrader = useCallback((addr: string) => {
    setSelectedTrader(addr);
  }, []);

  const handleCopy = useCallback((addr: string) => {
    setCopyTrader(addr);
  }, []);

  const handleOpenOptions = useCallback((coin: string) => {
    setOptionsChainCoin(coin);
  }, []);

  const handleChangeCoin = useCallback((c: string) => {
    setChartCoin(c);
    setSelectedOption(null);
  }, []);

  const handleClearCopy = useCallback((open: boolean) => {
    if (!open) setCopyTrader(null);
  }, []);

  const chartOverview = useMemo(
    () => data?.tokens?.find(t => t.coin === chartCoin || t.displayName === chartCoin) ?? null,
    [data?.tokens, chartCoin]
  );

  if (loading && !data) {
    return <LoadingScreen />;
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
          onOpenOptions={handleOpenOptions}
          avgCorrelation={data?.correlationMatrix?.avgCorrelation ?? null}
        />
      </div>

      {/* Chart + Positions (left) | Order Book + Trading Panel (right) */}
      <div className="flex flex-col md:flex-row border-b border-[var(--hl-border)]">
        {/* Left column: Chart stacked above Positions */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Chart / Options Chain */}
          <div className="border-b border-[var(--hl-border)] overflow-hidden">
            {tradingMode === "options" ? (
              <div className="h-[300px] md:h-[510px] overflow-hidden">
                <InlineOptionsChain
                  coin={chartCoin.includes(":") ? chartCoin.split(":")[1] : chartCoin}
                  onSelectOption={setSelectedOption}
                  selectedOption={selectedOption}
                  onChangeCoin={handleChangeCoin}
                />
              </div>
            ) : (
              <div className="h-[300px] md:h-[510px] overflow-hidden">
                <PriceChart
                  coin={chartCoin}
                  tokens={data?.tokens || []}
                  onSelectToken={handleSelectToken}
                  whaleAlerts={data?.whaleAlerts || []}
                  liquidationBands={data?.liquidationHeatmap?.find(h => h.coin === chartCoin)?.bands}
                />
              </div>
            )}
          </div>
          {/* Positions — below chart */}
          <div className="px-2">
            <PositionsPanel onSelectToken={handleSelectToken} />
          </div>
        </div>

        {/* Right column: Order Book + Trading Panel — spans chart + positions height */}
        <div className="hidden md:flex flex-shrink-0 border-l border-[var(--hl-border)]">
          {/* Order Book */}
          {tradingMode !== "options" && (
            <div className="hidden lg:block w-[180px] flex-shrink-0 h-[620px] overflow-hidden border-r border-[var(--hl-border)]">
              <OrderBook coin={chartCoin} />
            </div>
          )}
          {/* Trading Panel */}
          <div className="w-[260px] flex-shrink-0 h-[620px] overflow-hidden">
            <TradingPanel
              coin={chartCoin}
              overview={chartOverview}
              score={chartOverview?.score ?? null}
              onOpenOptionsChain={handleOpenOptions}
              tradingMode={tradingMode}
              onTradingModeChange={setTradingMode}
              selectedOption={selectedOption}
              onClearOption={() => setSelectedOption(null)}
            />
          </div>
        </div>

        {/* Mobile: Trading Panel full width (only mounted on mobile) */}
        <div className="md:hidden w-full border-t border-[var(--hl-border)]">
          <TradingPanel
            coin={chartCoin}
            overview={chartOverview}
            score={chartOverview?.score ?? null}
            onOpenOptionsChain={handleOpenOptions}
            tradingMode={tradingMode}
            onTradingModeChange={setTradingMode}
            selectedOption={selectedOption}
            onClearOption={() => setSelectedOption(null)}
          />
        </div>
      </div>

      {/* Below-fold content — deferred until main thread is idle */}
      {showBelow && (
        <>
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

          {/* Main Grid — desktop only, seamless divider layout */}
          <div className="hidden md:grid grid-cols-1 lg:grid-cols-2">
            {/* Left: Sharp Flow */}
            <div className="p-3 lg:border-r border-b border-[var(--hl-border)]">
              <SharpFlowTable
                flows={data?.sharpFlow || []}
                onSelectToken={handleSelectToken}
              />
            </div>

            {/* Right: Whale Feed */}
            <div className="p-3 border-b border-[var(--hl-border)]">
              <WhaleFeed
                alerts={data?.whaleAlerts || []}
                onSelectToken={handleSelectToken}
                onSelectTrader={handleSelectTrader}
                onCopy={handleCopy}
              />
            </div>

            {/* News Feed */}
            <div className="p-3 lg:border-r border-b border-[var(--hl-border)]">
              <NewsFeed
                news={data?.news || []}
                onSelectToken={handleSelectToken}
              />
            </div>

            {/* Social Sentiment */}
            <div className="p-3 border-b border-[var(--hl-border)]">
              <SocialPanel
                social={data?.social || []}
                onSelectToken={handleSelectToken}
              />
            </div>

            {/* Funding Leaderboard */}
            <div className="p-3 lg:border-r border-b border-[var(--hl-border)]">
              <FundingLeaderboardPanel
                funding={data?.funding || { topPositive: [], topNegative: [] }}
                onSelectToken={handleSelectToken}
              />
            </div>

            {/* Large Trade Tape */}
            <div className="p-3 border-b border-[var(--hl-border)]">
              <LargeTradeTape
                trades={data?.largeTrades || []}
                onSelectToken={handleSelectToken}
              />
            </div>

            {/* Lending & Borrowing Rates */}
            <div className="p-3 lg:border-r border-b border-[var(--hl-border)]">
              <LendingRatesPanel />
            </div>

            {/* Position Concentration */}
            <div className="p-3 border-b border-[var(--hl-border)]">
              <PositionConcentrationPanel
                data={data?.positionConcentration || []}
                onSelectToken={handleSelectToken}
              />
            </div>
          </div>
        </>
      )}

      {/* Token Drawer Slide-in */}
      {selectedToken && (
        <TokenDrawer
          coin={selectedToken}
          onClose={() => setSelectedToken(null)}
          onCopy={handleCopy}
        />
      )}

      {/* Trader Detail Slide-in */}
      {selectedTrader && !selectedToken && (
        <div className="fixed inset-y-0 right-0 z-50 w-full max-w-[480px] overflow-y-auto bg-[var(--background)] border-l border-[var(--hl-border)] shadow-2xl">
          <TraderDetailPanel
            address={selectedTrader}
            onClose={() => setSelectedTrader(null)}
            onCopy={handleCopy}
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
          onOpenChange={handleClearCopy}
          traderAddress={copyTrader}
          walletAddress={walletAddress}
        />
      )}
    </div>
  );
}
