"use client";

import { useState, useEffect, useCallback } from "react";
import { getUserPositions, type UserPosition, type UserAccount } from "@/lib/api";
import { useSafeAccount } from "@/hooks/use-safe-account";

interface PositionsPanelProps {
  onSelectToken?: (coin: string) => void;
}

type TpSlMode = { coin: string; type: "tp" | "sl" } | null;

export function PositionsPanel({ onSelectToken }: PositionsPanelProps) {
  const { address, isConnected } = useSafeAccount();
  const [positions, setPositions] = useState<UserPosition[]>([]);
  const [account, setAccount] = useState<UserAccount | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null); // coin being closed
  const [tpSlMode, setTpSlMode] = useState<TpSlMode>(null);
  const [triggerPrice, setTriggerPrice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [actionResult, setActionResult] = useState<{ coin: string; msg: string; ok: boolean } | null>(null);

  const fetchPositions = useCallback(async () => {
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
    fetchPositions();
    const interval = setInterval(fetchPositions, 15_000);
    return () => clearInterval(interval);
  }, [isConnected, address, fetchPositions]);

  // Clear action result after 5s
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

      const result = await exchange.closePosition(
        walletClient,
        address as `0x${string}`,
        pos.coin,
        Math.abs(pos.size),
        pos.side === "long",
      );
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
        import("@wagmi/core"),
        import("@/lib/hl-exchange"),
        import("@/config/wagmi"),
      ]);
      const walletClient = await wagmiCore.getWalletClient(wagmiConfig.config);
      if (!walletClient) { setSubmitting(false); return; }

      const result = await exchange.placeTriggerOrder(
        walletClient,
        address as `0x${string}`,
        {
          asset: pos.coin,
          isLong: pos.side === "long",
          size: Math.abs(pos.size),
          triggerPrice: parseFloat(triggerPrice),
          type: tpSlMode.type,
        },
      );
      setActionResult({
        coin: pos.coin,
        msg: result.success ? `${tpSlMode.type.toUpperCase()} set at $${triggerPrice}` : (result.error || "Failed"),
        ok: result.success,
      });
      if (result.success) {
        setTpSlMode(null);
        setTriggerPrice("");
      }
    } catch (err) {
      setActionResult({ coin: pos.coin, msg: (err as Error).message, ok: false });
    } finally {
      setSubmitting(false);
    }
  }, [address, tpSlMode, triggerPrice]);

  const totalPnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
  const totalValue = positions.reduce((s, p) => s + Math.abs(p.positionValue), 0);

  if (!isConnected) {
    return (
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-[12px] font-semibold text-[var(--foreground)] uppercase tracking-wider">My Positions</h3>
        </div>
        <div className="text-[11px] text-[var(--hl-muted)] text-center py-6">
          Connect wallet to view positions
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[12px] font-semibold text-[var(--foreground)] uppercase tracking-wider">
          My Positions
          {positions.length > 0 && <span className="ml-1 text-[var(--hl-muted)]">({positions.length})</span>}
        </h3>
        {account && (
          <div className="flex gap-3 text-[10px]">
            <span className="text-[var(--hl-muted)]">
              Acct: <span className="text-[var(--foreground)]">${account.accountValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            </span>
            <span className={totalPnl >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}>
              uPnL: {totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </span>
          </div>
        )}
      </div>

      {loading && positions.length === 0 && (
        <div className="text-[11px] text-[var(--hl-muted)] text-center py-4">Loading positions...</div>
      )}

      {error && (
        <div className="text-[10px] text-[var(--hl-red)] text-center py-2">{error}</div>
      )}

      {!loading && positions.length === 0 && !error && (
        <div className="text-[11px] text-[var(--hl-muted)] text-center py-6">No open positions</div>
      )}

      {positions.length > 0 && (
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
                    <td
                      className="py-1.5 pr-2 font-medium text-[var(--foreground)] cursor-pointer hover:underline"
                      onClick={() => onSelectToken?.(p.coin)}
                    >
                      {displayCoin}
                    </td>
                    <td className="py-1.5 pr-2">
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold ${
                        p.side === "long"
                          ? "bg-[rgba(80,210,193,0.15)] text-[var(--hl-green)]"
                          : "bg-[rgba(240,88,88,0.15)] text-[var(--hl-red)]"
                      }`}>
                        {p.side.toUpperCase()}
                      </span>
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-[var(--foreground)]">{Math.abs(p.size).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-[var(--hl-muted)]">${p.entryPx.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                    <td className={`py-1.5 pr-2 text-right tabular-nums font-medium ${pnlColor}`}>
                      {p.unrealizedPnl >= 0 ? "+" : ""}${p.unrealizedPnl.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </td>
                    <td className={`py-1.5 pr-2 text-right tabular-nums ${roeColor}`}>
                      {(p.returnOnEquity * 100).toFixed(1)}%
                    </td>
                    <td className="py-1.5 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleClose(p); }}
                          disabled={isClosing}
                          className="px-1.5 py-0.5 text-[9px] font-semibold rounded bg-[rgba(240,88,88,0.15)] text-[var(--hl-red)] hover:bg-[rgba(240,88,88,0.3)] transition-colors disabled:opacity-50"
                        >
                          {isClosing ? "..." : "Close"}
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setTpSlMode(showTpSl ? null : { coin: p.coin, type: "tp" }); setTriggerPrice(""); }}
                          className={`px-1.5 py-0.5 text-[9px] font-semibold rounded transition-colors ${
                            showTpSl && tpSlMode?.type === "tp"
                              ? "bg-[rgba(80,210,193,0.3)] text-[var(--hl-green)]"
                              : "bg-[rgba(80,210,193,0.1)] text-[var(--hl-green)] hover:bg-[rgba(80,210,193,0.2)]"
                          }`}
                        >
                          TP
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setTpSlMode(showTpSl && tpSlMode?.type === "sl" ? null : { coin: p.coin, type: "sl" }); setTriggerPrice(""); }}
                          className={`px-1.5 py-0.5 text-[9px] font-semibold rounded transition-colors ${
                            showTpSl && tpSlMode?.type === "sl"
                              ? "bg-[rgba(240,88,88,0.3)] text-[var(--hl-red)]"
                              : "bg-[rgba(240,88,88,0.1)] text-[var(--hl-red)] hover:bg-[rgba(240,88,88,0.2)]"
                          }`}
                        >
                          SL
                        </button>
                      </div>
                      {/* TP/SL inline input */}
                      {showTpSl && (
                        <div className="flex items-center gap-1 mt-1 justify-end">
                          <span className="text-[9px] text-[var(--hl-muted)]">{tpSlMode.type === "tp" ? "TP" : "SL"} $</span>
                          <input
                            type="number"
                            value={triggerPrice}
                            onChange={(e) => setTriggerPrice(e.target.value)}
                            placeholder={p.entryPx.toFixed(2)}
                            className="w-20 px-1 py-0.5 text-[10px] bg-[var(--hl-dark)] border border-[var(--hl-border)] rounded text-[var(--foreground)] tabular-nums"
                            onClick={(e) => e.stopPropagation()}
                          />
                          <button
                            onClick={(e) => { e.stopPropagation(); handleTpSl(p); }}
                            disabled={submitting || !triggerPrice}
                            className="px-1.5 py-0.5 text-[9px] font-semibold rounded bg-[var(--hl-accent)] text-black hover:opacity-80 transition-opacity disabled:opacity-50"
                          >
                            {submitting ? "..." : "Set"}
                          </button>
                        </div>
                      )}
                      {/* Action result feedback */}
                      {result && (
                        <div className={`text-[9px] mt-0.5 ${result.ok ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
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
                <tr className="text-[10px] font-medium border-t border-[var(--hl-border)]">
                  <td className="py-1.5 text-[var(--hl-muted)]" colSpan={4}>Total</td>
                  <td className={`py-1.5 text-right tabular-nums font-medium ${totalPnl >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                    {totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </td>
                  <td colSpan={2}></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}
