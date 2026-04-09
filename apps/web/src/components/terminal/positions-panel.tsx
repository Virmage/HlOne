"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getUserPositions, type UserPosition, type UserAccount } from "@/lib/api";
import { useSafeAccount } from "@/hooks/use-safe-account";
import { setAccountInfo } from "@/hooks/use-account-info";

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
  const [triggerOrders, setTriggerOrders] = useState<Record<string, { tp?: string; sl?: string }>>({});
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
        setTriggerOrders(data.triggerOrders || {});
        // Publish to global store for header + chart bar display
        const uPnl = data.positions.reduce((s: number, p: UserPosition) => s + p.unrealizedPnl, 0);
        setAccountInfo(data.account ? {
          accountValue: data.account.accountValue,
          unrealizedPnl: uPnl,
          totalMarginUsed: data.account.totalMarginUsed,
          totalNotional: data.account.totalNotional,
          withdrawable: data.account.withdrawable,
          positionCount: data.positions.length,
        } : null);
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
    if (!isConnected || !address) {
      setAccountInfo(null);
      return;
    }
    fetchPositions();
    const interval = setInterval(() => {
      // Skip polling when tab is hidden — avoids stale/failed fetches
      if (document.hidden) return;
      fetchPositions();
    }, 5_000);
    return () => clearInterval(interval);
  }, [isConnected, address, fetchPositions]);

  // Fetch tab-specific data when tab changes
  const fillsFetched = useRef(false);
  const fundingFetched = useRef(false);
  useEffect(() => {
    if (!isConnected || !address) return;
    if (tab === "tradeHistory" && !fillsFetched.current) { fillsFetched.current = true; fetchFills(); }
    if (tab === "fundingHistory" && !fundingFetched.current) { fundingFetched.current = true; fetchFunding(); }
  }, [tab, isConnected, address, fetchFills, fetchFunding]);

  useEffect(() => {
    if (!actionResult) return;
    const t = setTimeout(() => setActionResult(null), 5000);
    return () => clearTimeout(t);
  }, [actionResult]);

  const handleClose = useCallback(async (pos: UserPosition, closeSize?: number) => {
    if (!address) return;
    const size = closeSize ?? Math.abs(pos.size);
    setClosing(pos.coin);
    setActionResult(null);
    try {
      const [wagmiCore, exchange, wagmiConfig] = await Promise.all([
        import("@wagmi/core"), import("@/lib/hl-exchange"), import("@/config/wagmi"),
      ]);
      const walletClient = await wagmiCore.getWalletClient(wagmiConfig.config);
      if (!walletClient) { setClosing(null); return; }
      let agentResult = await exchange.ensureAgent(walletClient, address as `0x${string}`);
      if (agentResult.error) { setActionResult({ coin: pos.coin, msg: friendlyError(agentResult.error), ok: false }); setClosing(null); return; }
      const builderOk = await exchange.checkBuilderApproval(address);
      if (!builderOk) {
        const approveResult = await exchange.approveBuilderFee(walletClient, address as `0x${string}`);
        if (!approveResult.success) { setActionResult({ coin: pos.coin, msg: friendlyError(approveResult.error), ok: false }); setClosing(null); return; }
      }
      let result = await exchange.closePosition(agentResult.agentKey, address as `0x${string}`, pos.coin, size, pos.side === "long");
      if (!result.success && result.error === exchange.STALE_AGENT_MSG) {
        agentResult = await exchange.ensureAgent(walletClient, address as `0x${string}`);
        if (!agentResult.error) {
          result = await exchange.closePosition(agentResult.agentKey, address as `0x${string}`, pos.coin, size, pos.side === "long");
        }
      }
      setActionResult({ coin: pos.coin, msg: result.success ? (size < Math.abs(pos.size) ? `Closed ${size}` : "Closed") : friendlyError(result.error), ok: result.success });
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

      // Step 1: Ensure agent wallet
      let agentResult = await exchange.ensureAgent(walletClient, address as `0x${string}`);
      if (agentResult.error) { setActionResult({ coin: pos.coin, msg: friendlyError(agentResult.error), ok: false }); setSubmitting(false); return; }

      // Step 2: Check builder fee approval (only needed for TP which uses limit orders with builder fee;
      // SL trigger orders don't include builder fee)
      if (tpSlMode.type === "tp") {
        const builderOk = await exchange.checkBuilderApproval(address);
        if (!builderOk) {
          console.log("[tpsl] Builder fee not approved, requesting approval...");
          const approveResult = await exchange.approveBuilderFee(walletClient, address as `0x${string}`);
          if (!approveResult.success) {
            setActionResult({ coin: pos.coin, msg: `Builder fee: ${friendlyError(approveResult.error)}`, ok: false });
            setSubmitting(false);
            return;
          }
        }
      }

      // Step 3: Place trigger order
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
      // Show raw error for SL debugging (friendlyError hides details)
      setActionResult({ coin: pos.coin, msg: result.success ? `${tpSlMode.type.toUpperCase()} set at $${triggerPrice}` : (result.error || "Unknown error"), ok: result.success });
      if (result.success) { setTpSlMode(null); setTriggerPrice(""); fetchPositions(); }
    } catch (err) {
      setActionResult({ coin: pos.coin, msg: friendlyError((err as Error).message), ok: false });
    } finally {
      setSubmitting(false);
    }
  }, [address, tpSlMode, triggerPrice, fetchPositions]);

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

      // Ensure builder fee approved once for all closes
      const builderOk = await exchange.checkBuilderApproval(address);
      if (!builderOk) {
        const approveResult = await exchange.approveBuilderFee(walletClient, address as `0x${string}`);
        if (!approveResult.success) { setActionResult({ coin: "ALL", msg: friendlyError(approveResult.error), ok: false }); setClosingAll(false); return; }
      }

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

  // Reverse a position: close current + open opposite at 2x size (net result: flipped position)
  const handleReverse = useCallback(async (pos: UserPosition) => {
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
      if (agentResult.error) { setActionResult({ coin: pos.coin, msg: friendlyError(agentResult.error), ok: false }); setClosing(null); return; }
      const builderOk = await exchange.checkBuilderApproval(address);
      if (!builderOk) {
        const approveResult = await exchange.approveBuilderFee(walletClient, address as `0x${string}`);
        if (!approveResult.success) { setActionResult({ coin: pos.coin, msg: friendlyError(approveResult.error), ok: false }); setClosing(null); return; }
      }
      // Place a market order for 2x size in opposite direction to flip the position
      const result = await exchange.placeOrder(agentResult.agentKey, address as `0x${string}`, {
        asset: pos.coin,
        isBuy: pos.side === "short", // opposite side
        size: Math.abs(pos.size) * 2,
        orderType: "market",
      });
      setActionResult({ coin: pos.coin, msg: result.success ? "Reversed" : friendlyError(result.error), ok: result.success });
      if (result.success) fetchPositions();
    } catch (err) {
      setActionResult({ coin: pos.coin, msg: friendlyError((err as Error).message), ok: false });
    } finally {
      setClosing(null);
    }
  }, [address, fetchPositions]);

  const handleLimitClose = useCallback(async (pos: UserPosition, size: number, price: number) => {
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
      if (agentResult.error) { setActionResult({ coin: pos.coin, msg: friendlyError(agentResult.error), ok: false }); setClosing(null); return; }
      const builderOk = await exchange.checkBuilderApproval(address);
      if (!builderOk) {
        const approveResult = await exchange.approveBuilderFee(walletClient, address as `0x${string}`);
        if (!approveResult.success) { setActionResult({ coin: pos.coin, msg: friendlyError(approveResult.error), ok: false }); setClosing(null); return; }
      }
      let result = await exchange.placeOrder(agentResult.agentKey, address as `0x${string}`, {
        asset: pos.coin,
        isBuy: pos.side === "long" ? false : true,
        size,
        orderType: "limit",
        limitPrice: price,
        reduceOnly: true,
      });
      if (!result.success && result.error === exchange.STALE_AGENT_MSG) {
        agentResult = await exchange.ensureAgent(walletClient, address as `0x${string}`);
        if (!agentResult.error) {
          result = await exchange.placeOrder(agentResult.agentKey, address as `0x${string}`, {
            asset: pos.coin,
            isBuy: pos.side === "long" ? false : true,
            size,
            orderType: "limit",
            limitPrice: price,
            reduceOnly: true,
          });
        }
      }
      setActionResult({ coin: pos.coin, msg: result.success ? `Limit close @ $${price}` : friendlyError(result.error), ok: result.success });
      if (result.success) fetchPositions();
    } catch (err) {
      setActionResult({ coin: pos.coin, msg: friendlyError((err as Error).message), ok: false });
    } finally {
      setClosing(null);
    }
  }, [address, fetchPositions]);

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
    <div className="flex flex-col">
      {/* Tab bar */}
      <div className="flex items-center border-b border-[var(--hl-border)] flex-shrink-0">
        <div className="flex items-center gap-0 overflow-x-auto scrollbar-none flex-1">
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
        </div>
        {positions.length > 0 && (
          <div className="flex items-center gap-2 px-2 flex-shrink-0">
            {actionResult?.coin === "ALL" && <span className={`text-[9px] ${actionResult.ok ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>{actionResult.msg}</span>}
            <button
              onClick={handleCloseAll}
              disabled={closingAll}
              className="px-2 py-0.5 text-[9px] font-semibold rounded bg-[rgba(240,88,88,0.15)] text-[var(--hl-red)] hover:bg-[rgba(240,88,88,0.3)] transition-colors disabled:opacity-50 whitespace-nowrap"
            >
              {closingAll ? "Closing..." : "Close All"}
            </button>
          </div>
        )}
      </div>

      {/* Tab content */}
      <div className="min-h-[40px] flex-1">
        {tab === "positions" && <PositionsTab positions={positions} loading={loading} error={error} closing={closing} closingAll={closingAll} tpSlMode={tpSlMode} triggerPrice={triggerPrice} submitting={submitting} actionResult={actionResult} triggerOrders={triggerOrders} onSelectToken={onSelectToken} onClose={handleClose} onLimitClose={handleLimitClose} onReverse={handleReverse} onTpSlToggle={(coin, type) => { setTpSlMode(tpSlMode?.coin === coin && tpSlMode?.type === type ? null : { coin, type }); setTriggerPrice(""); }} onTriggerPriceChange={setTriggerPrice} onTpSlSubmit={handleTpSl} />}
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

function PositionsTab({ positions, loading, error, closing, closingAll, tpSlMode, triggerPrice, submitting, actionResult, triggerOrders, onSelectToken, onClose, onLimitClose, onReverse, onTpSlToggle, onTriggerPriceChange, onTpSlSubmit }: {
  positions: UserPosition[]; loading: boolean; error: string | null;
  closing: string | null; closingAll: boolean; tpSlMode: TpSlMode; triggerPrice: string; submitting: boolean;
  actionResult: { coin: string; msg: string; ok: boolean } | null;
  triggerOrders: Record<string, { tp?: string; sl?: string }>;
  onSelectToken?: (coin: string) => void;
  onClose: (pos: UserPosition, closeSize?: number) => void;
  onLimitClose: (pos: UserPosition, size: number, price: number) => void;
  onReverse: (pos: UserPosition) => void;
  onTpSlToggle: (coin: string, type: "tp" | "sl") => void;
  onTriggerPriceChange: (v: string) => void;
  onTpSlSubmit: (pos: UserPosition) => void;
}) {
  // Local state for TP/SL popup
  const [tpSlPopup, setTpSlPopup] = useState<string | null>(null); // coin or null
  const [popupTp, setPopupTp] = useState("");
  const [popupSl, setPopupSl] = useState("");
  // Confirmation popup state
  const [confirmAction, setConfirmAction] = useState<{ type: "close" | "reverse"; pos: UserPosition } | null>(null);
  const [closePercent, setClosePercent] = useState(100);
  const [closeMode, setCloseMode] = useState<"market" | "limit">("market");
  const [limitClosePrice, setLimitClosePrice] = useState("");
  const [skipConfirmClose, setSkipConfirmClose] = useState(() => typeof window !== "undefined" && localStorage.getItem("hlone_skip_confirm_close") === "1");
  const [skipConfirmReverse, setSkipConfirmReverse] = useState(() => typeof window !== "undefined" && localStorage.getItem("hlone_skip_confirm_reverse") === "1");

  if (positions.length === 0 && loading) return <div className="text-[11px] text-[var(--hl-muted)] text-center py-6">Loading positions...</div>;
  if (error && positions.length === 0) return <div className="text-[10px] text-[var(--hl-red)] text-center py-2">{error}</div>;
  if (positions.length === 0) return <div className="text-[11px] text-[var(--hl-muted)] text-center py-6">No open positions</div>;

  // Find the position for the popup
  const popupPos = tpSlPopup ? positions.find(p => p.coin === tpSlPopup) : null;
  const popupDisplayCoin = popupPos ? (popupPos.coin.includes(":") ? popupPos.coin.split(":")[1] : popupPos.coin) : "";

  return (
    <div className="overflow-x-auto relative">
      {/* TP/SL Modal Overlay */}
      {popupPos && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setTpSlPopup(null)}>
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/40" />
          {/* Modal */}
          <div className="relative bg-[var(--background)] border border-[var(--hl-border)] rounded-lg shadow-2xl p-4 w-[280px]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <span className="text-[12px] font-semibold text-[var(--foreground)]">{popupDisplayCoin} — Set TP / SL</span>
              <button onClick={() => setTpSlPopup(null)} className="text-[var(--hl-muted)] hover:text-[var(--foreground)] text-[16px] leading-none">&times;</button>
            </div>
            {/* Entry / Mark reference */}
            <div className="flex justify-between text-[10px] text-[var(--hl-muted)] mb-3 pb-2 border-b border-[var(--hl-border)]">
              <span>Entry: ${popupPos.entryPx.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
              <span>Mark: {popupPos.markPx ? `$${popupPos.markPx.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}</span>
              <span className={`font-medium ${popupPos.side === "long" ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>{popupPos.side === "long" ? "LONG" : "SHORT"}</span>
            </div>
            {/* Take Profit */}
            <div className="mb-3">
              <label className="text-[10px] text-[var(--hl-green)] font-semibold uppercase tracking-wider">Take Profit</label>
              <div className="flex items-center gap-1.5 mt-1">
                <span className="text-[11px] text-[var(--hl-muted)]">$</span>
                <input
                  type="number"
                  value={popupTp}
                  onChange={(e) => setPopupTp(e.target.value)}
                  placeholder={popupPos.entryPx.toFixed(2)}
                  className="flex-1 px-2 py-1.5 text-[12px] bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded text-[var(--foreground)] tabular-nums outline-none focus:border-[var(--hl-green)]"
                />
                <button
                  onClick={() => { onTpSlToggle(popupPos.coin, "tp"); onTriggerPriceChange(popupTp); setTimeout(() => onTpSlSubmit(popupPos), 50); }}
                  disabled={submitting || !popupTp}
                  className="px-3 py-1.5 text-[10px] font-semibold rounded bg-[rgba(80,210,193,0.15)] text-[var(--hl-green)] hover:bg-[rgba(80,210,193,0.3)] transition-colors disabled:opacity-50"
                >
                  {submitting && tpSlMode?.type === "tp" ? "..." : "Set"}
                </button>
              </div>
            </div>
            {/* Stop Loss */}
            <div className="mb-2">
              <label className="text-[10px] text-[var(--hl-red)] font-semibold uppercase tracking-wider">Stop Loss</label>
              <div className="flex items-center gap-1.5 mt-1">
                <span className="text-[11px] text-[var(--hl-muted)]">$</span>
                <input
                  type="number"
                  value={popupSl}
                  onChange={(e) => setPopupSl(e.target.value)}
                  placeholder={popupPos.entryPx.toFixed(2)}
                  className="flex-1 px-2 py-1.5 text-[12px] bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded text-[var(--foreground)] tabular-nums outline-none focus:border-[var(--hl-red)]"
                />
                <button
                  onClick={() => { onTpSlToggle(popupPos.coin, "sl"); onTriggerPriceChange(popupSl); setTimeout(() => onTpSlSubmit(popupPos), 50); }}
                  disabled={submitting || !popupSl}
                  className="px-3 py-1.5 text-[10px] font-semibold rounded bg-[rgba(240,88,88,0.15)] text-[var(--hl-red)] hover:bg-[rgba(240,88,88,0.3)] transition-colors disabled:opacity-50"
                >
                  {submitting && tpSlMode?.type === "sl" ? "..." : "Set"}
                </button>
              </div>
            </div>
            {/* Result message */}
            {actionResult?.coin === popupPos.coin && (
              <div className={`text-[10px] mt-2 pt-2 border-t border-[var(--hl-border)] ${actionResult.ok ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>{actionResult.msg}</div>
            )}
          </div>
        </div>
      )}

      {/* Confirmation / Close Modal */}
      {confirmAction && (() => {
        const { type, pos } = confirmAction;
        const displayCoin = pos.coin.includes(":") ? pos.coin.split(":")[1] : pos.coin;
        const fullSize = Math.abs(pos.size);
        const closeSize = type === "close" ? fullSize * (closePercent / 100) : fullSize;

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => { setConfirmAction(null); setClosePercent(100); setCloseMode("market"); setLimitClosePrice(""); }}>
            <div className="absolute inset-0 bg-black/40" />
            <div className="relative bg-[var(--background)] border border-[var(--hl-border)] rounded-lg shadow-2xl p-4 w-[300px]" onClick={(e) => e.stopPropagation()}>
              <div className="text-[12px] font-semibold text-[var(--foreground)] mb-2">
                {type === "close" ? "Close Position" : "Reverse Position?"}
              </div>
              <div className="text-[11px] text-[var(--hl-muted)] mb-3">
                {displayCoin} {pos.side.toUpperCase()} &middot; {fullSize} @ ${pos.entryPx.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </div>

              {type === "close" && (
                <>
                  {/* Market / Limit toggle */}
                  <div className="flex gap-px bg-[var(--hl-border)] rounded overflow-hidden mb-3">
                    <button onClick={() => setCloseMode("market")} className={`flex-1 py-1.5 text-[10px] font-semibold transition-colors ${closeMode === "market" ? "bg-[var(--hl-accent)] text-white" : "bg-[var(--hl-surface)] text-[var(--hl-muted)]"}`}>Market</button>
                    <button onClick={() => setCloseMode("limit")} className={`flex-1 py-1.5 text-[10px] font-semibold transition-colors ${closeMode === "limit" ? "bg-[var(--hl-accent)] text-white" : "bg-[var(--hl-surface)] text-[var(--hl-muted)]"}`}>Limit</button>
                  </div>

                  {/* Limit price input */}
                  {closeMode === "limit" && (
                    <div className="mb-3">
                      <div className="text-[10px] text-[var(--hl-muted)] mb-1">Limit Price</div>
                      <div className="flex items-center bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded px-2 py-1.5">
                        <span className="text-[11px] text-[var(--hl-muted)] mr-1">$</span>
                        <input type="number" value={limitClosePrice} onChange={(e) => setLimitClosePrice(e.target.value)} placeholder={pos.markPx?.toFixed(2) || "0.00"} className="flex-1 bg-transparent text-right text-[12px] text-[var(--foreground)] tabular-nums placeholder:text-[var(--hl-muted)] outline-none font-medium" />
                      </div>
                    </div>
                  )}

                  {/* Close size slider */}
                  <div className="mb-3">
                    <div className="flex items-center justify-between text-[10px] mb-1">
                      <span className="text-[var(--hl-muted)]">Close Amount</span>
                      <span className="text-[var(--foreground)] font-medium tabular-nums">{closePercent}% &middot; {closeSize.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
                    </div>
                    <input type="range" min={1} max={100} value={closePercent} onChange={(e) => setClosePercent(parseInt(e.target.value))} className="w-full h-1.5 rounded-full appearance-none bg-[var(--hl-border)] accent-[var(--hl-accent)] cursor-pointer" />
                    <div className="flex justify-between mt-1">
                      {[25, 50, 75, 100].map(pct => (
                        <button key={pct} onClick={() => setClosePercent(pct)} className={`px-2 py-0.5 text-[9px] rounded font-medium transition-colors ${closePercent === pct ? "bg-[var(--hl-accent)] text-white" : "bg-[var(--hl-surface)] text-[var(--hl-muted)] hover:text-[var(--foreground)]"}`}>{pct}%</button>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {type === "reverse" && (
                <div className="text-[11px] text-[var(--hl-muted)] mb-3">
                  Flip from {pos.side.toUpperCase()} to {pos.side === "long" ? "SHORT" : "LONG"}
                </div>
              )}

              <div className="flex items-center gap-2 mb-3">
                <input type="checkbox" id="skip-confirm" checked={type === "close" ? skipConfirmClose : skipConfirmReverse} onChange={(e) => { const key = type === "close" ? "hlone_skip_confirm_close" : "hlone_skip_confirm_reverse"; if (e.target.checked) localStorage.setItem(key, "1"); else localStorage.removeItem(key); if (type === "close") setSkipConfirmClose(e.target.checked); else setSkipConfirmReverse(e.target.checked); }} className="accent-[var(--hl-accent)]" />
                <label htmlFor="skip-confirm" className="text-[10px] text-[var(--hl-muted)] cursor-pointer">Don&apos;t show again</label>
              </div>
              <div className="flex gap-2">
                <button onClick={() => { setConfirmAction(null); setClosePercent(100); setCloseMode("market"); setLimitClosePrice(""); }} className="flex-1 px-3 py-1.5 text-[10px] font-semibold rounded bg-[var(--hl-surface)] text-[var(--hl-text)] border border-[var(--hl-border)] hover:bg-[var(--hl-border)] transition-colors">Cancel</button>
                <button
                  onClick={() => {
                    setConfirmAction(null);
                    if (type === "close") {
                      if (closeMode === "limit" && limitClosePrice) {
                        onLimitClose(pos, closeSize, parseFloat(limitClosePrice));
                      } else {
                        onClose(pos, closeSize);
                      }
                      setClosePercent(100); setCloseMode("market"); setLimitClosePrice("");
                    } else {
                      onReverse(pos);
                    }
                  }}
                  disabled={closeMode === "limit" && !limitClosePrice}
                  className={`flex-1 px-3 py-1.5 text-[10px] font-semibold rounded transition-colors disabled:opacity-50 ${type === "close" ? "bg-[rgba(240,88,88,0.18)] text-[var(--hl-red)] hover:bg-[rgba(240,88,88,0.35)]" : "bg-[rgba(80,210,193,0.18)] text-[var(--hl-green)] hover:bg-[rgba(80,210,193,0.35)]"}`}
                >
                  {type === "close" ? (closeMode === "limit" ? "Limit Close" : "Market Close") : "Confirm"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

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
            <th className="text-right py-1 pr-2">TP / SL</th>
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
            const mark = p.markPx ?? 0;
            const pnlColor = pnl >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]";
            const isClosing = closing === p.coin;
            const result = actionResult?.coin === p.coin ? actionResult : null;
            const showPopup = tpSlPopup === p.coin;

            return (
              <tr key={p.coin} className="border-b border-[var(--hl-border)] border-opacity-30 hover:bg-[var(--hl-surface)] transition-colors relative">
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
                <td className="py-1.5 pr-2 text-right tabular-nums text-[var(--foreground)]">{mark > 0 ? `$${mark.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}</td>
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
                {/* TP / SL */}
                <td className="py-1.5 pr-2 text-right tabular-nums text-[10px]">
                  {(() => {
                    const trig = triggerOrders[p.coin];
                    if (!trig?.tp && !trig?.sl) return <span className="text-[var(--hl-muted)]">—</span>;
                    return (
                      <div className="flex flex-col items-end gap-0.5">
                        {trig?.tp && <span className="text-[var(--hl-green)]">TP ${parseFloat(trig.tp).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>}
                        {trig?.sl && <span className="text-[var(--hl-red)]">SL ${parseFloat(trig.sl).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>}
                      </div>
                    );
                  })()}
                </td>
                {/* Actions */}
                <td className="py-1.5 text-right">
                  <div className="flex items-center justify-end gap-1">
                    {/* Market Close */}
                    <button onClick={(e) => { e.stopPropagation(); if (skipConfirmClose) onClose(p); else setConfirmAction({ type: "close", pos: p }); }} disabled={isClosing || closingAll} className="px-2.5 py-1 text-[10px] font-semibold rounded bg-[rgba(240,88,88,0.18)] text-[var(--hl-red)] hover:bg-[rgba(240,88,88,0.35)] transition-colors disabled:opacity-50">{isClosing ? "..." : "Close"}</button>
                    {/* TP/SL popup toggle */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (showPopup) { setTpSlPopup(null); } else {
                          const trig = triggerOrders[p.coin];
                          setPopupTp(trig?.tp ? parseFloat(trig.tp).toString() : "");
                          setPopupSl(trig?.sl ? parseFloat(trig.sl).toString() : "");
                          setTpSlPopup(p.coin);
                        }
                      }}
                      className={`px-2 py-1 text-[10px] font-semibold rounded transition-colors ${showPopup ? "bg-[var(--hl-accent)] text-[var(--background)]" : "bg-[var(--hl-surface)] text-[var(--hl-text)] border border-[var(--hl-border)] hover:bg-[var(--hl-border)]"}`}
                    >
                      TP/SL
                    </button>
                    {/* Reverse */}
                    <button
                      onClick={(e) => { e.stopPropagation(); if (skipConfirmReverse) onReverse(p); else setConfirmAction({ type: "reverse", pos: p }); }}
                      disabled={isClosing || closingAll}
                      title="Reverse position"
                      className="px-1.5 py-1 text-[10px] font-semibold rounded bg-[var(--hl-surface)] text-[var(--hl-text)] border border-[var(--hl-border)] hover:bg-[var(--hl-border)] transition-colors disabled:opacity-50"
                    >
                      &#8645;
                    </button>
                  </div>
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
            const payment = parseFloat(f.usdc || "0");
            const rate = parseFloat(f.fundingRate || "0");
            return (
              <tr key={`${f.coin}-${f.time}-${i}`} className="border-b border-[var(--hl-border)] border-opacity-30">
                <td className="py-1 text-[var(--hl-muted)] tabular-nums text-[10px]">{new Date(f.time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                <td className="py-1 font-medium text-[var(--foreground)]">{f.coin}</td>
                <td className={`py-1 text-right tabular-nums ${payment >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                  {payment >= 0 ? "+" : ""}${payment.toFixed(4)}
                </td>
                <td className="py-1 text-right tabular-nums text-[var(--hl-muted)]">{(rate * 100).toFixed(4)}%</td>
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
