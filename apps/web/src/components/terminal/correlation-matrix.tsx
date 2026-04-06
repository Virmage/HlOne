"use client";

import type { CorrelationMatrix as CorrMatrix } from "@/lib/api";

interface CorrelationMatrixProps {
  data: CorrMatrix | null;
  onSelectToken: (coin: string) => void;
}

function corrBg(val: number): string {
  const abs = Math.abs(val);
  if (val >= 0.8) return "bg-red-500/60";
  if (val >= 0.6) return "bg-red-500/35";
  if (val >= 0.4) return "bg-red-500/20";
  if (val >= 0.2) return "bg-red-500/10";
  if (val <= -0.4) return "bg-blue-500/50";
  if (val <= -0.2) return "bg-blue-500/25";
  if (val <= -0.05) return "bg-blue-500/10";
  return "bg-white/[0.03]";
}

function corrTextColor(val: number): string {
  if (val >= 0.7) return "text-[var(--hl-red)]";
  if (val <= -0.2) return "text-blue-400";
  if (val <= 0.2) return "text-[var(--hl-green)]";
  return "text-[var(--hl-text)]";
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
                    className={`h-4 rounded-[2px] ${isDiag ? "bg-white/[0.06]" : corrBg(val)} cursor-default`}
                    title={`${rowCoin}/${colCoin}: ${val.toFixed(2)}`}
                  />
                );
              })}
            </>
          ))}
        </div>

        {/* Color legend */}
        <div className="flex items-center justify-center gap-2 mt-1.5 text-[8px] text-[var(--hl-muted)]">
          <span className="flex items-center gap-0.5"><span className="w-2 h-2 rounded-sm bg-blue-500/40" /> -1</span>
          <span className="flex items-center gap-0.5"><span className="w-2 h-2 rounded-sm bg-white/[0.05]" /> 0</span>
          <span className="flex items-center gap-0.5"><span className="w-2 h-2 rounded-sm bg-red-500/50" /> +1</span>
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
                    className="h-full rounded-full bg-[var(--hl-red)]"
                    style={{ width: `${Math.max(p.corr * 100, 0)}%`, opacity: 0.7 }}
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
                    className="h-full rounded-full bg-[var(--hl-green)]"
                    style={{ width: `${Math.max((1 - p.corr) * 50, 2)}%`, opacity: 0.7 }}
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
