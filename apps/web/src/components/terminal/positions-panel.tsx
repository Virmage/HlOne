"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getUserPositions, type UserPosition, type UserAccount } from "@/lib/api";
import { useSafeAccount } from "@/hooks/use-safe-account";

function friendlyError(msg: string | undefined): string {
  if (!msg) return "Failed";
  if (msg === "STALE_AGENT") return "Session expired — approve wallet popup to retry";
  if (msg.toLowerCase().includes("does not exist")) return "Session expired — approve wallet popup to retry";
  if (msg.includes("429")) return "Rate limited — please wait a moment and retry";
  return msg;
}

const HL_API = "https://api.hyperliquid.xyz";

interface PositionsPanelProps {
  onSelectToken?: (coin: string) => void;
}

type Tab = "positions" | "balances" | "orders" | "twap" | "tradeHistory" | "fundingHistory" | "orderHistory";
type TpSlMode = { coin: string; type: "tp" | "sl" } | null;

interface OpenOrder {
  coin: string;
  side: string;
  sz: string;
  limitPx: string;
  orderType: string;
  oid?: number;
  timestamp?: number;
}

interface Fill {
  coin: string;
  side: string;
  px: string;
  sz: string;
  time: number;
  fee: string;
  closedPnl: string;
  dir: string;
}

interface FundingEntry {
  coin: string;
  usdc: string;
  time: number;
  fundingRate: string;
}

export function PositionsPanel({ onSelectToken }: PositionsPanelProps) {
  const { address, isConnected } = useSafeAccount();
  const [tab, setTab] = useState<Tab>("positions");
  const [positions, setPositions] = useState<UserPosition[]>([]);
  const [account, setAccount] = useState<UserAccount | null>(null);
  const [openOrders, setOpenOrders] = useState<OpenOrder[]>([]);
  const [fills, setFills] = useState<Fill[]>([]);
  const [funding, setFunding] = useState<FundingEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [tpSlMode, setTpSlMode] = useState<TpSlMode>(null);
  const [triggerPrice, setTriggerPrice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [actionResult, setActionResult] = useState<{ coin: string; msg: string; ok: boolean } | null>(null);
  const [closingAll, setClosingAll] = useState(false);
  const hasFetchedRef = useRef(false);
  const posCountRef = useRef(0);

  // Keep ref in sync with state
  useEffect(() => { posCountRef.current = positions.length; }, [positions]);

  const fetchPositions = useCallback(async () => {
    if (!address) return;
    if (!hasFetchedRef.current) setLoading(true);
    try {
      const data = await getUserPositions(address);
      if (data && Array.isArray(data.positions)) {
        // If backend returned empty but we already have positions, skip update (likely HL API hiccup)
        if (data.positions.length === 0 && posCountRef.current > 0 && data.account === null) {
          return;
        }
        setPositions(data.positions);
        setAccount(data.account);
        setOpenOrders(data.openOrders || []);
        setError(null);
      }
      hasFetchedRef.current = true;
    } catch (err) {
      // On error, keep existing positions visible — don't flash to empty
      if (!hasFetchedRef.current) {
        setError((err as Error).message);
      }
    } finally {
      setLoading(false);
    }
  }, [address]);

  // Fetch trade history from HL directly
  const fetchFills = useCallback(async () => {
    if (!address) return;
    try {
      const res = await fetch(HL_API + "/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "userFillsByTime", user: address, startTime: Date.now() - 7 * 86400_000, endTime: Date.now() }),
      });
      const data = await res.json();
      setFills(Array.isArray(data) ? data.slice(0, 100) : []);
    } catch { setFills([]); }
  }, [address]);

  // Fetch funding history from HL directly
  const fetchFunding = useCallback(async () => {
    if (!address) return;
    try {
      const res = await fetch(HL_API + "/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "userFunding", user: address, startTime: Date.now() - 7 * 86400_000, endTime: Date.now() }),
      });
      const raw = await res.json();
      // HL returns { time, hash, delta: { type, coin, usdc, fundingRate, szi } }
      const entries: FundingEntry[] = Array.isArray(raw)
        ? raw
            .filter((r: { delta?: { type?: string } }) => r.delta?.type === "funding")
            .map((r: { time: number; delta: { coin: string; usdc: string; fundingRate: string } }) => ({
              coin: r.delta.coin,
              usdc: r.delta.usdc,
              time: r.time,
              fundingRate: r.delta.fundingRate,
            }))
            .slice(0, 200)
        : [];
      setFunding(entries);
    } catch { setFunding([]); }
  }, [address]);

  useEffect(() => {
    if (!isConnected || !address) return;
    fetchPositions();
    const interval = setInterval(() => {
      // Skip polling when tab is hidden — avoids stale/failed fetches
      if (document.hidden) return;
      fetchPositions();
    }, 15_000);
    return () => clearInterval(interval);
  }, [isConnected, address, fetchPositions]);

  // Fetch tab-specific data when tab changes
  useEffect(() => {
    if (!isConnected || !address) return;
    if (tab === "tradeHistory" && fills.length === 0) fetchFills();
    if (tab === "fundingHistory" && funding.length === 0) fetchFunding();
  }, [tab, isConnected, address]);

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
        import("@wagmi/core"), import("@/lib/hl-exchange"), import("@/config/wagmi"),
      ]);
      const walletClient = await wagmiCore.getWalletClient(wagmiConfig.config);
      if (!walletClient) { setClosing(null); return; }
      let agentResult = await exchange.ensureAgent(walletClient, address as `0x${string}`);
      if (agentResult.error) { setActionResult({ coin: pos.coin, msg: agentResult.error, ok: false }); setClosing(null); return; }
      let result = await exchange.closePosition(agentResult.agentKey, address as `0x${string}`, pos.coin, Math.abs(pos.size), pos.side === "long");
      // Auto-recover from stale agent
      if (!result.success && result.error === exchange.STALE_AGENT_MSG) {
        agentResult = await exchange.ensureAgent(walletClient, address as `0x${string}`);
        if (!agentResult.error) {
          result = await exchange.closePosition(agentResult.agentKey, address as `0x${string}`, pos.coin, Math.abs(pos.size), pos.side === "long");
        }
      }
      setActionResult({ coin: pos.coin, msg: result.success ? "Closed" : friendlyError(result.error), ok: result.success });
      if (result.success) fetchPositions();
    } catch (err) {
      setActionResult({ coin: pos.coin, msg: friendlyError((err as Error).message), ok: false });
    } finally {
      setClosing(null);
    }
  }, [address, fetchPositions]);

  const handleTpSl = useCallback(async (pos: UserPosition) => {
    if (!address || !tpSlMode || !triggerPrice) return;
    setSubmitting(true);
    setActionResult(null);
    try {
      const [wagmiCore, exchange, wagmiConfig] = await Promise.all([
        import("@wagmi/core"), import("@/lib/hl-exchange"), import("@/config/wagmi"),
      ]);
      const walletClient = await wagmiCore.getWalletClient(wagmiConfig.config);
      if (!walletClient) { setSubmitting(false); return; }
      let agentResult = await exchange.ensureAgent(walletClient, address as `0x${string}`);
      if (agentResult.error) { setActionResult({ coin: pos.coin, msg: agentResult.error, ok: false }); setSubmitting(false); return; }
      let result = await exchange.placeTriggerOrder(agentResult.agentKey, address as `0x${string}`, {
        asset: pos.coin, isLong: pos.side === "long", size: Math.abs(pos.size),
        triggerPrice: parseFloat(triggerPrice), type: tpSlMode.type,
      });
      // Auto-recover from stale agent
      if (!result.success && result.error === exchange.STALE_AGENT_MSG) {
        agentResult = await exchange.ensureAgent(walletClient, address as `0x${string}`);
        if (!agentResult.error) {
          result = await exchange.placeTriggerOrder(agentResult.agentKey, address as `0x${string}`, {
            asset: pos.coin, isLong: pos.side === "long", size: Math.abs(pos.size),
            triggerPrice: parseFloat(triggerPrice), type: tpSlMode.type,
          });
        }
      }
      setActionResult({ coin: pos.coin, msg: result.success ? `${tpSlMode.type.toUpperCase()} set at $${triggerPrice}` : friendlyError(result.error), ok: result.success });
      if (result.success) { setTpSlMode(null); setTriggerPrice(""); }
    } catch (err) {
      setActionResult({ coin: pos.coin, msg: friendlyError((err as Error).message), ok: false });
    } finally {
      setSubmitting(false);
    }
  }, [address, tpSlMode, triggerPrice]);

  const handleCloseAll = useCallback(async () => {
    if (!address || positions.length === 0) return;
    setClosingAll(true);
    setActionResult(null);
    try {
      const [wagmiCore, exchange, wagmiConfig] = await Promise.all([
        import("@wagmi/core"), import("@/lib/hl-exchange"), import("@/config/wagmi"),
      ]);
      const walletClient = await wagmiCore.getWalletClient(wagmiConfig.config);
      if (!walletClient) { setClosingAll(false); return; }
      let agentResult = await exchange.ensureAgent(walletClient, address as `0x${string}`);
      if (agentResult.error) { setActionResult({ coin: "ALL", msg: agentResult.error, ok: false }); setClosingAll(false); return; }

      let closed = 0;
      for (const pos of positions) {
        let result = await exchange.closePosition(agentResult.agentKey, address as `0x${string}`, pos.coin, Math.abs(pos.size), pos.side === "long");
        if (!result.success && result.error === exchange.STALE_AGENT_MSG) {
          agentResult = await exchange.ensureAgent(walletClient, address as `0x${string}`);
          if (!agentResult.error) {
            result = await exchange.closePosition(agentResult.agentKey, address as `0x${string}`, pos.coin, Math.abs(pos.size), pos.side === "long");
          }
        }
        if (result.success) closed++;
      }
      setActionResult({ coin: "ALL", msg: `Closed ${closed}/${positions.length} positions`, ok: closed > 0 });
      if (closed > 0) fetchPositions();
    } catch (err) {
      setActionResult({ coin: "ALL", msg: friendlyError((err as Error).message), ok: false });
    } finally {
      setClosingAll(false);
    }
  }, [address, positions, fetchPositions]);

  const totalPnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);

  const TABS: { key: Tab; label: string; count?: number }[] = [
    { key: "positions", label: "Positions", count: positions.length },
    { key: "balances", label: "Balances" },
    { key: "orders", label: "Open Orders", count: openOrders.length },
    { key: "twap", label: "TWAP" },
    { key: "tradeHistory", label: "Trade History" },
    { key: "fundingHistory", label: "Funding History" },
    { key: "orderHistory", label: "Order History" },
  ];

  if (!isConnected) {
    return (
      <div>
        <div className="flex items-center gap-3 overflow-x-auto scrollbar-none">
          {TABS.map(t => (
            <button key={t.key} className="text-[11px] text-[var(--hl-muted)] whitespace-nowrap py-1.5 border-b-2 border-transparent">
              {t.label}
            </button>
          ))}
        </div>
        <div className="text-[11px] text-[var(--hl-muted)] text-center py-6">Connect wallet to view positions</div>
      </div>
    );
  }

  return (
    <div>
      {/* Tab bar */}
      <div className="flex items-center gap-0 overflow-x-auto scrollbar-none border-b border-[var(--hl-border)]">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-2.5 py-1.5 text-[11px] font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
              tab === t.key
                ? "border-[var(--foreground)] text-[var(--foreground)]"
                : "border-transparent text-[var(--hl-muted)] hover:text-[var(--hl-text)]"
            }`}
          >
            {t.label}
            {t.count !== undefined && t.count > 0 && (
              <span className="ml-1 text-[9px] text-[var(--hl-muted)]">({t.count})</span>
            )}
          </button>
        ))}
        {/* Account info — right side */}
        {account && (
          <div className="ml-auto flex gap-3 text-[10px] pr-1 shrink-0">
            <span className="text-[var(--hl-muted)]">
              Acct: <span className="text-[var(--hl-accent)] tabular-nums font-medium">${account.accountValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            </span>
            <span className={totalPnl >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}>
              uPnL: {totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </span>
          </div>
        )}
      </div>

      {/* Tab content */}
      <div className="min-h-[60px]">
        {tab === "positions" && <PositionsTab positions={positions} loading={loading} error={error} closing={closing} closingAll={closingAll} tpSlMode={tpSlMode} triggerPrice={triggerPrice} submitting={submitting} actionResult={actionResult} onSelectToken={onSelectToken} onClose={handleClose} onCloseAll={handleCloseAll} onTpSlToggle={(coin, type) => { setTpSlMode(tpSlMode?.coin === coin && tpSlMode?.type === type ? null : { coin, type }); setTriggerPrice(""); }} onTriggerPriceChange={setTriggerPrice} onTpSlSubmit={handleTpSl} />}
        {tab === "balances" && <BalancesTab account={account} />}
        {tab === "orders" && <OpenOrdersTab orders={openOrders} onSelectToken={onSelectToken} />}
        {tab === "twap" && <EmptyTab label="No active TWAP orders" />}
        {tab === "tradeHistory" && <TradeHistoryTab fills={fills} onSelectToken={onSelectToken} />}
        {tab === "fundingHistory" && <FundingHistoryTab funding={funding} />}
        {tab === "orderHistory" && <TradeHistoryTab fills={fills} onSelectToken={onSelectToken} />}
      </div>
    </div>
  );
}

// ─── Positions Tab ────────────────────────────────────────────────────────────

function PositionsTab({ positions, loading, error, closing, closingAll, tpSlMode, triggerPrice, submitting, actionResult, onSelectToken, onClose, onCloseAll, onTpSlToggle, onTriggerPriceChange, onTpSlSubmit }: {
  positions: UserPosition[]; loading: boolean; error: string | null;
  closing: string | null; closingAll: boolean; tpSlMode: TpSlMode; triggerPrice: string; submitting: boolean;
  actionResult: { coin: string; msg: string; ok: boolean } | null;
  onSelectToken?: (coin: string) => void;
  onClose: (pos: UserPosition) => void;
  onCloseAll: () => void;
  onTpSlToggle: (coin: string, type: "tp" | "sl") => void;
  onTriggerPriceChange: (v: string) => void;
  onTpSlSubmit: (pos: UserPosition) => void;
}) {
  if (positions.length === 0 && loading) return <div className="text-[11px] text-[var(--hl-muted)] text-center py-6">Loading positions...</div>;
  if (error && positions.length === 0) return <div className="text-[10px] text-[var(--hl-red)] text-center py-2">{error}</div>;
  if (positions.length === 0) return <div className="text-[11px] text-[var(--hl-muted)] text-center py-6">No open positions</div>;

  const allResult = actionResult?.coin === "ALL" ? actionResult : null;

  return (
    <div className="overflow-x-auto">
      {/* Close All button */}
      <div className="flex items-center justify-between px-1 py-1">
        <span className="text-[10px] text-[var(--hl-muted)]">{positions.length} position{positions.length !== 1 ? "s" : ""}</span>
        <div className="flex items-center gap-2">
          {allResult && <span className={`text-[9px] ${allResult.ok ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>{allResult.msg}</span>}
          <button
            onClick={onCloseAll}
            disabled={closingAll}
            className="px-2 py-0.5 text-[9px] font-semibold rounded bg-[rgba(240,88,88,0.15)] text-[var(--hl-red)] hover:bg-[rgba(240,88,88,0.3)] transition-colors disabled:opacity-50"
          >
            {closingAll ? "Closing..." : "Close All"}
          </button>
        </div>
      </div>
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-[var(--hl-muted)] text-[10px] uppercase tracking-wider border-b border-[var(--hl-border)]">
            <th className="text-left py-1 pr-2">Asset</th>
            <th className="text-right py-1 pr-2">Size</th>
            <th className="text-right py-1 pr-2">Value</th>
            <th className="text-right py-1 pr-2">Entry</th>
            <th className="text-right py-1 pr-2">Mark</th>
            <th className="text-right py-1 pr-2">PnL (ROE)</th>
            <th className="text-right py-1 pr-2">Liq.</th>
            <th className="text-right py-1 pr-2">Margin</th>
            <th className="text-right py-1 pr-2">Funding</th>
            <th className="text-right py-1">Actions</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const displayCoin = p.coin.includes(":") ? p.coin.split(":")[1] : p.coin;
            const pnl = p.unrealizedPnl ?? 0;
            const roe = (p.returnOnEquity ?? 0) * 100;
            const posVal = p.positionValue ?? 0;
            const margin = p.marginUsed ?? 0;
            const funding = p.cumFunding ?? 0;
            const mark = p.markPx ?? 0;
            const pnlColor = pnl >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]";
            const fundingColor = funding >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]";
            const isClosing = closing === p.coin;
            const result = actionResult?.coin === p.coin ? actionResult : null;
            const showTpSl = tpSlMode?.coin === p.coin;

            return (
              <tr key={p.coin} className="border-b border-[var(--hl-border)] border-opacity-30 hover:bg-[var(--hl-surface)] transition-colors">
                {/* Asset + side + leverage */}
                <td className="py-1.5 pr-2">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-[var(--foreground)] cursor-pointer hover:underline" onClick={() => onSelectToken?.(p.coin)}>{displayCoin}</span>
                    <span className={`px-1 py-0.5 rounded text-[8px] font-bold ${p.side === "long" ? "bg-[rgba(80,210,193,0.15)] text-[var(--hl-green)]" : "bg-[rgba(240,88,88,0.15)] text-[var(--hl-red)]"}`}>
                      {p.side === "long" ? "L" : "S"} {p.leverage ?? 0}x
                    </span>
                  </div>
                </td>
                {/* Size */}
                <td className="py-1.5 pr-2 text-right tabular-nums text-[var(--foreground)]">{Math.abs(p.size ?? 0).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                {/* Value (USDC) */}
                <td className="py-1.5 pr-2 text-right tabular-nums text-[var(--foreground)]">${posVal.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                {/* Entry */}
                <td className="py-1.5 pr-2 text-right tabular-nums text-[var(--hl-muted)]">${(p.entryPx ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                {/* Mark */}
                <td className="py-1.5 pr-2 text-right tabular-nums text-[var(--foreground)]">{mark ? `$${mark.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}</td>
                {/* PnL (ROE %) */}
                <td className={`py-1.5 pr-2 text-right tabular-nums font-medium ${pnlColor}`}>
                  {pnl >= 0 ? "+" : ""}${pnl.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  <span className="text-[9px] ml-0.5 opacity-70">({roe >= 0 ? "+" : ""}{roe.toFixed(1)}%)</span>
                </td>
                {/* Liq. price */}
                <td className="py-1.5 pr-2 text-right tabular-nums text-[var(--hl-muted)]">{p.liquidationPx ? `$${p.liquidationPx.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}</td>
                {/* Margin (type) */}
                <td className="py-1.5 pr-2 text-right tabular-nums">
                  <span className="text-[var(--foreground)]">${margin.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                  <span className="text-[9px] text-[var(--hl-muted)] ml-0.5">{p.leverageType || "cross"}</span>
                </td>
                {/* Funding */}
                <td className={`py-1.5 pr-2 text-right tabular-nums ${fundingColor}`}>
                  {funding !== 0 ? `${funding >= 0 ? "+" : ""}$${funding.toFixed(2)}` : "—"}
                </td>
                {/* Actions */}
                <td className="py-1.5 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <button onClick={(e) => { e.stopPropagation(); onClose(p); }} disabled={isClosing || closingAll} className="px-1.5 py-0.5 text-[9px] font-semibold rounded bg-[rgba(240,88,88,0.15)] text-[var(--hl-red)] hover:bg-[rgba(240,88,88,0.3)] transition-colors disabled:opacity-50">{isClosing ? "..." : "Close"}</button>
                    <button onClick={(e) => { e.stopPropagation(); onTpSlToggle(p.coin, "tp"); }} className={`px-1.5 py-0.5 text-[9px] font-semibold rounded transition-colors ${showTpSl && tpSlMode?.type === "tp" ? "bg-[rgba(80,210,193,0.3)] text-[var(--hl-green)]" : "bg-[rgba(80,210,193,0.1)] text-[var(--hl-green)] hover:bg-[rgba(80,210,193,0.2)]"}`}>TP</button>
                    <button onClick={(e) => { e.stopPropagation(); onTpSlToggle(p.coin, "sl"); }} className={`px-1.5 py-0.5 text-[9px] font-semibold rounded transition-colors ${showTpSl && tpSlMode?.type === "sl" ? "bg-[rgba(240,88,88,0.3)] text-[var(--hl-red)]" : "bg-[rgba(240,88,88,0.1)] text-[var(--hl-red)] hover:bg-[rgba(240,88,88,0.2)]"}`}>SL</button>
                  </div>
                  {showTpSl && (
                    <div className="flex items-center gap-1 mt-1 justify-end">
                      <span className="text-[9px] text-[var(--hl-muted)]">{tpSlMode!.type === "tp" ? "TP" : "SL"} $</span>
                      <input type="number" value={triggerPrice} onChange={(e) => onTriggerPriceChange(e.target.value)} placeholder={p.entryPx.toFixed(2)} className="w-20 px-1 py-0.5 text-[10px] bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded text-[var(--foreground)] tabular-nums outline-none" onClick={(e) => e.stopPropagation()} />
                      <button onClick={(e) => { e.stopPropagation(); onTpSlSubmit(p); }} disabled={submitting || !triggerPrice} className="px-1.5 py-0.5 text-[9px] font-semibold rounded bg-[var(--hl-accent)] text-[var(--background)] hover:opacity-80 transition-opacity disabled:opacity-50">{submitting ? "..." : "Set"}</button>
                    </div>
                  )}
                  {result && <div className={`text-[9px] mt-0.5 ${result.ok ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>{result.msg}</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Balances Tab ─────────────────────────────────────────────────────────────

function BalancesTab({ account }: { account: UserAccount | null }) {
  if (!account) return <EmptyTab label="No balance data" />;
  return (
    <div className="py-3 px-1">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-[var(--hl-muted)] text-[10px] uppercase tracking-wider border-b border-[var(--hl-border)]">
            <th className="text-left py-1">Asset</th>
            <th className="text-right py-1">Equity</th>
            <th className="text-right py-1">Available</th>
            <th className="text-right py-1">In Use</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-[var(--hl-border)] border-opacity-30">
            <td className="py-1.5 font-medium text-[var(--foreground)]">USDC</td>
            <td className="py-1.5 text-right tabular-nums text-[var(--foreground)]">${account.accountValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
            <td className="py-1.5 text-right tabular-nums text-[var(--foreground)]">${account.withdrawable.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
            <td className="py-1.5 text-right tabular-nums text-[var(--hl-muted)]">${account.totalMarginUsed.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ─── Open Orders Tab ──────────────────────────────────────────────────────────

function OpenOrdersTab({ orders, onSelectToken }: { orders: OpenOrder[]; onSelectToken?: (coin: string) => void }) {
  if (orders.length === 0) return <EmptyTab label="No open orders" />;
  return (
    <div className="overflow-x-auto py-1">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-[var(--hl-muted)] text-[10px] uppercase tracking-wider border-b border-[var(--hl-border)]">
            <th className="text-left py-1">Asset</th>
            <th className="text-left py-1">Side</th>
            <th className="text-left py-1">Type</th>
            <th className="text-right py-1">Size</th>
            <th className="text-right py-1">Price</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o, i) => (
            <tr key={`${o.coin}-${i}`} className="border-b border-[var(--hl-border)] border-opacity-30">
              <td className="py-1.5 font-medium text-[var(--foreground)] cursor-pointer hover:underline" onClick={() => onSelectToken?.(o.coin)}>{o.coin}</td>
              <td className="py-1.5">
                <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold ${o.side === "B" ? "bg-[rgba(80,210,193,0.15)] text-[var(--hl-green)]" : "bg-[rgba(240,88,88,0.15)] text-[var(--hl-red)]"}`}>
                  {o.side === "B" ? "BUY" : "SELL"}
                </span>
              </td>
              <td className="py-1.5 text-[var(--hl-muted)]">{o.orderType}</td>
              <td className="py-1.5 text-right tabular-nums text-[var(--foreground)]">{o.sz}</td>
              <td className="py-1.5 text-right tabular-nums text-[var(--foreground)]">${parseFloat(o.limitPx).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Trade History Tab ────────────────────────────────────────────────────────

function TradeHistoryTab({ fills, onSelectToken }: { fills: Fill[]; onSelectToken?: (coin: string) => void }) {
  if (fills.length === 0) return <EmptyTab label="No recent trades (last 7 days)" />;
  return (
    <div className="overflow-x-auto py-1 max-h-[240px] overflow-y-auto">
      <table className="w-full text-[11px]">
        <thead className="sticky top-0 bg-[var(--background)]">
          <tr className="text-[var(--hl-muted)] text-[10px] uppercase tracking-wider border-b border-[var(--hl-border)]">
            <th className="text-left py-1">Time</th>
            <th className="text-left py-1">Asset</th>
            <th className="text-left py-1">Side</th>
            <th className="text-right py-1">Size</th>
            <th className="text-right py-1">Price</th>
            <th className="text-right py-1">Fee</th>
            <th className="text-right py-1">PnL</th>
          </tr>
        </thead>
        <tbody>
          {fills.map((f, i) => {
            const pnl = parseFloat(f.closedPnl);
            const isBuy = f.side === "B";
            return (
              <tr key={`${f.coin}-${f.time}-${i}`} className="border-b border-[var(--hl-border)] border-opacity-30">
                <td className="py-1 text-[var(--hl-muted)] tabular-nums text-[10px]">{new Date(f.time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                <td className="py-1 font-medium text-[var(--foreground)] cursor-pointer hover:underline" onClick={() => onSelectToken?.(f.coin)}>{f.coin}</td>
                <td className="py-1">
                  <span className={`px-1 py-0.5 rounded text-[9px] font-semibold ${isBuy ? "bg-[rgba(80,210,193,0.15)] text-[var(--hl-green)]" : "bg-[rgba(240,88,88,0.15)] text-[var(--hl-red)]"}`}>
                    {isBuy ? "BUY" : "SELL"}
                  </span>
                </td>
                <td className="py-1 text-right tabular-nums text-[var(--foreground)]">{f.sz}</td>
                <td className="py-1 text-right tabular-nums text-[var(--foreground)]">${parseFloat(f.px).toLocaleString()}</td>
                <td className="py-1 text-right tabular-nums text-[var(--hl-muted)]">${parseFloat(f.fee).toFixed(2)}</td>
                <td className={`py-1 text-right tabular-nums ${pnl > 0 ? "text-[var(--hl-green)]" : pnl < 0 ? "text-[var(--hl-red)]" : "text-[var(--hl-muted)]"}`}>
                  {pnl !== 0 ? `${pnl > 0 ? "+" : ""}$${pnl.toFixed(2)}` : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Funding History Tab ──────────────────────────────────────────────────────

function FundingHistoryTab({ funding }: { funding: FundingEntry[] }) {
  if (funding.length === 0) return <EmptyTab label="No funding payments (last 7 days)" />;
  return (
    <div className="overflow-x-auto py-1 max-h-[240px] overflow-y-auto">
      <table className="w-full text-[11px]">
        <thead className="sticky top-0 bg-[var(--background)]">
          <tr className="text-[var(--hl-muted)] text-[10px] uppercase tracking-wider border-b border-[var(--hl-border)]">
            <th className="text-left py-1">Time</th>
            <th className="text-left py-1">Asset</th>
            <th className="text-right py-1">Payment</th>
            <th className="text-right py-1">Rate</th>
          </tr>
        </thead>
        <tbody>
          {funding.map((f, i) => {
            const payment = parseFloat(f.usdc);
            return (
              <tr key={`${f.coin}-${f.time}-${i}`} className="border-b border-[var(--hl-border)] border-opacity-30">
                <td className="py-1 text-[var(--hl-muted)] tabular-nums text-[10px]">{new Date(f.time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                <td className="py-1 font-medium text-[var(--foreground)]">{f.coin}</td>
                <td className={`py-1 text-right tabular-nums ${payment >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                  {payment >= 0 ? "+" : ""}${payment.toFixed(4)}
                </td>
                <td className="py-1 text-right tabular-nums text-[var(--hl-muted)]">{(parseFloat(f.fundingRate) * 100).toFixed(4)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Empty Tab ────────────────────────────────────────────────────────────────

function EmptyTab({ label }: { label: string }) {
  return <div className="text-[11px] text-[var(--hl-muted)] text-center py-6">{label}</div>;
}
