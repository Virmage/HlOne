"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { shortenAddress, formatUsd, pnlColor } from "@/lib/utils";
import { closePosition } from "@/lib/api";
import type { OpenPosition } from "@/lib/api";

interface OpenPositionsTableProps {
  positions: OpenPosition[];
  onRefresh: () => void;
}

export function OpenPositionsTable({ positions, onRefresh }: OpenPositionsTableProps) {
  const handleClose = async (positionId: string) => {
    await closePosition(positionId, "Manual close from portfolio");
    onRefresh();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Open Positions</CardTitle>
      </CardHeader>
      <CardContent>
        {positions.length === 0 ? (
          <p className="py-4 text-center text-zinc-500">No open positions</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800">
                  <th className="px-3 py-2 text-left text-xs font-medium text-zinc-400">Asset</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-zinc-400">Side</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-zinc-400">Size</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-zinc-400">Entry</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-zinc-400">Current</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-zinc-400">PnL</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-zinc-400">Source</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-zinc-400"></th>
                </tr>
              </thead>
              <tbody>
                {positions.map((pos) => (
                  <tr key={pos.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/20">
                    <td className="px-3 py-2 font-medium text-zinc-200">{pos.asset}</td>
                    <td className="px-3 py-2">
                      <Badge variant={pos.side === "long" ? "default" : "destructive"}>
                        {pos.side.toUpperCase()}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-300">
                      {parseFloat(pos.size).toFixed(4)}
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-400">
                      {formatUsd(pos.entryPrice)}
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-300">
                      {pos.currentPrice ? formatUsd(pos.currentPrice) : "—"}
                    </td>
                    <td className={`px-3 py-2 text-right font-medium ${pnlColor(pos.unrealizedPnl || "0")}`}>
                      {pos.unrealizedPnl ? formatUsd(pos.unrealizedPnl) : "—"}
                    </td>
                    <td className="px-3 py-2 text-zinc-500 font-mono text-xs">
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
