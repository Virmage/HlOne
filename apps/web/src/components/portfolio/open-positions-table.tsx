"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { shortenAddress, formatUsd, pnlColor } from "@/lib/utils";
import { closePosition } from "@/lib/api";
import type { OpenPosition } from "@/lib/api";
import { useSignMessage, useAccount } from "wagmi";

interface OpenPositionsTableProps {
  positions: OpenPosition[];
  onRefresh: () => void;
}

export function OpenPositionsTable({ positions, onRefresh }: OpenPositionsTableProps) {
  const { signMessageAsync } = useSignMessage();
  const { address } = useAccount();

  const handleClose = async (positionId: string) => {
    if (!address) return;
    await closePosition(address, positionId, signMessageAsync, "Manual close from portfolio");
    onRefresh();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Open Positions</CardTitle>
      </CardHeader>
      <CardContent>
        {positions.length === 0 ? (
          <p className="py-4 text-center text-[var(--hl-muted)]">No open positions</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--hl-border)]">
                  <th className="px-3 py-2 text-left text-xs font-medium text-[var(--hl-muted)]">Asset</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-[var(--hl-muted)]">Side</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-[var(--hl-muted)]">Size</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-[var(--hl-muted)]">Entry</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-[var(--hl-muted)]">Current</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-[var(--hl-muted)]">PnL</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-[var(--hl-muted)]">Source</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-[var(--hl-muted)]"></th>
                </tr>
              </thead>
              <tbody>
                {positions.map((pos) => (
                  <tr key={pos.id} className="border-b border-[var(--hl-border)]/50 hover:bg-[var(--hl-surface-hover)]">
                    <td className="px-3 py-2 font-medium text-[var(--foreground)]">{pos.asset}</td>
                    <td className="px-3 py-2">
                      <Badge variant={pos.side === "long" ? "default" : "destructive"}>
                        {pos.side.toUpperCase()}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right text-[var(--hl-text)]">
                      {parseFloat(pos.size).toFixed(4)}
                    </td>
                    <td className="px-3 py-2 text-right text-[var(--hl-muted)]">
                      {formatUsd(pos.entryPrice)}
                    </td>
                    <td className="px-3 py-2 text-right text-[var(--hl-text)]">
                      {pos.currentPrice ? formatUsd(pos.currentPrice) : "—"}
                    </td>
                    <td className={`px-3 py-2 text-right font-medium ${pnlColor(pos.unrealizedPnl || "0")}`}>
                      {pos.unrealizedPnl ? formatUsd(pos.unrealizedPnl) : "—"}
                    </td>
                    <td className="px-3 py-2 text-[var(--hl-muted)] font-mono text-xs">
                      {pos.traderAddress ? shortenAddress(pos.traderAddress) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button size="sm" variant="outline" onClick={() => handleClose(pos.id)}>
                        Close
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
