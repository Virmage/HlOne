"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import dynamic from "next/dynamic";
import { useTerminal } from "@/hooks/use-terminal";
import { TickerBar } from "@/components/terminal/ticker-bar";
import { MarketPulse } from "@/components/terminal/market-pulse";
import { PriceChart } from "@/components/terminal/price-chart";
import { TradingPanel } from "@/components/terminal/trading-panel";
import { OrderBook } from "@/components/terminal/order-book";
// MacroBar merged into TickerBar
import { PositionsPanel } from "@/components/terminal/positions-panel";
import type { SelectedOption } from "@/components/terminal/inline-options-chain";
import { useSafeAccount } from "@/hooks/use-safe-account";
import { useAccountInfo } from "@/hooks/use-account-info";
import { useTheme } from "@/hooks/use-theme";

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
const WhaleAccumulationPanel = dynamic(
  () => import("@/components/terminal/whale-accumulation-panel").then(m => ({ default: m.WhaleAccumulationPanel })),
  { ssr: false, loading: () => <PanelSkeleton /> }
);
const DeribitFlowPanel = dynamic(
  () => import("@/components/terminal/deribit-flow-panel").then(m => ({ default: m.DeribitFlowPanel })),
  { ssr: false, loading: () => <PanelSkeleton /> }
);
const DeriveOptionsPanel = dynamic(
  () => import("@/components/terminal/derive-options-panel").then(m => ({ default: m.DeriveOptionsPanel })),
  { ssr: false, loading: () => <PanelSkeleton /> }
);
const EcosystemPanel = dynamic(
  () => import("@/components/terminal/ecosystem-panel").then(m => ({ default: m.EcosystemPanel })),
  { ssr: false, loading: () => <PanelSkeleton /> }
);
const CopyTradePanel = dynamic(
  () => import("@/components/terminal/copy-trade-panel").then(m => ({ default: m.CopyTradePanel })),
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

/* ── Mobile tab types ────────────────────────────────────────────────────── */
type MobileTab = "perps" | "options" | "data" | "account";

const MOBILE_TABS: { key: MobileTab; label: string; icon: string }[] = [
  { key: "perps", label: "Perps", icon: "M3 3h18v18H3z" },       // chart icon placeholder
  { key: "options", label: "Options", icon: "M12 2l9 4.5v11L12 22l-9-4.5v-11z" },
  { key: "data", label: "Data", icon: "M4 6h16M4 12h16M4 18h16" },
  { key: "account", label: "Account", icon: "M12 12a5 5 0 100-10 5 5 0 000 10zm0 2c-5.33 0-8 2.67-8 4v2h16v-2c0-1.33-2.67-4-8-4z" },
];

/* ── Mobile Account Tab ──────────────────────────────────────────────────── */
function MobileAccountTab() {
  const { theme, toggleTheme } = useTheme();
  const accountInfo = useAccountInfo();
  const { address, isConnected } = useSafeAccount();

  return (
    <div className="px-4 py-4 space-y-4">
      <h2 className="text-[13px] font-medium text-[var(--hl-accent)] uppercase tracking-wider">Account</h2>

      {/* Wallet */}
      <div className="rounded-lg border border-[var(--hl-border)] bg-[var(--hl-surface)] p-3">
        <div className="text-[10px] text-[var(--hl-muted)] uppercase tracking-wider mb-2">Wallet</div>
        {isConnected && address ? (
          <div className="text-[12px] text-[var(--foreground)] font-mono">{address.slice(0, 6)}...{address.slice(-4)}</div>
        ) : (
          <div className="text-[12px] text-[var(--hl-muted)]">Not connected</div>
        )}
      </div>

      {/* Portfolio stats */}
      {accountInfo && (
        <div className="rounded-lg border border-[var(--hl-border)] bg-[var(--hl-surface)] p-3">
          <div className="text-[10px] text-[var(--hl-muted)] uppercase tracking-wider mb-2">Portfolio</div>
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: "Equity", value: `$${accountInfo.accountValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}` },
              { label: "uPnL", value: `${accountInfo.unrealizedPnl >= 0 ? "+" : ""}$${accountInfo.unrealizedPnl.toFixed(2)}`, color: accountInfo.unrealizedPnl >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]" },
              { label: "Margin Used", value: `$${accountInfo.totalMarginUsed.toLocaleString(undefined, { maximumFractionDigits: 0 })}` },
              { label: "Available", value: `$${accountInfo.withdrawable.toLocaleString(undefined, { maximumFractionDigits: 0 })}` },
              { label: "Notional", value: `$${accountInfo.totalNotional.toLocaleString(undefined, { maximumFractionDigits: 0 })}` },
              { label: "Positions", value: `${accountInfo.positionCount}` },
            ].map(s => (
              <div key={s.label}>
                <div className="text-[9px] text-[var(--hl-muted)] uppercase">{s.label}</div>
                <div className={`text-[13px] font-bold tabular-nums ${s.color || "text-[var(--foreground)]"}`}>{s.value}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Theme */}
      <div className="rounded-lg border border-[var(--hl-border)] bg-[var(--hl-surface)] p-3">
        <div className="text-[10px] text-[var(--hl-muted)] uppercase tracking-wider mb-2">Appearance</div>
        <button
          onClick={toggleTheme}
          className="flex items-center justify-between w-full py-1.5"
        >
          <span className="text-[12px] text-[var(--foreground)]">
            {theme === "dark" ? "Dark Mode" : "Light Mode"}
          </span>
          <div className="w-10 h-5 rounded-full bg-[var(--hl-border)] relative transition-colors">
            <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-[var(--hl-accent)] transition-transform ${theme === "light" ? "left-5" : "left-0.5"}`} />
          </div>
        </button>
      </div>
    </div>
  );
}

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
    <div className="fixed inset-0 z-[99999] overflow-hidden" style={{ background: '#060a0c', willChange: 'transform', transform: 'translateZ(0)' }}>
      <div className="flex items-center justify-center h-full w-full">
        <div className="text-center flex flex-col items-center">
          <img src="/portalspin.gif" alt="" className="w-28 h-28" />
          <div
            key={idx}
            className="text-[var(--hl-accent)] text-[13px] animate-fade-in -mt-1"
          >
            {LOADING_LINES[idx]}
          </div>
        </div>
      </div>
    </div>
  );
}

type DataTab = "signals" | "whales" | "options" | "hypeeco" | "newssocial" | "copytrade";

const DATA_TABS: { key: DataTab; label: string }[] = [
  { key: "signals", label: "Signals" },
  { key: "whales", label: "Whales" },
  { key: "options", label: "Options Flow" },
  { key: "hypeeco", label: "Hype Eco" },
  { key: "newssocial", label: "News & Social" },
  { key: "copytrade", label: "Copy Trade" },
];

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
  const [mobileTab, setMobileTab] = useState<MobileTab>("perps");
  const [dataTab, setDataTab] = useState<DataTab>("signals");

  // Defer below-fold grid rendering briefly after data loads
  const [showBelow, setShowBelow] = useState(false);
  useEffect(() => {
    if (!data) return;
    const t = setTimeout(() => setShowBelow(true), 150);
    return () => clearTimeout(t);
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
        <div className="rounded-md border border-[var(--hl-border)] bg-[var(--hl-surface)] px-6 py-4 text-[13px] text-[var(--hl-muted)]">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="-mx-2 sm:-mx-6 lg:-mx-8 -mt-2 sm:-mt-6 md:pb-0 pb-14">
      {/* ═══ DESKTOP: full layout (unchanged) ═══════════════════════════════ */}
      <div className="hidden md:block">
        <TickerBar tokens={data?.tokens || []} options={data?.options} macro={data?.macro || []} onSelectToken={handleSelectToken} />
        <MarketPulse regime={data?.regime || null} options={data?.options || {}} onSelectToken={handleSelectToken} onOpenOptions={handleOpenOptions} avgCorrelation={data?.correlationMatrix?.avgCorrelation ?? null} />
      </div>

      {/* Chart + Positions + Trading (desktop always, mobile only on perps tab) */}
      <div className={`${mobileTab !== "perps" ? "hidden md:flex" : "flex"} flex-col md:flex-row border-b border-[var(--hl-border)]`}>
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="border-b border-[var(--hl-border)] overflow-hidden">
            {tradingMode === "options" ? (
              <div className="h-[300px] md:h-[510px] overflow-hidden">
                <InlineOptionsChain coin={chartCoin.includes(":") ? chartCoin.split(":")[1] : chartCoin} onSelectOption={setSelectedOption} selectedOption={selectedOption} onChangeCoin={handleChangeCoin} />
              </div>
            ) : (
              <div className="h-[300px] md:h-[510px] overflow-hidden">
                <PriceChart coin={chartCoin} tokens={data?.tokens || []} onSelectToken={handleSelectToken} whaleAlerts={data?.whaleAlerts || []} liquidationBands={data?.liquidationHeatmap?.find(h => h.coin === chartCoin)?.bands} />
              </div>
            )}
          </div>
          <div className="px-2">
            <PositionsPanel onSelectToken={handleSelectToken} />
          </div>
        </div>

        {/* Desktop right column */}
        <div className="hidden md:flex flex-shrink-0 border-l border-[var(--hl-border)]">
          {tradingMode !== "options" && (
            <div className="hidden lg:block w-[180px] flex-shrink-0 overflow-y-auto border-r border-[var(--hl-border)]">
              <OrderBook coin={chartCoin} />
            </div>
          )}
          <div className="w-[260px] flex-shrink-0 overflow-y-auto">
            <TradingPanel coin={chartCoin} overview={chartOverview} score={chartOverview?.score ?? null} onOpenOptionsChain={handleOpenOptions} tradingMode={tradingMode} onTradingModeChange={setTradingMode} selectedOption={selectedOption} onClearOption={() => setSelectedOption(null)} />
          </div>
        </div>

        {/* Mobile trading panel — only on perps tab */}
        {mobileTab === "perps" && (
          <div className="md:hidden w-full border-t border-[var(--hl-border)]">
            <TradingPanel coin={chartCoin} overview={chartOverview} score={chartOverview?.score ?? null} onOpenOptionsChain={handleOpenOptions} tradingMode={tradingMode} onTradingModeChange={setTradingMode} selectedOption={selectedOption} onClearOption={() => setSelectedOption(null)} />
          </div>
        )}
      </div>

      {/* ═══ MOBILE: Options tab ═══════════════════════════════════════════ */}
      {mobileTab === "options" && (
        <div className="md:hidden">
          <div className="h-[calc(100vh-6rem)] overflow-hidden">
            <InlineOptionsChain coin={chartCoin.includes(":") ? chartCoin.split(":")[1] : chartCoin} onSelectOption={setSelectedOption} selectedOption={selectedOption} onChangeCoin={handleChangeCoin} />
          </div>
        </div>
      )}

      {/* ═══ MOBILE: Data tab ══════════════════════════════════════════════ */}
      {mobileTab === "data" && (
        <div className="md:hidden space-y-0">
          <div className="p-3 border-b border-[var(--hl-border)]">
            <SharpFlowTable flows={data?.sharpFlow || []} onSelectToken={handleSelectToken} />
          </div>
          <div className="p-3 border-b border-[var(--hl-border)]">
            <WhaleFeed alerts={data?.whaleAlerts || []} onSelectToken={handleSelectToken} onSelectTrader={handleSelectTrader} onCopy={handleCopy} />
          </div>
          <div className="p-3 border-b border-[var(--hl-border)]">
            <NewsFeed news={data?.news || []} onSelectToken={handleSelectToken} />
          </div>
          <div className="p-3 border-b border-[var(--hl-border)]">
            <LargeTradeTape trades={data?.largeTrades || []} onSelectToken={handleSelectToken} />
          </div>
          <div className="p-3 border-b border-[var(--hl-border)]">
            <FundingLeaderboardPanel funding={data?.funding || { topPositive: [], topNegative: [] }} onSelectToken={handleSelectToken} />
          </div>
          <div className="p-3 border-b border-[var(--hl-border)]">
            <SocialPanel social={data?.social || []} onSelectToken={handleSelectToken} />
          </div>
          <div className="p-3 border-b border-[var(--hl-border)]">
            <LendingRatesPanel />
          </div>
          <div className="p-3 border-b border-[var(--hl-border)]">
            <PositionConcentrationPanel data={data?.positionConcentration || []} onSelectToken={handleSelectToken} />
          </div>
        </div>
      )}

      {/* ═══ MOBILE: Account tab ═══════════════════════════════════════════ */}
      {mobileTab === "account" && (
        <div className="md:hidden">
          <MobileAccountTab />
        </div>
      )}

      {/* ═══ DESKTOP: Below-fold tabbed data ═════════════════════════════ */}
      {showBelow && (
        <div className="hidden md:block">
          {/* Tab bar */}
          <div className="flex border-b border-[var(--hl-border)] bg-[var(--background)]">
            {DATA_TABS.map(t => (
              <button
                key={t.key}
                onClick={() => setDataTab(t.key)}
                className={`px-4 py-2 text-[11px] font-medium transition-colors border-b-2 ${
                  dataTab === t.key
                    ? "text-[var(--hl-accent)] border-[var(--hl-accent)]"
                    : "text-[var(--hl-muted)] border-transparent hover:text-[var(--foreground)]"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Tab content — fixed height, no scroll — click panels to expand */}
          <div className="h-[480px]">
            {dataTab === "signals" && (
              <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-px bg-[var(--hl-border)] h-full">
                <div className="bg-[var(--background)] p-3 overflow-hidden">
                  <SharpFlowTable flows={data?.sharpFlow || []} onSelectToken={handleSelectToken} />
                </div>
                <div className="bg-[var(--background)] p-3 overflow-hidden">
                  <PositionConcentrationPanel data={data?.positionConcentration || []} onSelectToken={handleSelectToken} />
                </div>
              </div>
            )}
            {dataTab === "whales" && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-px bg-[var(--hl-border)] h-full">
                <div className="bg-[var(--background)] p-3 overflow-hidden flex flex-col">
                  <WhaleFeed alerts={data?.whaleAlerts || []} onSelectToken={handleSelectToken} onSelectTrader={handleSelectTrader} onCopy={handleCopy} />
                </div>
                <div className="bg-[var(--background)] p-3 overflow-hidden flex flex-col">
                  <LargeTradeTape trades={data?.largeTrades || []} onSelectToken={handleSelectToken} />
                </div>
                <div className="bg-[var(--background)] p-3 overflow-hidden flex flex-col">
                  <WhaleAccumulationPanel data={data?.whaleAccumulation || []} onSelectToken={handleSelectToken} />
                </div>
              </div>
            )}
            {dataTab === "options" && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-px bg-[var(--hl-border)] h-full">
                <div className="bg-[var(--background)] p-3 overflow-y-auto">
                  <DeriveOptionsPanel options={data?.options || {}} />
                </div>
                <div className="bg-[var(--background)] p-3 overflow-y-auto">
                  <DeribitFlowPanel btc={data?.deribitFlow?.btc || null} eth={data?.deribitFlow?.eth || null} />
                </div>
              </div>
            )}
            {dataTab === "hypeeco" && (
              <div className="h-full overflow-y-auto bg-[var(--background)] p-3">
                <EcosystemPanel data={data?.ecosystem || null} />
                <div className="mt-3 pt-3 border-t border-[var(--hl-border)]">
                  <LendingRatesPanel />
                </div>
              </div>
            )}
            {dataTab === "newssocial" && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-px bg-[var(--hl-border)] h-full">
                <div className="bg-[var(--background)] p-3 overflow-y-auto">
                  <NewsFeed news={data?.news || []} onSelectToken={handleSelectToken} />
                </div>
                <div className="bg-[var(--background)] p-3 overflow-y-auto">
                  <SocialPanel social={data?.social || []} onSelectToken={handleSelectToken} />
                </div>
              </div>
            )}
            {dataTab === "copytrade" && (
              <div className="h-full overflow-y-auto">
                <CopyTradePanel traders={data?.topTraders || []} onSelectTrader={handleSelectTrader} onCopy={handleCopy} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══ MOBILE: Bottom Tab Bar ════════════════════════════════════════ */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-[var(--hl-nav)] border-t border-[var(--hl-border)] flex items-center justify-around h-14">
        {MOBILE_TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setMobileTab(t.key)}
            className={`flex flex-col items-center justify-center gap-0.5 flex-1 h-full transition-colors ${
              mobileTab === t.key
                ? "text-[var(--hl-accent)]"
                : "text-[var(--hl-muted)]"
            }`}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              {t.key === "perps" && <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M7 17V13M12 17V7M17 17V11" /></>}
              {t.key === "options" && <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></>}
              {t.key === "data" && <><path d="M4 6h16M4 12h10M4 18h14" /></>}
              {t.key === "account" && <><circle cx="12" cy="8" r="4" /><path d="M5 20c0-3 3.5-5 7-5s7 2 7 5" /></>}
            </svg>
            <span className="text-[9px] font-medium">{t.label}</span>
          </button>
        ))}
      </nav>

      {/* ═══ Modals & drawers (shared) ═════════════════════════════════════ */}
      {selectedToken && <TokenDrawer coin={selectedToken} onClose={() => setSelectedToken(null)} onCopy={handleCopy} />}
      {selectedTrader && !selectedToken && (
        <div className="fixed inset-y-0 right-0 z-50 w-full max-w-[480px] overflow-y-auto bg-[var(--background)] border-l border-[var(--hl-border)] shadow-2xl">
          <TraderDetailPanel address={selectedTrader} onClose={() => setSelectedTrader(null)} onCopy={handleCopy} />
        </div>
      )}
      <OptionsChainModal coin={optionsChainCoin || "BTC"} isOpen={!!optionsChainCoin} onClose={() => setOptionsChainCoin(null)} />
      {copyTrader && <CopyDialog open={true} onOpenChange={handleClearCopy} traderAddress={copyTrader} walletAddress={walletAddress} />}
    </div>
  );
}
