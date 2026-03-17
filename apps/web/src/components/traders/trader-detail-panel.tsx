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
        <CardContent className="p-6 text-[var(--hl-red)]">{error}</CardContent>
      </Card>
    );
  }

  const p = detail?.profile as Record<string, unknown> | null;
  const ch = detail?.live.clearinghouse as Record<string, unknown> | null;
  const margin = ch?.crossMarginSummary as Record<string, string> | undefined;

  // Pull stats from profile (which now includes synthetic data from live API)
  const accountValue = p?.accountSize ?? margin?.accountValue ?? null;
  const totalPnl = p?.totalPnl ?? null;
  const roi30d = p?.roi30d ?? null;
  const roi90d = p?.roi90d ?? null;
  const pnl30d = p?.pnl30d ?? null;
  const winRate = p?.winRate as number | null;
  const tradeCount = p?.tradeCount as number | null;
  const maxLeverage = p?.maxLeverage as number | null;
  const maxDrawdown = p?.maxDrawdown as number | null;

  return (
    <Card className="w-full lg:w-[480px] max-h-[calc(100vh-8rem)] overflow-y-auto">
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="font-mono">{shortenAddress(address, 6)}</CardTitle>
          <p className="text-xs text-[var(--hl-muted)] mt-1">{address}</p>
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
            value={accountValue ? formatUsd(accountValue as string | number) : "—"}
          />
          <StatBox
            label="Total PnL"
            value={totalPnl ? formatUsd(totalPnl as string | number) : "—"}
            color={pnlColor(totalPnl as string || "0")}
          />
          <StatBox
            label="Win Rate"
            value={winRate != null ? `${(winRate * 100).toFixed(1)}%` : "—"}
            color={winRate != null && winRate >= 0.5 ? "text-[var(--hl-green)]" : undefined}
          />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <StatBox
            label="30d ROI"
            value={roi30d != null ? formatPercent(roi30d as number) : "—"}
            color={pnlColor(roi30d as number || 0)}
          />
          <StatBox
            label="90d ROI"
            value={roi90d != null ? formatPercent(roi90d as number) : "—"}
            color={pnlColor(roi90d as number || 0)}
          />
          <StatBox
            label="30d PnL"
            value={pnl30d ? formatUsd(pnl30d as string | number) : "—"}
            color={pnlColor(pnl30d as string || "0")}
          />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <StatBox
            label="Trades (90d)"
            value={tradeCount ? tradeCount.toString() : "—"}
          />
          <StatBox
            label="Max Leverage"
            value={maxLeverage != null && maxLeverage > 0 ? `${maxLeverage}x` : "—"}
          />
          <StatBox
            label="30D Drawdown"
            value={maxDrawdown != null && maxDrawdown > 0 ? `-${maxDrawdown.toFixed(1)}%` : "—"}
            color={maxDrawdown != null && maxDrawdown > 0 ? "text-[var(--hl-red)]" : undefined}
          />
        </div>

        {/* Recent Tickers */}
        {detail?.live.recentFills && detail.live.recentFills.length > 0 && (() => {
          const fills = detail.live.recentFills as Record<string, string>[];
          const tickerCounts = new Map<string, number>();
          for (const f of fills) {
            if (f.coin) tickerCounts.set(f.coin, (tickerCounts.get(f.coin) || 0) + 1);
          }
          const sorted = [...tickerCounts.entries()].sort((a, b) => b[1] - a[1]);
          return (
            <div className="rounded-md border border-[var(--hl-border)] bg-[var(--hl-surface)] p-3">
              <p className="text-[10px] uppercase tracking-wider text-[var(--hl-muted)] mb-2">Recent Tickers</p>
              <div className="flex flex-wrap gap-1.5">
                {sorted.map(([coin, count]) => (
                  <Badge key={coin} variant="outline" className="text-xs font-mono">
                    {coin} <span className="ml-1 text-[var(--hl-muted)]">×{count}</span>
                  </Badge>
                ))}
              </div>
            </div>
          );
        })()}

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
                    className="flex items-center justify-between rounded-md border border-[var(--hl-border)] bg-[var(--hl-surface)] p-3"
                  >
                    <div>
                      <span className="font-medium text-[var(--hl-text)]">{pos.asset}</span>
                      <Badge
                        variant={pos.side === "long" ? "default" : "destructive"}
                        className="ml-2"
                      >
                        {pos.side.toUpperCase()}
                      </Badge>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-[var(--hl-text)]">
                        Size: {parseFloat(pos.size).toFixed(4)}
                      </p>
                      <p className="text-xs text-[var(--hl-muted)]">
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
                <p className="py-4 text-center text-[var(--hl-muted)]">No open positions</p>
              )}
            </div>
          </TabsContent>

          <TabsContent value="fills">
            <div className="space-y-1 max-h-60 overflow-y-auto">
              {detail?.live.recentFills && detail.live.recentFills.length > 0 ? (
                detail.live.recentFills.slice(0, 20).map((fill, i) => {
                  const f = fill as Record<string, string>;
                  return (
                    <div key={i} className="flex items-center gap-2 text-xs py-1.5 border-b border-[var(--hl-border)]">
                      <span className="font-mono font-semibold text-[var(--foreground)] min-w-[60px]">{f.coin}</span>
                      <Badge variant={f.side === "B" ? "default" : "destructive"} className="text-[10px] px-1.5 py-0">
                        {f.side === "B" ? "BUY" : "SELL"}
                      </Badge>
                      <span className="text-[var(--hl-text)] ml-auto">{parseFloat(f.sz || "0").toFixed(4)}</span>
                      <span className="text-[var(--hl-muted)]">@ {formatUsd(f.px || "0")}</span>
                    </div>
                  );
                })
              ) : (
                <p className="py-4 text-center text-[var(--hl-muted)]">No recent fills</p>
              )}
            </div>
          </TabsContent>
        </Tabs>

        <Button className="w-full bg-[var(--hl-green)] text-[var(--background)] hover:brightness-110" onClick={() => onCopy(address)}>
          Copy This Trader
        </Button>
      </CardContent>
    </Card>
  );
}

function StatBox({
  label,
  value,
  color = "text-[var(--hl-text)]",
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="rounded-md border border-[var(--hl-border)] bg-[var(--hl-surface)] p-2.5">
      <p className="text-[10px] uppercase tracking-wider text-[var(--hl-muted)]">{label}</p>
      <p className={`mt-0.5 text-sm font-semibold ${color}`}>{value}</p>
    </div>
  );
}
