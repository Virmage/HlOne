"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSafeAccount as useAccount } from "@/hooks/use-safe-account";
import { getUserPositions, getPortfolioPage, type UserPosition, type UserAccount, type PortfolioPageData } from "@/lib/api";

type TpSlMode = { coin: string; type: "tp" | "sl" } | null;
type Tab = "positions" | "orders" | "tradeHistory" | "fundingHistory";
type PnlWindow = "day" | "week" | "month" | "allTime";

const PNL_LABELS: Record<PnlWindow, string> = {
  day: "1 Day",
  week: "7 Days",
  month: "30 Days",
  allTime: "All Time",
};

export default function PortfolioPage() {
  const { address, isConnected } = useAccount();
  const [positions, setPositions] = useState<UserPosition[]>([]);
  const [account, setAccount] = useState<UserAccount | null>(null);
  const [portfolio, setPortfolio] = useState<PortfolioPageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [tpSlMode, setTpSlMode] = useState<TpSlMode>(null);
  const [triggerPrice, setTriggerPrice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [actionResult, setActionResult] = useState<{ coin: string; msg: string; ok: boolean } | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("positions");
  const [pnlWindow, setPnlWindow] = useState<PnlWindow>("allTime");
  const [chartMode, setChartMode] = useState<"value" | "pnl">("value");

  const initialLoadDone = useRef(false);
  const fetchData = useCallback(async () => {
    if (!address) return;
    if (!initialLoadDone.current) setLoading(true);
    try {
      const [posData, portfolioData] = await Promise.all([
        getUserPositions(address),
        getPortfolioPage(address, pnlWindow),
      ]);
      setPositions(posData.positions);
      setAccount(posData.account);
      setPortfolio(portfolioData);
      setError(null);
      initialLoadDone.current = true;
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [address, pnlWindow]);

  useEffect(() => {
    if (!isConnected || !address) return;
    fetchData();
    const interval = setInterval(fetchData, 15_000);
    return () => clearInterval(interval);
  }, [isConnected, address, fetchData]);

  useEffect(() => {
    if (!actionResult) return;
    const t = setTimeout(() => setActionResult(null), 5000);
    return () => clearTimeout(t);
  }, [actionResult]);

  const handleClose = useCallback(async (pos: UserPosition) => {
    if (!address) return;
    setClosing(pos.coin);
    setActionResult(null);
    try {
      const [wagmiCore, exchange, wagmiConfig] = await Promise.all([
        import("@wagmi/core"),
        import("@/lib/hl-exchange"),
        import("@/config/wagmi"),
      ]);
      const walletClient = await wagmiCore.getWalletClient(wagmiConfig.config);
      if (!walletClient) { setClosing(null); return; }
      let agentResult = await exchange.ensureAgent(walletClient, address as `0x${string}`);
      if (agentResult.error) { setActionResult({ coin: pos.coin, msg: agentResult.error, ok: false }); setClosing(null); return; }
      let result = await exchange.closePosition(agentResult.agentKey, address as `0x${string}`, pos.coin, Math.abs(pos.size), pos.side === "long");
      if (!result.success && result.error === exchange.STALE_AGENT_MSG) {
        agentResult = await exchange.ensureAgent(walletClient, address as `0x${string}`);
        if (!agentResult.error) result = await exchange.closePosition(agentResult.agentKey, address as `0x${string}`, pos.coin, Math.abs(pos.size), pos.side === "long");
      }
      setActionResult({ coin: pos.coin, msg: result.success ? "Position closed" : (result.error || "Failed"), ok: result.success });
      if (result.success) fetchData();
    } catch (err) {
      setActionResult({ coin: pos.coin, msg: (err as Error).message, ok: false });
    } finally {
      setClosing(null);
    }
  }, [address, fetchData]);

  const handleTpSl = useCallback(async (pos: UserPosition) => {
    if (!address || !tpSlMode || !triggerPrice) return;
    setSubmitting(true);
    setActionResult(null);
    try {
      const [wagmiCore, exchange, wagmiConfig] = await Promise.all([
        import("@wagmi/core"),
        import("@/lib/hl-exchange"),
        import("@/config/wagmi"),
      ]);
      const walletClient = await wagmiCore.getWalletClient(wagmiConfig.config);
      if (!walletClient) { setSubmitting(false); return; }
      let agentResult = await exchange.ensureAgent(walletClient, address as `0x${string}`);
      if (agentResult.error) { setActionResult({ coin: pos.coin, msg: agentResult.error, ok: false }); setSubmitting(false); return; }
      let result = await exchange.placeTriggerOrder(agentResult.agentKey, address as `0x${string}`, {
        asset: pos.coin, isLong: pos.side === "long", size: Math.abs(pos.size),
        triggerPrice: parseFloat(triggerPrice), type: tpSlMode.type,
      });
      if (!result.success && result.error === exchange.STALE_AGENT_MSG) {
        agentResult = await exchange.ensureAgent(walletClient, address as `0x${string}`);
        if (!agentResult.error) {
          result = await exchange.placeTriggerOrder(agentResult.agentKey, address as `0x${string}`, {
            asset: pos.coin, isLong: pos.side === "long", size: Math.abs(pos.size),
            triggerPrice: parseFloat(triggerPrice), type: tpSlMode.type,
          });
        }
      }
      setActionResult({ coin: pos.coin, msg: result.success ? `${tpSlMode.type.toUpperCase()} set at $${triggerPrice}` : (result.error || "Failed"), ok: result.success });
      if (result.success) { setTpSlMode(null); setTriggerPrice(""); }
    } catch (err) {
      setActionResult({ coin: pos.coin, msg: (err as Error).message, ok: false });
    } finally {
      setSubmitting(false);
    }
  }, [address, tpSlMode, triggerPrice]);

  if (!isConnected) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <div className="text-center space-y-2">
          <h2 className="text-xl font-semibold text-[var(--hl-text)]">Connect Your Wallet</h2>
          <p className="text-sm text-[var(--hl-muted)]">Connect your wallet to view your portfolio</p>
        </div>
      </div>
    );
  }

  if (loading && positions.length === 0 && !portfolio) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <div className="text-[var(--hl-muted)] animate-pulse">Loading portfolio...</div>
      </div>
    );
  }

  const totalPnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
  const totalNotional = positions.reduce((s, p) => s + Math.abs(p.positionValue), 0);
  const totalMargin = positions.reduce((s, p) => s + p.marginUsed, 0);
  const displayPnl = portfolio?.pnl[pnlWindow] ?? 0;
  const volume14d = portfolio?.volume["14d"] ?? 0;
  const volumeAll = portfolio?.volume["allTime"] ?? 0;
  return (
    <div className="space-y-4 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">Portfolio</h1>
          <p className="text-[11px] text-[var(--hl-muted)] mt-0.5 font-mono">
            {address}
          </p>
        </div>
        {isConnected && address && <TransferBar address={address} />}
      </div>

      {error && (
        <div className="rounded border border-[#f058581a] bg-[#f058580d] px-4 py-3 text-[13px] text-[var(--hl-red)]">
          {error}
        </div>
      )}

      {/* Top stats row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* Left: Total Equity + Volume */}
        <div className="border border-[var(--hl-border)] rounded-lg bg-[var(--hl-surface)] p-4 space-y-4">
          <div>
            <div className="text-[10px] text-[var(--hl-muted)] uppercase tracking-wider mb-1">Total Equity</div>
            <div className="text-[22px] font-bold text-[var(--hl-accent)] tabular-nums">
              {fmtUsd(account?.accountValue ?? 0)}
            </div>
          </div>
          <div className="border-t border-[var(--hl-border)] pt-3">
            <div className="text-[10px] text-[var(--hl-muted)] uppercase tracking-wider mb-1">14 Day Volume</div>
            <div className="text-[18px] font-bold text-[var(--foreground)] tabular-nums">
              ${volume14d >= 1000 ? volume14d.toLocaleString(undefined, { maximumFractionDigits: 2 }) : volume14d.toFixed(2)}
            </div>
          </div>
        </div>

        {/* Middle: PNL stats + Fees */}
        <div className="border border-[var(--hl-border)] rounded-lg bg-[var(--hl-surface)] p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[10px] text-[var(--hl-muted)] uppercase tracking-wider">Perps & Spot</div>
            <select
              value={pnlWindow}
              onChange={(e) => setPnlWindow(e.target.value as PnlWindow)}
              className="text-[11px] bg-[var(--hl-dark)] border border-[var(--hl-border)] rounded px-2 py-0.5 text-[var(--foreground)]"
            >
              {Object.entries(PNL_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5 text-[13px]">
            <StatRow label="PNL" value={fmtUsd(displayPnl)} color={displayPnl >= 0 ? "green" : "red"} />
            <StatRow label="Volume" value={fmtUsd(volumeAll)} />
            <StatRow label="Max Drawdown" value={`${(portfolio?.maxDrawdown ?? 0).toFixed(2)}%`} />
            <StatRow label="Perp Account Equity" value={fmtUsd(portfolio?.account.perpAccountEquity ?? 0)} />
            <StatRow label="Fees (Taker / Maker)" value={`${portfolio?.fees.takerRate || "—"} / ${portfolio?.fees.makerRate || "—"}`} />
          </div>
        </div>

        {/* Right: Equity chart */}
        <div className="border border-[var(--hl-border)] rounded-lg bg-[var(--hl-surface)] p-4">
          <div className="flex items-center gap-2 mb-3">
            <button
              onClick={() => setChartMode("value")}
              className={`text-[11px] px-2 py-0.5 rounded ${chartMode === "value" ? "bg-[var(--hl-dark)] text-[var(--foreground)]" : "text-[var(--hl-muted)]"}`}
            >Account Value</button>
            <button
              onClick={() => setChartMode("pnl")}
              className={`text-[11px] px-2 py-0.5 rounded ${chartMode === "pnl" ? "bg-[var(--hl-dark)] text-[var(--foreground)]" : "text-[var(--hl-muted)]"}`}
            >PNL</button>
          </div>
          <EquityChart data={portfolio?.equityCurve ?? []} mode={chartMode} />
        </div>
      </div>

      {/* Tabbed content */}
      <div className="border border-[var(--hl-border)] rounded-lg overflow-hidden">
        <div className="flex items-center border-b border-[var(--hl-border)] bg-[var(--hl-surface)] overflow-x-auto">
          {([
            ["positions", `Positions${positions.length ? ` (${positions.length})` : ""}`],
            ["orders", `Orders${portfolio?.openOrders.length ? ` (${portfolio.openOrders.length})` : ""}`],
            ["tradeHistory", "Trade History"],
            ["fundingHistory", "Funding History"],
          ] as [Tab, string][]).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`px-4 py-2.5 text-[12px] font-medium whitespace-nowrap transition-colors border-b-2 ${
                activeTab === key
                  ? "text-[var(--foreground)] border-[var(--hl-accent)]"
                  : "text-[var(--hl-muted)] border-transparent hover:text-[var(--foreground)]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="overflow-x-auto">
          {activeTab === "positions" && (
            <PositionsTable
              positions={positions}
              closing={closing}
              tpSlMode={tpSlMode}
              triggerPrice={triggerPrice}
              submitting={submitting}
              actionResult={actionResult}
              totalPnl={totalPnl}
              totalNotional={totalNotional}
              accountValue={account?.accountValue ?? 0}
              onClose={handleClose}
              onSetTpSlMode={(mode) => { setTpSlMode(mode); setTriggerPrice(""); }}
              onTriggerPriceChange={setTriggerPrice}
              onSubmitTpSl={handleTpSl}
            />
          )}
          {activeTab === "orders" && <OrdersTable orders={portfolio?.openOrders ?? []} triggerOrders={portfolio?.triggerOrders ?? []} />}
          {activeTab === "tradeHistory" && <TradeHistoryTable trades={portfolio?.trades ?? []} />}
          {activeTab === "fundingHistory" && <FundingTable funding={portfolio?.funding ?? []} />}
        </div>
      </div>

      {/* Account Details */}
      {account && (
        <div className="border border-[var(--hl-border)] rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--hl-border)] bg-[var(--hl-surface)]">
            <h2 className="text-[13px] font-semibold text-[var(--foreground)]">Account Details</h2>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-[var(--hl-border)]">
            <DetailItem label="Withdrawable" value={fmtUsd(account.withdrawable)} />
            <DetailItem label="Margin Ratio" value={account.accountValue > 0 ? `${((totalMargin / account.accountValue) * 100).toFixed(1)}%` : "—"} />
            <DetailItem label="Open Positions" value={String(positions.length)} />
            <DetailItem label="Leverage (Avg)" value={positions.length > 0 ? `${(totalNotional / (account.accountValue || 1)).toFixed(1)}x` : "—"} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtUsd(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1_000) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  return `$${v.toFixed(2)}`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function TransferBar({ address }: { address: string }) {
  const [mode, setMode] = useState<"none" | "deposit" | "withdraw" | "toPerps" | "toSpot">("none");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [spotBalance, setSpotBalance] = useState<number | null>(null);
  const [perpsBalance, setPerpsBalance] = useState<number | null>(null);
  const [arbUsdcBalance, setArbUsdcBalance] = useState<number | null>(null);

  useEffect(() => {
    if (!address) return;
    const fetchBalances = async () => {
      try {
        const perpsRes = await fetch("https://api.hyperliquid.xyz/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "clearinghouseState", user: address }),
        });
        const perpsData = await perpsRes.json();
        setPerpsBalance(parseFloat(perpsData?.withdrawable ?? "0"));
      } catch { /* ignore */ }
      try {
        const spotRes = await fetch("https://api.hyperliquid.xyz/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "spotClearinghouseState", user: address }),
        });
        const spotData = await spotRes.json();
        const usdcBal = spotData?.balances?.find((b: { coin: string; total: string }) => b.coin === "USDC");
        setSpotBalance(usdcBal ? parseFloat(usdcBal.total) : 0);
      } catch { setSpotBalance(0); }
      // Fetch Arbitrum USDC balance for deposit
      try {
        const exchange = await import("@/lib/hl-exchange");
        const bal = await exchange.getArbitrumUsdcBalance(address as `0x${string}`);
        setArbUsdcBalance(bal);
      } catch { setArbUsdcBalance(0); }
    };
    fetchBalances();
    const iv = window.setInterval(fetchBalances, 30_000);
    return () => clearInterval(iv);
  }, [address]);

  const handleTransfer = useCallback(async (toPerp: boolean) => {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return;
    setSubmitting(true);
    setResult(null);
    try {
      const [wagmiCore, exchange, wagmiConfig] = await Promise.all([
        import("@wagmi/core"),
        import("@/lib/hl-exchange"),
        import("@/config/wagmi"),
      ]);
      const walletClient = await wagmiCore.getWalletClient(wagmiConfig.config);
      if (!walletClient) { setResult({ ok: false, msg: "No wallet" }); return; }
      const res = await exchange.transferBetweenSpotAndPerp(walletClient, address as `0x${string}`, amt, toPerp);
      setResult(res.success
        ? { ok: true, msg: `Transferred $${amt} ${toPerp ? "Spot → Perps" : "Perps → Spot"}` }
        : { ok: false, msg: res.error || "Failed" }
      );
      if (res.success) setAmount("");
    } catch (err) {
      setResult({ ok: false, msg: err instanceof Error ? err.message : "Failed" });
    } finally {
      setSubmitting(false);
    }
  }, [amount, address]);

  const handleDeposit = useCallback(async () => {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return;
    setSubmitting(true);
    setResult(null);
    try {
      const [wagmiCore, exchange, wagmiConfig] = await Promise.all([
        import("@wagmi/core"),
        import("@/lib/hl-exchange"),
        import("@/config/wagmi"),
      ]);
      const walletClient = await wagmiCore.getWalletClient(wagmiConfig.config);
      if (!walletClient) { setResult({ ok: false, msg: "No wallet" }); return; }
      const res = await exchange.deposit(walletClient, address as `0x${string}`, amt);
      setResult(res.success
        ? { ok: true, msg: `Deposited $${amt} USDC` }
        : { ok: false, msg: res.error || "Deposit failed" }
      );
      if (res.success) { setAmount(""); setArbUsdcBalance(prev => prev !== null ? prev - amt : null); }
    } catch (err) {
      setResult({ ok: false, msg: err instanceof Error ? err.message : "Failed" });
    } finally {
      setSubmitting(false);
    }
  }, [amount, address]);

  const handleWithdraw = useCallback(async () => {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return;
    setSubmitting(true);
    setResult(null);
    try {
      const [wagmiCore, exchange, wagmiConfig] = await Promise.all([
        import("@wagmi/core"),
        import("@/lib/hl-exchange"),
        import("@/config/wagmi"),
      ]);
      const walletClient = await wagmiCore.getWalletClient(wagmiConfig.config);
      if (!walletClient) { setResult({ ok: false, msg: "No wallet" }); return; }
      // Withdraw requires an agent key — ensure one exists
      const agent = await exchange.ensureAgent(walletClient, address as `0x${string}`);
      if (agent.error) { setResult({ ok: false, msg: agent.error }); return; }
      const res = await exchange.withdraw(agent.agentKey, address as `0x${string}`, amt);
      setResult(res.success
        ? { ok: true, msg: `Withdrawal of $${amt} initiated` }
        : { ok: false, msg: res.error || "Withdrawal failed" }
      );
      if (res.success) { setAmount(""); setPerpsBalance(prev => prev !== null ? prev - amt : null); }
    } catch (err) {
      setResult({ ok: false, msg: err instanceof Error ? err.message : "Failed" });
    } finally {
      setSubmitting(false);
    }
  }, [amount, address]);

  const fmtBal = (v: number | null) => v === null ? "..." : `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  const btnClass = "px-3 py-1.5 text-[11px] font-medium rounded border border-[var(--hl-border)] bg-[var(--hl-surface)] hover:bg-[var(--hl-surface-hover)] transition-colors";

  if (mode === "none") {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={() => { setMode("deposit"); setResult(null); }} className={`${btnClass} text-[var(--hl-green)]`}>
          Deposit <span className="text-[var(--hl-muted)] text-[9px] ml-1">{fmtBal(arbUsdcBalance)}</span>
        </button>
        <button onClick={() => { setMode("withdraw"); setResult(null); }} className={`${btnClass} text-[var(--foreground)]`}>
          Withdraw <span className="text-[var(--hl-muted)] text-[9px] ml-1">{fmtBal(perpsBalance)}</span>
        </button>
        <button onClick={() => { setMode("toPerps"); setResult(null); }} className={`${btnClass} text-[var(--hl-accent)]`}>
          Spot → Perps <span className="text-[var(--hl-muted)] text-[9px] ml-1">{fmtBal(spotBalance)}</span>
        </button>
        <button onClick={() => { setMode("toSpot"); setResult(null); }} className={`${btnClass} text-[var(--hl-accent)]`}>
          Perps → Spot <span className="text-[var(--hl-muted)] text-[9px] ml-1">{fmtBal(perpsBalance)}</span>
        </button>
      </div>
    );
  }

  const modeLabels: Record<string, string> = {
    deposit: "Deposit USDC",
    withdraw: "Withdraw USDC",
    toPerps: "Spot → Perps",
    toSpot: "Perps → Spot",
  };
  const maxBal = mode === "deposit" ? arbUsdcBalance
    : mode === "withdraw" ? perpsBalance
    : mode === "toPerps" ? spotBalance
    : perpsBalance;
  const balLabel = mode === "deposit" ? `Wallet: ${fmtBal(arbUsdcBalance)}`
    : mode === "withdraw" ? `Withdrawable: ${fmtBal(perpsBalance)}`
    : mode === "toPerps" ? `Spot: ${fmtBal(spotBalance)}`
    : `Perps: ${fmtBal(perpsBalance)}`;
  const handleSubmit = mode === "deposit" ? handleDeposit
    : mode === "withdraw" ? handleWithdraw
    : () => handleTransfer(mode === "toPerps");
  const submitLabel = mode === "deposit" ? "Deposit" : mode === "withdraw" ? "Withdraw" : "Transfer";

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button onClick={() => { setMode("none"); setResult(null); setAmount(""); }} className="text-[var(--hl-muted)] hover:text-[var(--foreground)] text-[14px]">&larr;</button>
      <span className="text-[11px] font-medium text-[var(--foreground)]">{modeLabels[mode]}</span>
      <span className="text-[9px] text-[var(--hl-muted)] tabular-nums">{balLabel}</span>
      <div className="flex items-center bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded px-2 py-1">
        <span className="text-[10px] text-[var(--hl-muted)] mr-1">$</span>
        <input
          type="number"
          value={amount}
          onChange={e => setAmount(e.target.value)}
          placeholder="0.00"
          className="w-20 bg-transparent text-right text-[12px] text-[var(--foreground)] tabular-nums placeholder:text-[var(--hl-muted)] outline-none"
          autoFocus
        />
        <button
          onClick={() => setAmount(String(maxBal ?? 0))}
          className="text-[9px] text-[var(--hl-accent)] ml-1 hover:brightness-110"
        >MAX</button>
      </div>
      <button
        onClick={handleSubmit}
        disabled={submitting || !parseFloat(amount)}
        className={`px-3 py-1.5 rounded text-[11px] font-semibold bg-[var(--hl-accent)] text-[var(--background)] transition-colors ${submitting || !parseFloat(amount) ? "opacity-40" : "hover:brightness-110"}`}
      >
        {submitting ? "..." : submitLabel}
      </button>
      {result && (
        <span className={`text-[10px] ${result.ok ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>{result.msg}</span>
      )}
    </div>
  );
}

function StatRow({ label, value, color }: { label: string; value: string; color?: "green" | "red" }) {
  const vc = color === "green" ? "text-[var(--hl-green)]" : color === "red" ? "text-[var(--hl-red)]" : "text-[var(--foreground)]";
  return (
    <div className="flex items-center justify-between">
      <span className="text-[var(--hl-muted)]">{label}</span>
      <span className={`tabular-nums font-medium ${vc}`}>{value}</span>
    </div>
  );
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[var(--background)] p-3">
      <div className="text-[10px] text-[var(--hl-muted)] uppercase tracking-wider">{label}</div>
      <div className="text-[13px] font-medium text-[var(--foreground)] tabular-nums mt-0.5">{value}</div>
    </div>
  );
}

// ─── Equity Chart (SVG) ─────────────────────────────────────────────────────

function EquityChart({ data, mode }: { data: { time: number; accountValue: number; pnl: number }[]; mode: "value" | "pnl" }) {
  const canvasRef = useRef<HTMLDivElement>(null);
  if (!data.length) {
    return <div className="flex items-center justify-center h-[140px] text-[11px] text-[var(--hl-muted)]">No history yet</div>;
  }

  const W = 340, H = 140, ML = 50, MR = 10, MT = 10, MB = 20;
  const values = data.map(d => mode === "value" ? d.accountValue : d.pnl);
  const times = data.map(d => d.time);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const rangeV = maxV - minV || 1;
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const rangeT = maxT - minT || 1;

  const x = (t: number) => ML + ((t - minT) / rangeT) * (W - ML - MR);
  const y = (v: number) => MT + (1 - (v - minV) / rangeV) * (H - MT - MB);

  const pathD = data.map((d, i) => {
    const px = x(d.time);
    const py = y(values[i]);
    return `${i === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`;
  }).join(" ");

  // Y-axis labels
  const yLabels = [maxV, (maxV + minV) / 2, minV];
  const isGreen = values[values.length - 1] >= values[0];

  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="overflow-visible">
      {/* Y labels */}
      {yLabels.map((v, i) => (
        <text key={i} x={ML - 4} y={y(v) + 3} fill="var(--hl-muted)" fontSize={9} textAnchor="end" fontFamily="monospace">
          ${Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}K` : v.toFixed(0)}
        </text>
      ))}
      {/* Grid lines */}
      {yLabels.map((v, i) => (
        <line key={`g${i}`} x1={ML} y1={y(v)} x2={W - MR} y2={y(v)} stroke="var(--hl-border)" strokeWidth={0.5} />
      ))}
      {/* Line */}
      <path d={pathD} fill="none" stroke={isGreen ? "var(--hl-green)" : "var(--hl-red)"} strokeWidth={1.5} />
    </svg>
  );
}

// ─── Positions Table ────────────────────────────────────────────────────────

interface PositionsTableProps {
  positions: UserPosition[];
  closing: string | null;
  tpSlMode: TpSlMode;
  triggerPrice: string;
  submitting: boolean;
  actionResult: { coin: string; msg: string; ok: boolean } | null;
  totalPnl: number;
  totalNotional: number;
  accountValue: number;
  onClose: (pos: UserPosition) => void;
  onSetTpSlMode: (mode: TpSlMode) => void;
  onTriggerPriceChange: (v: string) => void;
  onSubmitTpSl: (pos: UserPosition) => void;
}

function PositionsTable({
  positions, closing, tpSlMode, triggerPrice, submitting, actionResult,
  totalPnl, totalNotional, accountValue,
  onClose, onSetTpSlMode, onTriggerPriceChange, onSubmitTpSl,
}: PositionsTableProps) {
  if (positions.length === 0) {
    return (
      <div className="text-[13px] text-[var(--hl-muted)] text-center py-12">
        No open positions
      </div>
    );
  }

  return (
    <table className="w-full text-[12px]">
      <thead>
        <tr className="text-[var(--hl-muted)] text-[10px] uppercase tracking-wider border-b border-[var(--hl-border)] bg-[var(--hl-surface)]">
          <th className="text-left px-4 py-2">Coin</th>
          <th className="text-left px-2 py-2">Side</th>
          <th className="text-right px-2 py-2">Size</th>
          <th className="text-right px-2 py-2">Position Value</th>
          <th className="text-right px-2 py-2">Entry Price</th>
          <th className="text-right px-2 py-2">Mark Price</th>
          <th className="text-right px-2 py-2">PNL (ROE %)</th>
          <th className="text-right px-2 py-2">Liq. Price</th>
          <th className="text-right px-2 py-2">Margin</th>
          <th className="text-right px-2 py-2">Funding</th>
          <th className="text-right px-4 py-2">Actions</th>
        </tr>
      </thead>
      <tbody>
        {positions.map((p) => {
          const displayCoin = p.coin.includes(":") ? p.coin.split(":")[1] : p.coin;
          const pnlColor = p.unrealizedPnl >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]";
          const isClosing = closing === p.coin;
          const result = actionResult?.coin === p.coin ? actionResult : null;
          const showTpSl = tpSlMode?.coin === p.coin;
          return (
            <tr key={p.coin} className="border-b border-[var(--hl-border)] border-opacity-30 hover:bg-[var(--hl-surface)] transition-colors">
              <td className="px-4 py-2.5 font-medium text-[var(--foreground)]">{displayCoin}</td>
              <td className="px-2 py-2.5">
                <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                  p.side === "long" ? "bg-[rgba(80,210,193,0.15)] text-[var(--hl-green)]" : "bg-[rgba(240,88,88,0.15)] text-[var(--hl-red)]"
                }`}>{p.side.toUpperCase()}</span>
              </td>
              <td className="px-2 py-2.5 text-right tabular-nums text-[var(--foreground)]">{Math.abs(p.size).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
              <td className="px-2 py-2.5 text-right tabular-nums text-[var(--foreground)]">${Math.abs(p.positionValue).toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
              <td className="px-2 py-2.5 text-right tabular-nums text-[var(--hl-muted)]">${p.entryPx.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
              <td className="px-2 py-2.5 text-right tabular-nums text-[var(--hl-text)]">${p.markPx.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
              <td className={`px-2 py-2.5 text-right tabular-nums font-medium ${pnlColor}`}>
                {p.unrealizedPnl >= 0 ? "+" : ""}${p.unrealizedPnl.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                <span className="text-[10px] ml-1">({(p.returnOnEquity * 100).toFixed(1)}%)</span>
              </td>
              <td className="px-2 py-2.5 text-right tabular-nums text-[var(--hl-muted)]">
                {p.liquidationPx ? `$${p.liquidationPx.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}
              </td>
              <td className="px-2 py-2.5 text-right tabular-nums text-[var(--hl-muted)]">${p.marginUsed.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
              <td className={`px-2 py-2.5 text-right tabular-nums ${p.cumFunding >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                {p.cumFunding >= 0 ? "+" : ""}${p.cumFunding.toFixed(2)}
              </td>
              <td className="px-4 py-2.5 text-right">
                <div className="flex items-center justify-end gap-1.5">
                  <button
                    onClick={() => onClose(p)}
                    disabled={isClosing}
                    className="px-2 py-1 text-[10px] font-semibold rounded bg-[rgba(240,88,88,0.15)] text-[var(--hl-red)] hover:bg-[rgba(240,88,88,0.3)] transition-colors disabled:opacity-50"
                  >
                    {isClosing ? "..." : "Close"}
                  </button>
                  <button
                    onClick={() => onSetTpSlMode(showTpSl && tpSlMode?.type === "tp" ? null : { coin: p.coin, type: "tp" })}
                    className={`px-2 py-1 text-[10px] font-semibold rounded transition-colors ${
                      showTpSl && tpSlMode?.type === "tp" ? "bg-[rgba(80,210,193,0.3)] text-[var(--hl-green)]" : "bg-[rgba(80,210,193,0.1)] text-[var(--hl-green)] hover:bg-[rgba(80,210,193,0.2)]"
                    }`}
                  >TP</button>
                  <button
                    onClick={() => onSetTpSlMode(showTpSl && tpSlMode?.type === "sl" ? null : { coin: p.coin, type: "sl" })}
                    className={`px-2 py-1 text-[10px] font-semibold rounded transition-colors ${
                      showTpSl && tpSlMode?.type === "sl" ? "bg-[rgba(240,88,88,0.3)] text-[var(--hl-red)]" : "bg-[rgba(240,88,88,0.1)] text-[var(--hl-red)] hover:bg-[rgba(240,88,88,0.2)]"
                    }`}
                  >SL</button>
                </div>
                {showTpSl && (
                  <div className="flex items-center gap-1.5 mt-1.5 justify-end">
                    <span className="text-[10px] text-[var(--hl-muted)]">{tpSlMode!.type === "tp" ? "TP" : "SL"} $</span>
                    <input
                      type="number"
                      value={triggerPrice}
                      onChange={(e) => onTriggerPriceChange(e.target.value)}
                      placeholder={p.entryPx.toFixed(2)}
                      className="w-24 px-1.5 py-1 text-[11px] bg-[var(--hl-dark)] border border-[var(--hl-border)] rounded text-[var(--foreground)] tabular-nums"
                    />
                    <button
                      onClick={() => onSubmitTpSl(p)}
                      disabled={submitting || !triggerPrice}
                      className="px-2 py-1 text-[10px] font-semibold rounded bg-[var(--hl-accent)] text-black hover:opacity-80 transition-opacity disabled:opacity-50"
                    >
                      {submitting ? "..." : "Set"}
                    </button>
                  </div>
                )}
                {result && (
                  <div className={`text-[10px] mt-1 ${result.ok ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>{result.msg}</div>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
      {positions.length > 1 && (
        <tfoot>
          <tr className="text-[11px] font-medium bg-[var(--hl-surface)]">
            <td className="px-4 py-2 text-[var(--hl-muted)]" colSpan={3}>Total</td>
            <td className="px-2 py-2 text-right tabular-nums text-[var(--foreground)]">${totalNotional.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
            <td colSpan={2}></td>
            <td className={`px-2 py-2 text-right tabular-nums font-medium ${totalPnl >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
              {totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              {accountValue > 0 && <span className="text-[10px] ml-1">({((totalPnl / accountValue) * 100).toFixed(1)}%)</span>}
            </td>
            <td colSpan={4}></td>
          </tr>
        </tfoot>
      )}
    </table>
  );
}

// ─── Orders Table ───────────────────────────────────────────────────────────

function OrdersTable({ orders, triggerOrders }: { orders: PortfolioPageData["openOrders"]; triggerOrders: PortfolioPageData["triggerOrders"] }) {
  const allOrders = [
    ...orders.map(o => ({ ...o, isTrigger: false })),
    ...triggerOrders.map(o => ({ coin: o.coin, side: o.side, sz: o.sz, limitPx: o.triggerPx, orderType: o.orderType, oid: o.oid, isTrigger: true })),
  ];

  if (allOrders.length === 0) {
    return <div className="text-[13px] text-[var(--hl-muted)] text-center py-12">No open orders</div>;
  }

  return (
    <table className="w-full text-[12px]">
      <thead>
        <tr className="text-[var(--hl-muted)] text-[10px] uppercase tracking-wider border-b border-[var(--hl-border)] bg-[var(--hl-surface)]">
          <th className="text-left px-4 py-2">Coin</th>
          <th className="text-left px-2 py-2">Type</th>
          <th className="text-left px-2 py-2">Side</th>
          <th className="text-right px-2 py-2">Size</th>
          <th className="text-right px-4 py-2">Price</th>
        </tr>
      </thead>
      <tbody>
        {allOrders.map((o, i) => {
          const displayCoin = o.coin?.includes(":") ? o.coin.split(":")[1] : o.coin;
          const sideColor = o.side === "B" || o.side === "buy" ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]";
          return (
            <tr key={`${o.oid}-${i}`} className="border-b border-[var(--hl-border)] border-opacity-30 hover:bg-[var(--hl-surface)] transition-colors">
              <td className="px-4 py-2 font-medium text-[var(--foreground)]">{displayCoin}</td>
              <td className="px-2 py-2 text-[var(--hl-muted)]">{o.orderType || "Limit"}</td>
              <td className={`px-2 py-2 font-medium ${sideColor}`}>{o.side === "B" || o.side === "buy" ? "Buy" : "Sell"}</td>
              <td className="px-2 py-2 text-right tabular-nums text-[var(--foreground)]">{o.sz}</td>
              <td className="px-4 py-2 text-right tabular-nums text-[var(--foreground)]">${o.limitPx}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ─── Trade History Table ────────────────────────────────────────────────────

function TradeHistoryTable({ trades }: { trades: PortfolioPageData["trades"] }) {
  if (trades.length === 0) {
    return <div className="text-[13px] text-[var(--hl-muted)] text-center py-12">No trades in last 30 days</div>;
  }

  return (
    <table className="w-full text-[12px]">
      <thead>
        <tr className="text-[var(--hl-muted)] text-[10px] uppercase tracking-wider border-b border-[var(--hl-border)] bg-[var(--hl-surface)]">
          <th className="text-left px-4 py-2">Time</th>
          <th className="text-left px-2 py-2">Coin</th>
          <th className="text-left px-2 py-2">Direction</th>
          <th className="text-right px-2 py-2">Price</th>
          <th className="text-right px-2 py-2">Size</th>
          <th className="text-right px-2 py-2">Closed PNL</th>
          <th className="text-right px-4 py-2">Fee</th>
        </tr>
      </thead>
      <tbody>
        {trades.map((t, i) => {
          const displayCoin = t.coin?.includes(":") ? t.coin.split(":")[1] : t.coin;
          const dirColor = t.dir === "Open Long" || t.dir === "Buy" || t.side === "B" ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]";
          return (
            <tr key={`${t.hash}-${i}`} className="border-b border-[var(--hl-border)] border-opacity-30 hover:bg-[var(--hl-surface)] transition-colors">
              <td className="px-4 py-2 text-[var(--hl-muted)] text-[11px]">{fmtTime(t.time)}</td>
              <td className="px-2 py-2 font-medium text-[var(--foreground)]">{displayCoin}</td>
              <td className={`px-2 py-2 font-medium ${dirColor}`}>{t.dir || t.side}</td>
              <td className="px-2 py-2 text-right tabular-nums text-[var(--foreground)]">${t.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
              <td className="px-2 py-2 text-right tabular-nums text-[var(--foreground)]">{t.size.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
              <td className={`px-2 py-2 text-right tabular-nums font-medium ${t.closedPnl >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                {t.closedPnl !== 0 ? `${t.closedPnl >= 0 ? "+" : ""}$${t.closedPnl.toFixed(2)}` : "—"}
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-[var(--hl-muted)]">${t.fee.toFixed(4)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ─── Funding History Table ──────────────────────────────────────────────────

function FundingTable({ funding }: { funding: PortfolioPageData["funding"] }) {
  if (funding.length === 0) {
    return <div className="text-[13px] text-[var(--hl-muted)] text-center py-12">No funding payments in last 30 days</div>;
  }

  return (
    <table className="w-full text-[12px]">
      <thead>
        <tr className="text-[var(--hl-muted)] text-[10px] uppercase tracking-wider border-b border-[var(--hl-border)] bg-[var(--hl-surface)]">
          <th className="text-left px-4 py-2">Time</th>
          <th className="text-left px-2 py-2">Coin</th>
          <th className="text-right px-2 py-2">Payment</th>
          <th className="text-right px-2 py-2">Position Size</th>
          <th className="text-right px-4 py-2">Rate</th>
        </tr>
      </thead>
      <tbody>
        {funding.map((f, i) => (
          <tr key={`${f.time}-${f.coin}-${i}`} className="border-b border-[var(--hl-border)] border-opacity-30 hover:bg-[var(--hl-surface)] transition-colors">
            <td className="px-4 py-2 text-[var(--hl-muted)] text-[11px]">{fmtTime(f.time)}</td>
            <td className="px-2 py-2 font-medium text-[var(--foreground)]">{f.coin?.includes(":") ? f.coin.split(":")[1] : f.coin}</td>
            <td className={`px-2 py-2 text-right tabular-nums font-medium ${f.payment >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
              {f.payment >= 0 ? "+" : ""}${f.payment.toFixed(4)}
            </td>
            <td className="px-2 py-2 text-right tabular-nums text-[var(--foreground)]">{f.size.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
            <td className="px-4 py-2 text-right tabular-nums text-[var(--hl-muted)]">{(f.rate * 100).toFixed(4)}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
