"use client";

import type { LiquidationHeatmap as LiqHeatmap } from "@/lib/api";
import { useState } from "react";

interface LiquidationHeatmapProps {
  data: LiqHeatmap[];
  onSelectToken: (coin: string) => void;
}

function formatUsd(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

export function LiquidationHeatmapPanel({ data, onSelectToken }: LiquidationHeatmapProps) {
  const [selectedCoin, setSelectedCoin] = useState<string | null>(null);

  if (!data.length) {
    return (
      <div className="flex h-32 items-center justify-center text-[var(--hl-muted)] text-[12px]">
        Loading liquidation data...
      </div>
    );
  }

  const activeCoin = selectedCoin || data[0]?.coin;
  const coinData = data.find(d => d.coin === activeCoin) || data[0];

  // Find max value for bar scaling
  const maxVal = Math.max(
    ...coinData.bands.map(b => Math.max(b.longLiqValue, b.shortLiqValue)),
    1
  );

  return (
    <div>
      <h2 className="text-[13px] font-medium text-[var(--hl-muted)] uppercase tracking-wider mb-2 px-1">
        Liquidation Heatmap
      </h2>

      {/* Coin selector tabs */}
      <div className="flex gap-1 px-1 mb-2 overflow-x-auto">
        {data.slice(0, 8).map(d => (
          <button
            key={d.coin}
            onClick={() => { setSelectedCoin(d.coin); onSelectToken(d.coin); }}
            className={`px-2 py-0.5 text-[10px] rounded whitespace-nowrap transition-colors ${
              d.coin === activeCoin
                ? "bg-[var(--hl-green)] text-black font-medium"
                : "text-[var(--hl-muted)] hover:text-[var(--foreground)]"
            }`}
          >
            {d.coin}
          </button>
        ))}
      </div>

      {/* Summary */}
      <div className="flex items-center gap-3 px-2 mb-2 text-[10px]">
        <span className="text-[var(--hl-muted)]">
          Price: <span className="text-[var(--foreground)] tabular-nums">${coinData.currentPrice.toLocaleString()}</span>
        </span>
        <span className="text-[var(--hl-red)]" title="Long liquidations below current price">
          Longs rekt: {formatUsd(coinData.totalLongLiqAbove)}
        </span>
        <span className="text-[var(--hl-green)]" title="Short liquidations above current price">
          Shorts rekt: {formatUsd(coinData.totalShortLiqBelow)}
        </span>
      </div>

      {/* Heatmap bars */}
      <div className="overflow-y-auto scroll-on-hover max-h-[200px] px-1">
        {coinData.bands.map((band, i) => {
          const isAbove = band.priceMid > coinData.currentPrice;
          const longPct = (band.longLiqValue / maxVal) * 100;
          const shortPct = (band.shortLiqValue / maxVal) * 100;
          const isCurrentBand = Math.abs(band.distancePct) < 1;

          return (
            <div
              key={i}
              className={`flex items-center gap-1 py-0.5 text-[10px] ${
                isCurrentBand ? "bg-[rgba(255,255,255,0.05)]" : ""
              }`}
            >
              {/* Distance label */}
              <span className={`w-10 text-right tabular-nums shrink-0 ${
                isAbove ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"
              }`}>
                {band.distancePct > 0 ? "+" : ""}{band.distancePct}%
              </span>

              {/* Long liq bar (red — longs get rekt) */}
              <div className="flex-1 flex justify-end h-3">
                {band.longLiqValue > 0 && (
                  <div
                    className="h-full bg-[var(--hl-red)] rounded-sm opacity-70"
                    style={{ width: `${Math.max(longPct, 2)}%` }}
                    title={`Long liqs: ${formatUsd(band.longLiqValue)} (${band.traderCount} traders)`}
                  />
                )}
              </div>

              {/* Price label */}
              <span className="w-16 text-center tabular-nums text-[var(--hl-muted)] shrink-0 text-[9px]">
                ${band.priceMid >= 1000 ? (band.priceMid / 1000).toFixed(1) + "K" : band.priceMid.toFixed(1)}
              </span>

              {/* Short liq bar (green — shorts get rekt) */}
              <div className="flex-1 flex justify-start h-3">
                {band.shortLiqValue > 0 && (
                  <div
                    className="h-full bg-[var(--hl-green)] rounded-sm opacity-70"
                    style={{ width: `${Math.max(shortPct, 2)}%` }}
                    title={`Short liqs: ${formatUsd(band.shortLiqValue)} (${band.traderCount} traders)`}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex items-center justify-center gap-4 mt-1 px-2 text-[9px] text-[var(--hl-muted)]">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-sm bg-[var(--hl-red)] opacity-70" /> Long Liqs
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-sm bg-[var(--hl-green)] opacity-70" /> Short Liqs
        </span>
      </div>
    </div>
  );
}
