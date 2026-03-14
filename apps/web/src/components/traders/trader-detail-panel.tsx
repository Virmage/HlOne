"use client";

import { useTraderDetail } from "@/hooks/use-traders";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { shortenAddress, formatUsd, formatPercent, pnlColor } from "@/lib/utils";
import { X } from "lucide-react";
import { EquityCurve } from "./equity-curve";

interface TraderDetailPanelProps {
  address: string;
  onClose: () => void;
  onCopy: (address: string) => void;
}

export function TraderDetailPanel({ address, onClose, onCopy }: TraderDetailPanelProps) {
  const { detail, loading, error } = useTraderDetail(address);

  if (loading) {
    return (
      <Card className="w-full lg:w-[480px]">
        <CardHeader>
          <Skeleton className="h-6 w-48" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="w-full lg:w-[480px]">
        <CardContent className="p-6 text-red-400">{error}</CardContent>
      </Card>
    );
  }

  const ch = detail?.live.clearinghouse as Record<string, unknown> | null;
  const margin = ch?.crossMarginSummary as Record<string, string> | undefined;

  return (
    <Card className="w-full lg:w-[480px] max-h-[calc(100vh-8rem)] overflow-y-auto">
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="font-mono">{shortenAddress(address, 6)}</CardTitle>
          <p className="text-xs text-zinc-500 mt-1">{address}</p>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Key stats */}
        <div className="grid grid-cols-3 gap-3">
          <StatBox
            label="Account Value"
            value={margin?.accountValue ? formatUsd(margin.accountValue) : "—"}
          />
          <StatBox
            label="Total PnL"
            value={detail?.profile?.totalPnl ? formatUsd(detail.profile.totalPnl) : "—"}
            color={pnlColor(detail?.profile?.totalPnl || "0")}
          />
          <StatBox
            label="ROI"
            value={detail?.profile?.roiPercent != null ? formatPercent(detail.profile.roiPercent) : "—"}
            color={pnlColor(detail?.profile?.roiPercent || 0)}
          />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <StatBox
            label="Win Rate"
            value={detail?.profile?.winRate != null ? `${(detail.profile.winRate * 100).toFixed(1)}%` : "—"}
          />
          <StatBox
            label="Trades"
            value={detail?.profile?.tradeCount?.toString() || "—"}
          />
          <StatBox
            label="Max Leverage"
            value={detail?.profile?.maxLeverage != null ? `${detail.profile.maxLeverage}x` : "—"}
          />
        </div>

        <Separator />

        <Tabs defaultValue="chart">
          <TabsList>
            <TabsTrigger value="chart">Equity Curve</TabsTrigger>
            <TabsTrigger value="positions">Positions</TabsTrigger>
            <TabsTrigger value="fills">Recent Fills</TabsTrigger>
          </TabsList>

          <TabsContent value="chart">
            <div className="h-48">
              <EquityCurve data={detail?.equityCurve || []} />
            </div>
          </TabsContent>

          <TabsContent value="positions">
            <div className="space-y-2">
              {detail?.positions && detail.positions.length > 0 ? (
                detail.positions.map((pos) => (
                  <div
                    key={pos.id}
                    className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-800/30 p-3"
                  >
                    <div>
                      <span className="font-medium text-zinc-200">{pos.asset}</span>
                      <Badge
                        variant={pos.side === "long" ? "default" : "destructive"}
                        className="ml-2"
                      >
                        {pos.side.toUpperCase()}
                      </Badge>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-zinc-300">
                        Size: {parseFloat(pos.size).toFixed(4)}
                      </p>
                      <p className="text-xs text-zinc-500">
                        Entry: {formatUsd(pos.entryPrice)}
                      </p>
                      {pos.unrealizedPnl && (
                        <p className={`text-xs font-medium ${pnlColor(pos.unrealizedPnl)}`}>
                          {formatUsd(pos.unrealizedPnl)}
                        </p>
                      )}
                    </div>
                  </div>
                ))
              ) : (
                <p className="py-4 text-center text-zinc-500">No open positions</p>
              )}
            </div>
          </TabsContent>

          <TabsContent value="fills">
            <div className="space-y-1 max-h-60 overflow-y-auto">
              {detail?.live.recentFills && detail.live.recentFills.length > 0 ? (
                detail.live.recentFills.slice(0, 20).map((fill, i) => {
                  const f = fill as Record<string, string>;
                  return (
                    <div key={i} className="flex justify-between text-xs py-1 border-b border-zinc-800/50">
                      <span className="text-zinc-300">{f.coin}</span>
                      <span className={f.side === "B" ? "text-green-400" : "text-red-400"}>
                        {f.side === "B" ? "Buy" : "Sell"} {parseFloat(f.sz || "0").toFixed(4)}
                      </span>
                      <span className="text-zinc-400">@ {formatUsd(f.px || "0")}</span>
                    </div>
                  );
                })
              ) : (
                <p className="py-4 text-center text-zinc-500">No recent fills</p>
              )}
            </div>
          </TabsContent>
        </Tabs>

        <Button className="w-full" onClick={() => onCopy(address)}>
          Copy This Trader
        </Button>
      </CardContent>
    </Card>
  );
}

function StatBox({
  label,
  value,
  color = "text-zinc-200",
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-800/30 p-2.5">
      <p className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className={`mt-0.5 text-sm font-semibold ${color}`}>{value}</p>
    </div>
  );
}
