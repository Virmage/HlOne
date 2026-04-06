"use client";

import { useState, useEffect, useCallback } from "react";
import { useSafeAccount as useAccount } from "@/hooks/use-safe-account";
import { getUserPositions, type UserPosition, type UserAccount } from "@/lib/api";

type TpSlMode = { coin: string; type: "tp" | "sl" } | null;

export default function PortfolioPage() {
  const { address, isConnected } = useAccount();
  const [positions, setPositions] = useState<UserPosition[]>([]);
  const [account, setAccount] = useState<UserAccount | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [tpSlMode, setTpSlMode] = useState<TpSlMode>(null);
  const [triggerPrice, setTriggerPrice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [actionResult, setActionResult] = useState<{ coin: string; msg: string; ok: boolean } | null>(null);

  const fetchData = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    try {
      const data = await getUserPositions(address);
      setPositions(data.positions);
      setAccount(data.account);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    if (!isConnected || !address) return;
    fetchData();
    const interval = setInterval(fetchData, 10_000);
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
      const result = await exchange.closePosition(walletClient, address as `0x${string}`, pos.coin, Math.abs(pos.size), pos.side === "long");
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
      const result = await exchange.placeTriggerOrder(walletClient, address as `0x${string}`, {
        asset: pos.coin,
        isLong: pos.side === "long",
        size: Math.abs(pos.size),
        triggerPrice: parseFloat(triggerPrice),
        type: tpSlMode.type,
      });
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
          <p className="text-sm text-[var(--hl-muted)]">
            Connect your wallet to view your portfolio
          </p>
        </div>
      </div>
    );
  }

  if (loading && positions.length === 0) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <div className="text-[var(--hl-muted)] animate-pulse">Loading portfolio...</div>
      </div>
    );
  }

  const totalPnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
  const totalNotional = positions.reduce((s, p) => s + Math.abs(p.positionValue), 0);
  const totalMargin = positions.reduce((s, p) => s + p.marginUsed, 0);

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">Portfolio</h1>
        <p className="text-sm text-[var(--hl-muted)] mt-1">
          {address?.slice(0, 6)}...{address?.slice(-4)} on Hyperliquid
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-[#f058581a] bg-[#f058580d] px-4 py-3 text-[13px] text-[var(--hl-red)]">
          {error}
        </div>
      )}

      {/* Account Overview */}
      {account && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            label="Account Value"
            value={`$${account.accountValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
          />
          <StatCard
            label="Unrealized PnL"
            value={`${totalPnl >= 0 ? "+" : ""}$${totalPnl.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
            color={totalPnl >= 0 ? "green" : "red"}
          />
          <StatCard
            label="Total Notional"
            value={`$${totalNotional.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
          />
          <StatCard
            label="Margin Used"
            value={`$${totalMargin.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
            sub={account.accountValue > 0 ? `${((totalMargin / account.accountValue) * 100).toFixed(1)}% of account` : undefined}
          />
        </div>
      )}

      {/* Positions Table */}
      <div className="border border-[var(--hl-border)] rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--hl-border)] bg-[var(--hl-surface)]">
          <h2 className="text-[13px] font-semibold text-[var(--foreground)]">
            Open Positions
            {positions.length > 0 && <span className="ml-1 text-[var(--hl-muted)]">({positions.length})</span>}
          </h2>
        </div>

        {positions.length === 0 ? (
          <div className="text-[13px] text-[var(--hl-muted)] text-center py-12">
            No open positions
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-[var(--hl-muted)] text-[10px] uppercase tracking-wider border-b border-[var(--hl-border)] bg-[var(--hl-surface)]">
                  <th className="text-left px-4 py-2">Asset</th>
                  <th className="text-left px-2 py-2">Side</th>
                  <th className="text-right px-2 py-2">Size</th>
                  <th className="text-right px-2 py-2">Entry</th>
                  <th className="text-right px-2 py-2">Position Value</th>
                  <th className="text-right px-2 py-2">Unrealized PnL</th>
                  <th className="text-right px-2 py-2">ROE</th>
                  <th className="text-right px-2 py-2">Leverage</th>
                  <th className="text-right px-2 py-2">Margin</th>
                  <th className="text-right px-2 py-2">Liq. Price</th>
                  <th className="text-right px-4 py-2">Actions</th>
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
                    <tr key={p.coin} className="border-b border-[var(--hl-border)] border-opacity-30 hover:bg-[var(--hl-surface)] transition-colors">
                      <td className="px-4 py-2.5 font-medium text-[var(--foreground)]">{displayCoin}</td>
                      <td className="px-2 py-2.5">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                          p.side === "long"
                            ? "bg-[rgba(80,210,193,0.15)] text-[var(--hl-green)]"
                            : "bg-[rgba(240,88,88,0.15)] text-[var(--hl-red)]"
                        }`}>
                          {p.side.toUpperCase()}
                        </span>
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums text-[var(--foreground)]">
                        {Math.abs(p.size).toLocaleString(undefined, { maximumFractionDigits: 4 })}
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums text-[var(--hl-muted)]">
                        ${p.entryPx.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums text-[var(--foreground)]">
                        ${Math.abs(p.positionValue).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </td>
                      <td className={`px-2 py-2.5 text-right tabular-nums font-medium ${pnlColor}`}>
                        {p.unrealizedPnl >= 0 ? "+" : ""}${p.unrealizedPnl.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </td>
                      <td className={`px-2 py-2.5 text-right tabular-nums ${roeColor}`}>
                        {(p.returnOnEquity * 100).toFixed(2)}%
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums text-[var(--foreground)]">
                        {p.leverage}x
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums text-[var(--hl-muted)]">
                        ${p.marginUsed.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums text-[var(--hl-muted)]">
                        {p.liquidationPx ? `$${p.liquidationPx.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => handleClose(p)}
                            disabled={isClosing}
                            className="px-2 py-1 text-[10px] font-semibold rounded bg-[rgba(240,88,88,0.15)] text-[var(--hl-red)] hover:bg-[rgba(240,88,88,0.3)] transition-colors disabled:opacity-50"
                          >
                            {isClosing ? "Closing..." : "Close"}
                          </button>
                          <button
                            onClick={() => { setTpSlMode(showTpSl && tpSlMode?.type === "tp" ? null : { coin: p.coin, type: "tp" }); setTriggerPrice(""); }}
                            className={`px-2 py-1 text-[10px] font-semibold rounded transition-colors ${
                              showTpSl && tpSlMode?.type === "tp"
                                ? "bg-[rgba(80,210,193,0.3)] text-[var(--hl-green)]"
                                : "bg-[rgba(80,210,193,0.1)] text-[var(--hl-green)] hover:bg-[rgba(80,210,193,0.2)]"
                            }`}
                          >
                            TP
                          </button>
                          <button
                            onClick={() => { setTpSlMode(showTpSl && tpSlMode?.type === "sl" ? null : { coin: p.coin, type: "sl" }); setTriggerPrice(""); }}
                            className={`px-2 py-1 text-[10px] font-semibold rounded transition-colors ${
                              showTpSl && tpSlMode?.type === "sl"
                                ? "bg-[rgba(240,88,88,0.3)] text-[var(--hl-red)]"
                                : "bg-[rgba(240,88,88,0.1)] text-[var(--hl-red)] hover:bg-[rgba(240,88,88,0.2)]"
                            }`}
                          >
                            SL
                          </button>
                        </div>
                        {showTpSl && (
                          <div className="flex items-center gap-1.5 mt-1.5 justify-end">
                            <span className="text-[10px] text-[var(--hl-muted)]">{tpSlMode.type === "tp" ? "TP" : "SL"} $</span>
                            <input
                              type="number"
                              value={triggerPrice}
                              onChange={(e) => setTriggerPrice(e.target.value)}
                              placeholder={p.entryPx.toFixed(2)}
                              className="w-24 px-1.5 py-1 text-[11px] bg-[var(--hl-dark)] border border-[var(--hl-border)] rounded text-[var(--foreground)] tabular-nums"
                            />
                            <button
                              onClick={() => handleTpSl(p)}
                              disabled={submitting || !triggerPrice}
                              className="px-2 py-1 text-[10px] font-semibold rounded bg-[var(--hl-accent)] text-black hover:opacity-80 transition-opacity disabled:opacity-50"
                            >
                              {submitting ? "..." : "Set"}
                            </button>
                          </div>
                        )}
                        {result && (
                          <div className={`text-[10px] mt-1 ${result.ok ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                            {result.msg}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {positions.length > 1 && (
                <tfoot>
                  <tr className="text-[11px] font-medium bg-[var(--hl-surface)]">
                    <td className="px-4 py-2 text-[var(--hl-muted)]" colSpan={4}>Total</td>
                    <td className="px-2 py-2 text-right tabular-nums text-[var(--foreground)]">
                      ${totalNotional.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </td>
                    <td className={`px-2 py-2 text-right tabular-nums font-medium ${totalPnl >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                      {totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-[var(--hl-muted)]">
                      {account && account.accountValue > 0
                        ? `${((totalPnl / account.accountValue) * 100).toFixed(2)}%`
                        : "—"
                      }
                    </td>
                    <td colSpan={4}></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </div>

      {/* Account Details */}
      {account && (
        <div className="border border-[var(--hl-border)] rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--hl-border)] bg-[var(--hl-surface)]">
            <h2 className="text-[13px] font-semibold text-[var(--foreground)]">Account Details</h2>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-[var(--hl-border)]">
            <DetailItem label="Withdrawable" value={`$${account.withdrawable.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} />
            <DetailItem label="Margin Ratio" value={account.accountValue > 0 ? `${((totalMargin / account.accountValue) * 100).toFixed(1)}%` : "—"} />
            <DetailItem label="Open Positions" value={String(positions.length)} />
            <DetailItem label="Leverage (Avg)" value={positions.length > 0 ? `${(totalNotional / (account.accountValue || 1)).toFixed(1)}x` : "—"} />
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color, sub }: { label: string; value: string; color?: "green" | "red"; sub?: string }) {
  const valueColor = color === "green" ? "text-[var(--hl-green)]" : color === "red" ? "text-[var(--hl-red)]" : "text-[var(--foreground)]";
  return (
    <div className="border border-[var(--hl-border)] rounded-lg p-3 bg-[var(--hl-surface)]">
      <div className="text-[10px] text-[var(--hl-muted)] uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-[16px] font-semibold tabular-nums ${valueColor}`}>{value}</div>
      {sub && <div className="text-[10px] text-[var(--hl-muted)] mt-0.5">{sub}</div>}
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
