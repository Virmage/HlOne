"use client";

import { useTokenDetail } from "@/hooks/use-terminal";
import { X } from "lucide-react";
import { formatUsd, pnlColor } from "@/lib/utils";
import { TokenChart } from "./token-chart";
import { TokenPositions } from "./token-positions";
import { TokenScoreCard } from "./token-score";
import type { WhaleAlert } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";

interface TokenDrawerProps {
  coin: string;
  onClose: () => void;
  onCopy?: (address: string) => void;
  onFade?: (address: string) => void;
}

export function TokenDrawer({ coin, onClose, onCopy, onFade }: TokenDrawerProps) {
  const { detail, loading, error } = useTokenDetail(coin);

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-full max-w-[560px] overflow-y-auto bg-[var(--background)] border-l border-[var(--hl-border)] shadow-2xl">
      {/* Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 bg-[var(--background)] border-b border-[var(--hl-border)]">
        <div className="flex items-center gap-3">
          <h2 className="text-[18px] font-semibold text-[var(--foreground)]">{coin}-PERP</h2>
          {detail?.overview && (
            <>
              <span className="text-[16px] text-[var(--foreground)] tabular-nums">
                ${detail.overview.price >= 1
                  ? detail.overview.price.toLocaleString(undefined, { maximumFractionDigits: 2 })
                  : detail.overview.price.toPrecision(4)}
              </span>
              <span className={`text-[13px] tabular-nums ${pnlColor(detail.overview.change24h)}`}>
                {detail.overview.change24h >= 0 ? "+" : ""}{detail.overview.change24h.toFixed(2)}%
              </span>
            </>
          )}
        </div>
        <button onClick={onClose} className="p-1 hover:bg-[var(--hl-surface-hover)] rounded transition-colors">
          <X className="h-5 w-5 text-[var(--hl-muted)]" />
        </button>
      </div>

      {loading && (
        <div className="p-4 space-y-4">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      )}

      {error && (
        <div className="p-4 text-[var(--hl-red)] text-[13px]">{error}</div>
      )}

      {detail && (
        <div className="p-4 space-y-4">
          {/* CPYCAT Score */}
          {detail.score && <TokenScoreCard score={detail.score} />}

          {/* Chart */}
          {detail.candles.length > 0 && (
            <div>
              <h3 className="text-[11px] font-medium text-[var(--hl-muted)] uppercase tracking-wider mb-2">
                Price Chart (7d)
              </h3>
              <TokenChart candles={detail.candles} whaleAlerts={detail.whaleAlerts} />
            </div>
          )}

          {/* Key Metrics */}
          <div className="grid grid-cols-3 gap-2">
            <MetricBox
              label="Open Interest"
              value={detail.overview ? `$${(detail.overview.openInterest / 1e6).toFixed(1)}M` : "—"}
            />
            <MetricBox
              label="24h Volume"
              value={detail.overview ? `$${(detail.overview.volume24h / 1e6).toFixed(1)}M` : "—"}
            />
            <MetricBox
              label="Funding"
              value={detail.overview ? `${(detail.overview.fundingRate * 100).toFixed(4)}%` : "—"}
              color={detail.overview && detail.overview.fundingRate > 0 ? "text-[var(--hl-green)]" : detail.overview && detail.overview.fundingRate < 0 ? "text-[var(--hl-red)]" : undefined}
            />
          </div>

          {/* Funding Regime */}
          {detail.fundingRegime && (
            <div className="rounded-md border border-[var(--hl-border)] bg-[var(--hl-surface)] p-2.5">
              <p className="text-[10px] uppercase tracking-wider text-[var(--hl-muted)] mb-1">Funding Regime</p>
              <p className="text-[12px] text-[var(--hl-text)]">{detail.fundingRegime}</p>
            </div>
          )}

          {/* Book Analysis */}
          {detail.bookAnalysis && (
            <div className="rounded-md border border-[var(--hl-border)] bg-[var(--hl-surface)] p-2.5">
              <p className="text-[10px] uppercase tracking-wider text-[var(--hl-muted)] mb-2">Book Analysis</p>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[11px] text-[var(--hl-muted)]">Bid/Ask Imbalance:</span>
                <span className={`text-[12px] font-medium ${
                  detail.bookAnalysis.imbalance > 1.2 ? "text-[var(--hl-green)]" :
                  detail.bookAnalysis.imbalance < 0.8 ? "text-[var(--hl-red)]" :
                  "text-[var(--hl-text)]"
                }`}>
                  {detail.bookAnalysis.imbalance.toFixed(2)}x
                  {detail.bookAnalysis.imbalance > 1.2 ? " (buy pressure)" :
                   detail.bookAnalysis.imbalance < 0.8 ? " (sell pressure)" : " (balanced)"}
                </span>
              </div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[11px] text-[var(--hl-muted)]">Spread:</span>
                <span className="text-[12px] text-[var(--hl-text)]">{detail.bookAnalysis.spreadBps.toFixed(1)} bps</span>
              </div>
              {detail.bookAnalysis.walls.length > 0 && (
                <div className="mt-2 pt-2 border-t border-[var(--hl-border)]">
                  <p className="text-[10px] uppercase tracking-wider text-[var(--hl-muted)] mb-1">Detected Walls</p>
                  {detail.bookAnalysis.walls.map((wall, i) => (
                    <div key={i} className="flex items-center gap-2 text-[11px] py-0.5">
                      <span className={wall.side === "bid" ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}>
                        {wall.side === "bid" ? "BID WALL" : "ASK WALL"}
                      </span>
                      <span className="text-[var(--hl-text)]">@ ${wall.price.toLocaleString()}</span>
                      <span className="text-[var(--hl-muted)]">({wall.multiplier.toFixed(1)}x avg)</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Liquidation Clusters */}
          {detail.liquidationClusters.length > 0 && (
            <div className="rounded-md border border-[var(--hl-border)] bg-[var(--hl-surface)] p-2.5">
              <p className="text-[10px] uppercase tracking-wider text-[var(--hl-muted)] mb-2">Liquidation Clusters</p>
              {detail.liquidationClusters.map((cluster, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px] py-0.5">
                  <span className={cluster.side === "long" ? "text-[var(--hl-red)]" : "text-[var(--hl-green)]"}>
                    {cluster.side === "long" ? "LONG LIQS" : "SHORT LIQS"}
                  </span>
                  <span className="text-[var(--hl-text)]">@ ${cluster.price.toLocaleString()}</span>
                  <span className="text-[var(--hl-muted)]">
                    ${(cluster.totalValue / 1e6).toFixed(1)}M ({cluster.traderCount} traders)
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Sharp Positions */}
          {detail.sharpPositions.length > 0 && (
            <TokenPositions
              positions={detail.sharpPositions}
              onCopy={onCopy}
              onFade={onFade}
            />
          )}

          {/* Whale Alerts for this coin */}
          {detail.whaleAlerts.length > 0 && (
            <div>
              <h3 className="text-[11px] font-medium text-[var(--hl-muted)] uppercase tracking-wider mb-2">
                Recent Whale Activity
              </h3>
              <div className="space-y-1">
                {detail.whaleAlerts.slice(0, 10).map((alert) => (
                  <div key={alert.id} className="flex items-center gap-2 text-[11px] py-1 border-b border-[var(--hl-border)]">
                    <span className="text-[var(--foreground)] font-medium">{alert.whaleName}</span>
                    <span className={
                      alert.eventType.includes("long") || alert.eventType === "increase"
                        ? "text-[var(--hl-green)]"
                        : "text-[var(--hl-red)]"
                    }>
                      {alert.eventType.replace(/_/g, " ")}
                    </span>
                    <span className="text-[var(--hl-muted)] ml-auto">
                      ${(alert.positionValueUsd / 1000).toFixed(0)}K
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MetricBox({ label, value, color = "text-[var(--hl-text)]" }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-md border border-[var(--hl-border)] bg-[var(--hl-surface)] p-2">
      <p className="text-[9px] uppercase tracking-wider text-[var(--hl-muted)]">{label}</p>
      <p className={`mt-0.5 text-[13px] font-medium tabular-nums ${color}`}>{value}</p>
    </div>
  );
}
