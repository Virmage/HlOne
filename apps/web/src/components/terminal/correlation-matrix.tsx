"use client";

import type { CorrelationMatrix as CorrMatrix } from "@/lib/api";

interface CorrelationMatrixProps {
  data: CorrMatrix | null;
  onSelectToken: (coin: string) => void;
}

function corrColor(val: number): string {
  // Diverging color scale: blue (-1) → grey (0) → red (+1)
  if (val >= 0.7) return "rgba(240,88,88,0.7)";
  if (val >= 0.5) return "rgba(240,88,88,0.4)";
  if (val >= 0.3) return "rgba(240,88,88,0.2)";
  if (val <= -0.3) return "rgba(96,165,250,0.5)";
  if (val <= -0.1) return "rgba(96,165,250,0.25)";
  if (val > 0.1) return "rgba(240,88,88,0.1)";
  return "rgba(255,255,255,0.03)";
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

  const regimeLabel = avgCorrelation > 0.6
    ? "High correlation — risk-on/off regime, avoid concentration"
    : avgCorrelation > 0.3
    ? "Moderate correlation — some diversification benefit"
    : "Low correlation — good diversification conditions";

  return (
    <div>
      <h2 className="text-[13px] font-medium text-[var(--hl-muted)] uppercase tracking-wider mb-2 px-1">
        Correlation Matrix <span className="text-[10px] normal-case font-normal">(24h, 1h returns)</span>
      </h2>

      {/* Matrix grid */}
      <div className="overflow-x-auto px-1">
        <div className="inline-grid gap-px" style={{
          gridTemplateColumns: `28px repeat(${coins.length}, 1fr)`,
          minWidth: `${28 + coins.length * 28}px`,
        }}>
          {/* Header row */}
          <div />
          {coins.map(coin => (
            <button
              key={`h-${coin}`}
              onClick={() => onSelectToken(coin)}
              className="text-[8px] text-[var(--hl-muted)] text-center py-0.5 hover:text-[var(--foreground)] transition-colors truncate"
              style={{ writingMode: "horizontal-tb" }}
            >
              {coin}
            </button>
          ))}

          {/* Matrix rows */}
          {coins.map((rowCoin, i) => (
            <>
              <button
                key={`r-${rowCoin}`}
                onClick={() => onSelectToken(rowCoin)}
                className="text-[9px] text-[var(--hl-muted)] text-right pr-1 py-0.5 hover:text-[var(--foreground)] transition-colors"
              >
                {rowCoin}
              </button>
              {coins.map((colCoin, j) => {
                const val = matrix[i][j];
                const isDiagonal = i === j;
                return (
                  <div
                    key={`${rowCoin}-${colCoin}`}
                    className="flex items-center justify-center py-0.5 text-[8px] tabular-nums cursor-default transition-opacity hover:opacity-80"
                    style={{
                      backgroundColor: isDiagonal ? "rgba(255,255,255,0.08)" : corrColor(val),
                      minHeight: "20px",
                    }}
                    title={`${rowCoin}/${colCoin}: ${val.toFixed(2)}`}
                  >
                    <span className={isDiagonal ? "text-[var(--hl-muted)]" : "text-[var(--foreground)]"}>
                      {isDiagonal ? "—" : val.toFixed(2)}
                    </span>
                  </div>
                );
              })}
            </>
          ))}
        </div>
      </div>

      {/* Summary */}
      <div className="mt-2 px-2 text-[10px]">
        <div className="flex items-center gap-2">
          <span className="text-[var(--hl-muted)]">Avg:</span>
          <span className={`tabular-nums font-medium ${
            avgCorrelation > 0.6 ? "text-[var(--hl-red)]" : avgCorrelation > 0.3 ? "text-orange-400" : "text-[var(--hl-green)]"
          }`}>
            {avgCorrelation.toFixed(2)}
          </span>
          <span className="text-[var(--hl-muted)] truncate">{regimeLabel}</span>
        </div>

        {/* Notable pairs */}
        {outliers.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[9px]">
            {outliers.slice(0, 3).map((o, i) => (
              <span key={i} className="text-[var(--hl-muted)]">
                {o.coin1}/{o.coin2}:{" "}
                <span className={`tabular-nums ${
                  o.label === "highly_correlated" ? "text-[var(--hl-red)]"
                  : o.label === "inversely_correlated" ? "text-blue-400"
                  : "text-[var(--hl-green)]"
                }`}>
                  {o.correlation.toFixed(2)}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
