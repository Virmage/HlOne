"use client";

import React from "react";
import type { CorrelationMatrix as CorrMatrix } from "@/lib/api";

interface CorrelationMatrixProps {
  data: CorrMatrix | null;
  onSelectToken: (coin: string) => void;
}

function corrStyle(val: number): React.CSSProperties {
  // Intensity-only: blue (low |corr|) → yellow (high |corr|)
  const t = Math.abs(val);
  const r = Math.round(100 + t * 155);
  const g = Math.round(160 + t * 70);
  const b = Math.round(255 - t * 255);
  const a = 0.08 + t * 0.45;
  return { backgroundColor: `rgba(${r}, ${g}, ${b}, ${a})` };
}

function corrTextColor(val: number): string {
  const abs = Math.abs(val);
  if (abs >= 0.7) return "text-yellow-400";
  if (abs >= 0.4) return "text-[var(--hl-text)]";
  return "text-[var(--hl-muted)]";
}

export function CorrelationMatrixPanel({ data, onSelectToken }: CorrelationMatrixProps) {
  if (!data || data.coins.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-[var(--hl-muted)] text-[12px]">
        Loading correlation data...
      </div>
    );
  }

  const { coins, matrix, avgCorrelation, outliers } = data;

  // Build all pairs sorted by correlation for the list view
  const allPairs: { coin1: string; coin2: string; corr: number }[] = [];
  for (let i = 0; i < coins.length; i++) {
    for (let j = i + 1; j < coins.length; j++) {
      allPairs.push({ coin1: coins[i], coin2: coins[j], corr: matrix[i][j] });
    }
  }
  allPairs.sort((a, b) => b.corr - a.corr);

  const regimeColor = avgCorrelation > 0.6
    ? "text-[var(--hl-red)]"
    : avgCorrelation > 0.3
    ? "text-orange-400"
    : "text-[var(--hl-green)]";

  const regimeLabel = avgCorrelation > 0.6
    ? "High — assets moving together, concentration risk"
    : avgCorrelation > 0.3
    ? "Moderate — some diversification"
    : "Low — good diversification";

  return (
    <div>
      <h2 className="text-[13px] font-medium text-[var(--hl-muted)] uppercase tracking-wider mb-2 px-1">
        Correlation
      </h2>

      {/* Regime summary bar */}
      <div className="flex items-center gap-2 px-2 mb-3 py-1.5 rounded bg-[var(--hl-surface)]">
        <span className="text-[10px] text-[var(--hl-muted)]">Market Avg</span>
        <span className={`text-[14px] font-bold tabular-nums ${regimeColor}`}>
          {avgCorrelation.toFixed(2)}
        </span>
        <span className="text-[10px] text-[var(--hl-muted)] truncate">{regimeLabel}</span>
      </div>

      {/* Mini heatmap — color only, no numbers */}
      <div className="px-1 mb-3">
        <div className="inline-grid gap-[1px]" style={{
          gridTemplateColumns: `24px repeat(${coins.length}, 1fr)`,
          width: "100%",
        }}>
          {/* Header */}
          <div />
          {coins.map(coin => (
            <div key={`h-${coin}`} className="text-[7px] text-[var(--hl-muted)] text-center truncate">
              {coin.slice(0, 4)}
            </div>
          ))}

          {/* Rows — color cells only */}
          {coins.map((rowCoin, i) => (
            <>
              <div key={`r-${rowCoin}`} className="text-[8px] text-[var(--hl-muted)] text-right pr-1 leading-[16px]">
                {rowCoin.slice(0, 4)}
              </div>
              {coins.map((colCoin, j) => {
                const val = matrix[i][j];
                const isDiag = i === j;
                return (
                  <div
                    key={`${i}-${j}`}
                    className="h-4 rounded-[2px] cursor-default"
                    style={isDiag ? { backgroundColor: "rgba(255,255,255,0.06)" } : corrStyle(val)}
                    title={`${rowCoin}/${colCoin}: ${val.toFixed(2)}`}
                  />
                );
              })}
            </>
          ))}
        </div>

        {/* Color legend — intensity scale */}
        <div className="flex items-center justify-center gap-1.5 mt-1.5 text-[8px] text-[var(--hl-muted)]">
          <span>Low</span>
          <div className="flex h-2 rounded-sm overflow-hidden" style={{ width: "60px" }}>
            {[0, 0.25, 0.5, 0.75, 1].map((t, i) => (
              <div
                key={i}
                className="flex-1"
                style={{
                  backgroundColor: `rgba(${Math.round(100 + t * 155)}, ${Math.round(160 + t * 70)}, ${Math.round(255 - t * 255)}, ${0.3 + t * 0.4})`,
                }}
              />
            ))}
          </div>
          <span>High</span>
        </div>
      </div>

      {/* Notable pairs list */}
      <div className="px-1">
        <div className="text-[10px] text-[var(--hl-muted)] uppercase tracking-wider mb-1">Most correlated</div>
        <div className="space-y-0">
          {allPairs.slice(0, 4).map((p, i) => (
            <div key={i} className="flex items-center justify-between py-1 text-[11px] border-b border-[var(--hl-border)]">
              <button
                className="flex items-center gap-1 hover:text-[var(--foreground)] transition-colors text-[var(--hl-text)]"
                onClick={() => onSelectToken(p.coin1)}
              >
                <span className="font-medium">{p.coin1}</span>
                <span className="text-[var(--hl-muted)]">/</span>
                <span className="font-medium">{p.coin2}</span>
              </button>
              <div className="flex items-center gap-2">
                <div className="w-16 h-1.5 rounded-full bg-[var(--hl-border)] overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.max(Math.abs(p.corr) * 100, 0)}%`,
                      backgroundColor: `rgb(${Math.round(100 + Math.abs(p.corr) * 155)}, ${Math.round(160 + Math.abs(p.corr) * 70)}, ${Math.round(255 - Math.abs(p.corr) * 255)})`,
                      opacity: 0.7,
                    }}
                  />
                </div>
                <span className={`tabular-nums font-medium w-10 text-right ${corrTextColor(p.corr)}`}>
                  {p.corr.toFixed(2)}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* Least correlated */}
        <div className="text-[10px] text-[var(--hl-muted)] uppercase tracking-wider mb-1 mt-2">Least correlated</div>
        <div className="space-y-0">
          {allPairs.slice(-3).reverse().map((p, i) => (
            <div key={i} className="flex items-center justify-between py-1 text-[11px] border-b border-[var(--hl-border)]">
              <button
                className="flex items-center gap-1 hover:text-[var(--foreground)] transition-colors text-[var(--hl-text)]"
                onClick={() => onSelectToken(p.coin1)}
              >
                <span className="font-medium">{p.coin1}</span>
                <span className="text-[var(--hl-muted)]">/</span>
                <span className="font-medium">{p.coin2}</span>
              </button>
              <div className="flex items-center gap-2">
                <div className="w-16 h-1.5 rounded-full bg-[var(--hl-border)] overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.max((1 - Math.abs(p.corr)) * 50, 2)}%`,
                      backgroundColor: `rgb(${Math.round(100 + Math.abs(p.corr) * 155)}, ${Math.round(160 + Math.abs(p.corr) * 70)}, ${Math.round(255 - Math.abs(p.corr) * 255)})`,
                      opacity: 0.7,
                    }}
                  />
                </div>
                <span className={`tabular-nums font-medium w-10 text-right ${corrTextColor(p.corr)}`}>
                  {p.corr.toFixed(2)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
