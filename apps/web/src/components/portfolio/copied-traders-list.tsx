"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { shortenAddress, formatUsd, pnlColor } from "@/lib/utils";
import { pauseCopy, stopCopy } from "@/lib/api";
import type { CopiedTrader } from "@/lib/api";

interface CopiedTradersListProps {
  traders: CopiedTrader[];
  walletAddress: string;
  onRefresh: () => void;
  onEditAllocation: (copyRelationshipId: string) => void;
}

export function CopiedTradersList({
  traders,
  walletAddress,
  onRefresh,
  onEditAllocation,
}: CopiedTradersListProps) {
  const handleTogglePause = async (id: string, currentlyPaused: boolean) => {
    await pauseCopy(id, !currentlyPaused);
    onRefresh();
  };

  const handleStop = async (traderAddress: string) => {
    await stopCopy(walletAddress, traderAddress);
    onRefresh();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Copied Traders</CardTitle>
      </CardHeader>
      <CardContent>
        {traders.length === 0 ? (
          <p className="py-4 text-center text-zinc-500">
            Not copying any traders yet. Head to the Traders page to start.
          </p>
        ) : (
          <div className="space-y-3">
            {traders.map((t) => (
              <div
                key={t.id}
                className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-800/20 p-4"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-zinc-200">
                      {t.traderAddress ? shortenAddress(t.traderAddress) : "—"}
                    </span>
                    {t.isPaused && <Badge variant="warning">Paused</Badge>}
                    {!t.isActive && <Badge variant="destructive">Stopped</Badge>}
                  </div>
                  <div className="flex gap-4 text-xs text-zinc-400">
                    <span>Allocated: {formatUsd(t.allocatedCapital || "0")}</span>
                    <span>Exposure: {formatUsd(t.currentExposure)}</span>
                    <span>Positions: {t.positionCount}</span>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <p className={`text-sm font-semibold ${pnlColor(t.pnlContribution)}`}>
                      {formatUsd(t.pnlContribution)}
                    </p>
                    <p className="text-[10px] text-zinc-500">PnL</p>
                  </div>

                  <div className="flex items-center gap-1">
                    <Switch
                      checked={!t.isPaused && t.isActive}
                      onCheckedChange={() => handleTogglePause(t.id, t.isPaused)}
                    />
                  </div>

                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onEditAllocation(t.id)}
                  >
                    Edit
                  </Button>

                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => t.traderAddress && handleStop(t.traderAddress)}
                  >
                    Stop
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
