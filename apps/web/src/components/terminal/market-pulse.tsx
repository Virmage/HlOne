"use client";

import type { MarketRegime, OptionsSnapshot } from "@/lib/api";

interface MarketPulseProps {
  regime: MarketRegime | null;
  options: Record<string, OptionsSnapshot>;
  onSelectToken: (coin: string) => void;
}

const REGIME_STYLES: Record<string, { text: string; label: string; bg: string }> = {
  risk_on: { text: "text-[var(--hl-green)]", label: "RISK ON", bg: "bg-[rgba(80,210,193,0.1)]" },
  risk_off: { text: "text-[var(--hl-red)]", label: "RISK OFF", bg: "bg-[rgba(240,88,88,0.1)]" },
  neutral: { text: "text-orange-400", label: "CHOP", bg: "bg-[rgba(251,146,60,0.1)]" },
  chop: { text: "text-orange-400", label: "CHOP", bg: "bg-[rgba(251,146,60,0.1)]" },
  divergent: { text: "text-yellow-400", label: "DIVERGENT", bg: "bg-[rgba(250,204,21,0.1)]" },
};

function formatOI(val: number): string {
  if (val >= 1e9) return `$${(val / 1e9).toFixed(1)}B`;
  if (val >= 1e6) return `$${(val / 1e6).toFixed(0)}M`;
  return `$${(val / 1e3).toFixed(0)}K`;
}

export function MarketPulse({ regime, options, onSelectToken }: MarketPulseProps) {
  const regimeStyle = regime ? REGIME_STYLES[regime.regime] || REGIME_STYLES.chop : REGIME_STYLES.chop;
  const optionCoins = Object.keys(options);

  // Aggregate options stats
  const totalCallOI = optionCoins.reduce((sum, c) => sum + (options[c]?.totalCallOI || 0), 0);
  const totalPutOI = optionCoins.reduce((sum, c) => sum + (options[c]?.totalPutOI || 0), 0);
  const totalOI = totalCallOI + totalPutOI;

  return (
    <div className="flex items-center gap-0 px-0 py-0 text-[11px] overflow-x-auto scrollbar-none">
      {/* Market Regime — stands out */}
      <div className={`flex items-center gap-1.5 flex-shrink-0 px-3 py-1.5 border-r border-[var(--hl-border)] ${regimeStyle.bg}`}>
        <span className={`font-bold text-[12px] tracking-wide ${regimeStyle.text}`}>
          {regimeStyle.label}
        </span>
        {regime && (
          <span className={`tabular-nums font-medium ${regime.avgChange24h >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
            {regime.avgChange24h >= 0 ? "+" : ""}{regime.avgChange24h.toFixed(1)}%
          </span>
        )}
        {regime && (
          <span className="text-[var(--hl-muted)] text-[10px]" title={regime.description}>
            {regime.bullishCount}↑ {regime.bearishCount}↓
          </span>
        )}
      </div>

      {/* Aggregate Options OI */}
      {totalOI > 0 && (
        <div className="flex items-center gap-2 flex-shrink-0 px-3 py-1.5 border-r border-[var(--hl-border)]">
          <span className="text-[var(--hl-muted)] text-[10px] font-medium uppercase">Options OI</span>
          <span className="tabular-nums text-[var(--foreground)]">{formatOI(totalOI)}</span>
          <span className="text-[var(--hl-green)] tabular-nums text-[10px]">C:{formatOI(totalCallOI)}</span>
          <span className="text-[var(--hl-red)] tabular-nums text-[10px]">P:{formatOI(totalPutOI)}</span>
        </div>
      )}

      {/* Per-coin Deribit data — expanded */}
      {optionCoins.map((coin) => {
        const opt = options[coin];
        if (!opt) return null;
        const maxPain = opt.maxPain ?? 0;
        const putCall = opt.putCallRatio ?? 0;
        const dvol = opt.dvol ?? 0;
        const skew = opt.skew25d ?? 0;
        const gex = opt.gex ?? 0;
        const gexLvl = opt.gexLevel ?? "neutral";
        const ivRank = opt.ivRank ?? 0;
        const callOI = opt.totalCallOI ?? 0;
        const putOI = opt.totalPutOI ?? 0;
        const topStrikes = opt.topStrikes ?? [];
        const maxPainDist = opt.maxPainDistance ?? 0;

        return (
          <button
            key={coin}
            onClick={() => onSelectToken(coin)}
            className="flex items-center gap-2 flex-shrink-0 px-3 py-1.5 border-r border-[var(--hl-border)] hover:bg-[var(--hl-surface-hover)] transition-colors"
          >
            <span className="font-semibold text-[var(--foreground)]">{coin}</span>

            {/* Max Pain + distance */}
            <span className="text-[var(--hl-muted)] text-[10px]">MP</span>
            <span className="tabular-nums">${maxPain.toLocaleString()}</span>
            {maxPainDist !== 0 && (
              <span className={`tabular-nums text-[10px] ${maxPainDist > 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                {maxPainDist > 0 ? "+" : ""}{maxPainDist.toFixed(1)}%
              </span>
            )}

            {/* P/C Ratio */}
            <span className={`tabular-nums ${putCall > 1 ? "text-[var(--hl-red)]" : "text-[var(--hl-green)]"}`}>
              P/C {putCall.toFixed(2)}
            </span>

            {/* DVOL */}
            <span className="tabular-nums">IV {dvol.toFixed(0)}%</span>

            {/* IV Rank */}
            {ivRank > 0 && (
              <span className={`tabular-nums text-[10px] ${ivRank > 70 ? "text-[var(--hl-red)]" : ivRank < 30 ? "text-[var(--hl-green)]" : "text-[var(--hl-muted)]"}`}
                title={`IV Rank: ${ivRank}% — percentile of current IV vs 1yr range`}
              >
                Rank:{ivRank}%
              </span>
            )}

            {/* 25-delta skew */}
            {skew !== 0 && (
              <span className={`tabular-nums ${skew > 5 ? "text-[var(--hl-red)]" : skew < -5 ? "text-[var(--hl-green)]" : "text-[var(--hl-muted)]"}`}
                title="25-delta skew: positive = puts expensive (fear), negative = calls expensive (greed)"
              >
                Skew {skew > 0 ? "+" : ""}{skew.toFixed(1)}
              </span>
            )}

            {/* GEX */}
            {gex !== 0 && (
              <span className={`tabular-nums ${gexLvl === "dampening" ? "text-[var(--hl-green)]" : gexLvl === "amplifying" ? "text-[var(--hl-red)]" : "text-[var(--hl-muted)]"}`}
                title={`Gamma Exposure: ${gexLvl} — ${gexLvl === "dampening" ? "dealers hedge = lower vol" : "dealers amplify = higher vol"}`}
              >
                GEX {gex > 0 ? "+" : ""}{gex}M
              </span>
            )}

            {/* Top Strike */}
            {topStrikes.length > 0 && (
              <span className="text-[var(--hl-muted)] tabular-nums text-[10px]"
                title={`Top strikes: ${topStrikes.slice(0, 3).map(s => `$${s.strike.toLocaleString()} (C:${(s.callOI/1e6).toFixed(0)}M P:${(s.putOI/1e6).toFixed(0)}M)`).join(", ")}`}
              >
                Top:${topStrikes[0]?.strike.toLocaleString()}
              </span>
            )}
          </button>
        );
      })}

      {/* If no options data, show placeholder */}
      {optionCoins.length === 0 && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-[var(--hl-muted)] text-[10px]">
          Options data loading...
        </div>
      )}
    </div>
  );
}
