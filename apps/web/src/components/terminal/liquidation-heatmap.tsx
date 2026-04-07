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

  // Find max combined value for intensity scaling
  const maxVal = Math.max(
    ...coinData.bands.map(b => b.longLiqValue + b.shortLiqValue),
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
        <span className="text-[var(--hl-muted)]">
          Total: <span className="text-[var(--foreground)] tabular-nums">{formatUsd(coinData.totalLongLiqAbove + coinData.totalShortLiqBelow)}</span>
        </span>
      </div>

      {/* Heatmap bars — intensity gradient from blue (low) to yellow (high) */}
      <div className="overflow-y-auto scroll-on-hover max-h-[200px] px-1">
        {coinData.bands.map((band, i) => {
          const isAbove = band.priceMid > coinData.currentPrice;
          const totalVal = band.longLiqValue + band.shortLiqValue;
          const intensity = totalVal / maxVal; // 0..1
          const barPct = (totalVal / maxVal) * 100;
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

              {/* Intensity bar — blue→yellow gradient based on CSS vars */}
              <div className="flex-1 h-3.5 relative rounded-sm overflow-hidden bg-[var(--hl-border)]">
                {totalVal > 0 && (
                  <div
                    className="absolute inset-y-0 left-0 rounded-sm"
                    style={{
                      width: `${Math.max(barPct, 3)}%`,
                      backgroundColor: `rgb(${Math.round(
                        // Lerp from --hl-heat-low to --hl-heat-high based on intensity
                        // Low (blue): rgb(100,160,255) → High (yellow): rgb(255,230,0)
                        // Use inline calc since CSS vars with rgb channels
                        100 + intensity * 155
                      )}, ${Math.round(
                        160 + intensity * 70
                      )}, ${Math.round(
                        255 - intensity * 255
                      )})`,
                      opacity: 0.5 + intensity * 0.5,
                    }}
                    title={`$${band.priceLow?.toFixed(0) ?? band.priceMid.toFixed(0)}–$${band.priceHigh?.toFixed(0) ?? band.priceMid.toFixed(0)}: ${formatUsd(totalVal)} (${band.traderCount} traders)`}
                  />
                )}
              </div>

              {/* Price label */}
              <span className="w-16 text-center tabular-nums text-[var(--hl-muted)] shrink-0 text-[9px]">
                ${band.priceMid >= 1000 ? (band.priceMid / 1000).toFixed(1) + "K" : band.priceMid.toFixed(1)}
              </span>

              {/* Value label */}
              <span className="w-12 text-right tabular-nums text-[var(--hl-muted)] shrink-0 text-[9px]">
                {totalVal > 0 ? formatUsd(totalVal) : ""}
              </span>
            </div>
          );
        })}
      </div>

      {/* Legend — intensity scale */}
      <div className="flex items-center justify-center gap-2 mt-1.5 px-2 text-[8px] text-[var(--hl-muted)]">
        <span>Low</span>
        <div className="flex h-2 rounded-sm overflow-hidden" style={{ width: "80px" }}>
          {[0, 0.2, 0.4, 0.6, 0.8, 1].map((t, i) => (
            <div
              key={i}
              className="flex-1"
              style={{
                backgroundColor: `rgb(${Math.round(100 + t * 155)}, ${Math.round(160 + t * 70)}, ${Math.round(255 - t * 255)})`,
                opacity: 0.5 + t * 0.5,
              }}
            />
          ))}
        </div>
        <span>High</span>
      </div>
    </div>
  );
}
