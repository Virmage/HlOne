"use client";

import { useState, useEffect, useCallback } from "react";
import { getUserPositions, type UserPosition, type UserAccount } from "@/lib/api";
import { useSafeAccount } from "@/hooks/use-safe-account";

interface PositionsPanelProps {
  onSelectToken?: (coin: string) => void;
}

export function PositionsPanel({ onSelectToken }: PositionsPanelProps) {
  const { address, isConnected } = useSafeAccount();
  const [positions, setPositions] = useState<UserPosition[]>([]);
  const [account, setAccount] = useState<UserAccount | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    const interval = setInterval(fetchPositions, 15_000); // refresh every 15s
    return () => clearInterval(interval);
  }, [isConnected, address, fetchPositions]);

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
                <th className="text-right py-1 pr-2">Value</th>
                <th className="text-right py-1 pr-2">uPnL</th>
                <th className="text-right py-1 pr-2">ROE</th>
                <th className="text-right py-1">Lev</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const displayCoin = p.coin.includes(":") ? p.coin.split(":")[1] : p.coin;
                const pnlColor = p.unrealizedPnl >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]";
                const roeColor = p.returnOnEquity >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]";
                return (
                  <tr
                    key={p.coin}
                    className="border-b border-[var(--hl-border)] border-opacity-30 hover:bg-[var(--hl-surface)] cursor-pointer transition-colors"
                    onClick={() => onSelectToken?.(p.coin)}
                  >
                    <td className="py-1.5 pr-2 font-medium text-[var(--foreground)]">{displayCoin}</td>
                    <td className="py-1.5 pr-2">
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold ${
                        p.side === "long"
                          ? "bg-[rgba(80,210,193,0.15)] text-[var(--hl-green)]"
                          : "bg-[rgba(240,88,88,0.15)] text-[var(--hl-red)]"
                      }`}>
                        {p.side.toUpperCase()}
                      </span>
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-[var(--foreground)]">{p.size.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-[var(--hl-muted)]">${p.entryPx.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-[var(--foreground)]">${Math.abs(p.positionValue).toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                    <td className={`py-1.5 pr-2 text-right tabular-nums font-medium ${pnlColor}`}>
                      {p.unrealizedPnl >= 0 ? "+" : ""}${p.unrealizedPnl.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </td>
                    <td className={`py-1.5 pr-2 text-right tabular-nums ${roeColor}`}>
                      {(p.returnOnEquity * 100).toFixed(1)}%
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-[var(--hl-muted)]">{p.leverage}x</td>
                  </tr>
                );
              })}
            </tbody>
            {positions.length > 1 && (
              <tfoot>
                <tr className="text-[10px] font-medium border-t border-[var(--hl-border)]">
                  <td className="py-1.5 text-[var(--hl-muted)]" colSpan={4}>Total</td>
                  <td className="py-1.5 text-right tabular-nums text-[var(--foreground)]">${totalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
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
