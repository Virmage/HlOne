"use client";

import { useState, useEffect, useCallback } from "react";
import { getUserPositions, type UserPosition, type UserAccount } from "@/lib/api";
import { useSafeAccount } from "@/hooks/use-safe-account";

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

  const fetchPositions = useCallback(async () => {
    if (!address) return;
    // Only show loading on very first fetch — subsequent refreshes keep stale data visible
    if (positions.length === 0 && !account) setLoading(true);
    try {
      const data = await getUserPositions(address);
      setPositions(data.positions);
      setAccount(data.account);
      setOpenOrders(data.openOrders || []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [address, positions.length, account]);

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
    const interval = setInterval(fetchPositions, 15_000);
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
      const result = await exchange.closePosition(walletClient, address as `0x${string}`, pos.coin, Math.abs(pos.size), pos.side === "long");
      setActionResult({ coin: pos.coin, msg: result.success ? "Closed" : (result.error || "Failed"), ok: result.success });
      if (result.success) fetchPositions();
    } catch (err) {
      setActionResult({ coin: pos.coin, msg: (err as Error).message, ok: false });
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
      const result = await exchange.placeTriggerOrder(walletClient, address as `0x${string}`, {
        asset: pos.coin, isLong: pos.side === "long", size: Math.abs(pos.size),
        triggerPrice: parseFloat(triggerPrice), type: tpSlMode.type,
      });
      setActionResult({ coin: pos.coin, msg: result.success ? `${tpSlMode.type.toUpperCase()} set at $${triggerPrice}` : (result.error || "Failed"), ok: result.success });
      if (result.success) { setTpSlMode(null); setTriggerPrice(""); }
    } catch (err) {
      setActionResult({ coin: pos.coin, msg: (err as Error).message, ok: false });
    } finally {
      setSubmitting(false);
    }
  }, [address, tpSlMode, triggerPrice]);

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
        {tab === "positions" && <PositionsTab positions={positions} loading={loading} error={error} closing={closing} tpSlMode={tpSlMode} triggerPrice={triggerPrice} submitting={submitting} actionResult={actionResult} onSelectToken={onSelectToken} onClose={handleClose} onTpSlToggle={(coin, type) => { setTpSlMode(tpSlMode?.coin === coin && tpSlMode?.type === type ? null : { coin, type }); setTriggerPrice(""); }} onTriggerPriceChange={setTriggerPrice} onTpSlSubmit={handleTpSl} />}
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

function PositionsTab({ positions, loading, error, closing, tpSlMode, triggerPrice, submitting, actionResult, onSelectToken, onClose, onTpSlToggle, onTriggerPriceChange, onTpSlSubmit }: {
  positions: UserPosition[]; loading: boolean; error: string | null;
  closing: string | null; tpSlMode: TpSlMode; triggerPrice: string; submitting: boolean;
  actionResult: { coin: string; msg: string; ok: boolean } | null;
  onSelectToken?: (coin: string) => void;
  onClose: (pos: UserPosition) => void;
  onTpSlToggle: (coin: string, type: "tp" | "sl") => void;
  onTriggerPriceChange: (v: string) => void;
  onTpSlSubmit: (pos: UserPosition) => void;
}) {
  if (positions.length === 0 && loading) return <div className="text-[11px] text-[var(--hl-muted)] text-center py-6">No open positions</div>;
  if (error) return <div className="text-[10px] text-[var(--hl-red)] text-center py-2">{error}</div>;
  if (positions.length === 0) return <div className="text-[11px] text-[var(--hl-muted)] text-center py-6">No open positions</div>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-[var(--hl-muted)] text-[10px] uppercase tracking-wider border-b border-[var(--hl-border)]">
            <th className="text-left py-1 pr-2">Asset</th>
            <th className="text-left py-1 pr-2">Side</th>
            <th className="text-right py-1 pr-2">Size</th>
            <th className="text-right py-1 pr-2">Entry</th>
            <th className="text-right py-1 pr-2">uPnL</th>
            <th className="text-right py-1 pr-2">ROE</th>
            <th className="text-right py-1">Actions</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const displayCoin = p.coin.includes(":") ? p.coin.split(":")[1] : p.coin;
            const pnlColor = p.unrealizedPnl >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]";
            const roeColor = p.returnOnEquity >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]";
            const isClosing = closing === p.coin;
            const result = actionResult?.coin === p.coin ? actionResult : null;
            const showTpSl = tpSlMode?.coin === p.coin;

            return (
              <tr key={p.coin} className="border-b border-[var(--hl-border)] border-opacity-30">
                <td className="py-1.5 pr-2 font-medium text-[var(--foreground)] cursor-pointer hover:underline" onClick={() => onSelectToken?.(p.coin)}>{displayCoin}</td>
                <td className="py-1.5 pr-2">
                  <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold ${p.side === "long" ? "bg-[rgba(80,210,193,0.15)] text-[var(--hl-green)]" : "bg-[rgba(240,88,88,0.15)] text-[var(--hl-red)]"}`}>
                    {p.side.toUpperCase()}
                  </span>
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums text-[var(--foreground)]">{Math.abs(p.size).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums text-[var(--hl-muted)]">${p.entryPx.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                <td className={`py-1.5 pr-2 text-right tabular-nums font-medium ${pnlColor}`}>{p.unrealizedPnl >= 0 ? "+" : ""}${p.unrealizedPnl.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                <td className={`py-1.5 pr-2 text-right tabular-nums ${roeColor}`}>{(p.returnOnEquity * 100).toFixed(1)}%</td>
                <td className="py-1.5 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <button onClick={(e) => { e.stopPropagation(); onClose(p); }} disabled={isClosing} className="px-1.5 py-0.5 text-[9px] font-semibold rounded bg-[rgba(240,88,88,0.15)] text-[var(--hl-red)] hover:bg-[rgba(240,88,88,0.3)] transition-colors disabled:opacity-50">{isClosing ? "..." : "Close"}</button>
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
