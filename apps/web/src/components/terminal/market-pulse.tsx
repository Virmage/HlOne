"use client";

import type { MarketRegime, OptionsSnapshot } from "@/lib/api";
import { useTickerAnimation } from "@/hooks/use-ticker-animation";

// Coins with options on Derive (clickable to open chain)
const DERIVE_COINS = new Set(["BTC", "ETH", "SOL", "HYPE"]);

interface MarketPulseProps {
  regime: MarketRegime | null;
  options: Record<string, OptionsSnapshot>;
  onSelectToken: (coin: string) => void;
  onOpenOptions?: (coin: string) => void;
}

const REGIME_STYLES: Record<string, { text: string; label: string; bg: string }> = {
  risk_on:      { text: "text-[var(--hl-green)]",  label: "RISK ON",      bg: "bg-[rgba(80,210,193,0.12)]" },
  risk_off:     { text: "text-[var(--hl-red)]",    label: "RISK OFF",     bg: "bg-[rgba(240,88,88,0.12)]" },
  chop:         { text: "text-orange-400",          label: "CHOP",         bg: "bg-[rgba(251,146,60,0.12)]" },
  rotation:     { text: "text-blue-400",            label: "ROTATION",     bg: "bg-[rgba(96,165,250,0.12)]" },
  squeeze:      { text: "text-purple-400",          label: "SQUEEZE",      bg: "bg-[rgba(192,132,252,0.12)]" },
  capitulation: { text: "text-yellow-400",          label: "CAPITULATION", bg: "bg-[rgba(250,204,21,0.12)]" },
};

function formatOI(val: number): string {
  if (val >= 1e9) return `$${(val / 1e9).toFixed(1)}B`;
  if (val >= 1e6) return `$${(val / 1e6).toFixed(0)}M`;
  return `$${(val / 1e3).toFixed(0)}K`;
}

export function MarketPulse({ regime, options, onSelectToken, onOpenOptions }: MarketPulseProps) {
  const { trackRef, onMouseEnter, onMouseLeave } = useTickerAnimation(90, false, false);
  const regimeStyle = regime ? REGIME_STYLES[regime.regime] || REGIME_STYLES.chop : REGIME_STYLES.chop;
  const optionCoins = Object.keys(options);

  // Aggregate options stats
  const totalCallOI = optionCoins.reduce((sum, c) => sum + (options[c]?.totalCallOI || 0), 0);
  const totalPutOI = optionCoins.reduce((sum, c) => sum + (options[c]?.totalPutOI || 0), 0);
  const totalOI = totalCallOI + totalPutOI;

  return (
    <div className="overflow-hidden border-b border-[var(--hl-border)] bg-[var(--hl-surface)]">
      <div ref={trackRef} className="flex" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} style={{ willChange: "transform", backfaceVisibility: "hidden" }}>
        {[0, 1].map((copy) => (
          <div key={copy} className="flex items-center shrink-0" aria-hidden={copy === 1}>
            {/* Aggregate Options OI */}
            {totalOI > 0 && (
              <div className="flex items-center gap-2 flex-shrink-0 px-3 py-1.5 border-r border-[var(--hl-border)] text-[11px]">
                <span className="text-[var(--hl-muted)] text-[10px] font-medium">Options OI</span>
                <span className="tabular-nums text-[var(--foreground)]">{formatOI(totalOI)}</span>
                <span className="text-[var(--hl-green)] tabular-nums text-[10px]">C:{formatOI(totalCallOI)}</span>
                <span className="text-[var(--hl-red)] tabular-nums text-[10px]">P:{formatOI(totalPutOI)}</span>
              </div>
            )}

            {/* Per-coin options data — Derive coins are clickable to open chain */}
            {optionCoins.map((coin) => {
              const isDerive = DERIVE_COINS.has(coin);
              const opt = options[coin];
              if (!opt) return null;
              const maxPain = opt.maxPain ?? 0;
              const putCall = opt.putCallRatio ?? 0;
              const dvol = opt.dvol ?? 0;
              const skew = opt.skew25d ?? 0;
              const gex = opt.gex ?? 0;
              const gexLvl = opt.gexLevel ?? "neutral";
              const ivRank = opt.ivRank ?? 0;
              const topStrikes = opt.topStrikes ?? [];
              const maxPainDist = opt.maxPainDistance ?? 0;

              return (
                <button
                  key={`${copy}-${coin}`}
                  onClick={() => isDerive && onOpenOptions ? onOpenOptions(coin) : onSelectToken(coin)}
                  className={`flex items-center gap-2 flex-shrink-0 px-3 py-1.5 border-r border-[var(--hl-border)] transition-colors text-[11px] ${
                    isDerive ? "hover:bg-[rgba(168,85,247,0.08)]" : "hover:bg-[var(--hl-surface-hover)]"
                  }`}
                >
                  <span className={`font-semibold ${isDerive ? "text-purple-400" : "text-[var(--foreground)]"}`}>{coin}</span>
                  {isDerive && <span className="text-[8px] px-1 rounded bg-purple-500/15 text-purple-400/70">Derive</span>}
                  <span className="text-[var(--hl-muted)] text-[10px]">MP</span>
                  <span className="tabular-nums">${maxPain.toLocaleString()}</span>
                  {maxPainDist !== 0 && (
                    <span className={`tabular-nums text-[10px] ${maxPainDist > 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                      {maxPainDist > 0 ? "+" : ""}{maxPainDist.toFixed(1)}%
                    </span>
                  )}
                  <span className={`tabular-nums ${putCall > 1 ? "text-[var(--hl-red)]" : "text-[var(--hl-green)]"}`}>
                    P/C {putCall.toFixed(2)}
                  </span>
                  <span className="tabular-nums">IV {dvol.toFixed(0)}%</span>
                  {ivRank > 0 && (
                    <span className={`tabular-nums text-[10px] ${ivRank > 70 ? "text-[var(--hl-red)]" : ivRank < 30 ? "text-[var(--hl-green)]" : "text-[var(--hl-muted)]"}`}
                      title={`IV Rank: ${ivRank}% — percentile of current IV vs 1yr range`}
                    >
                      Rank:{ivRank}%
                    </span>
                  )}
                  {skew !== 0 && (
                    <span className={`tabular-nums ${skew > 5 ? "text-[var(--hl-red)]" : skew < -5 ? "text-[var(--hl-green)]" : "text-[var(--hl-muted)]"}`}>
                      Skew {skew > 0 ? "+" : ""}{skew.toFixed(1)}
                    </span>
                  )}
                  {gex !== 0 && (
                    <span className={`tabular-nums ${gexLvl === "dampening" ? "text-[var(--hl-green)]" : gexLvl === "amplifying" ? "text-[var(--hl-red)]" : "text-[var(--hl-muted)]"}`}>
                      GEX {gex > 0 ? "+" : ""}{gex}M
                    </span>
                  )}
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

            {/* Market Regime — at end so it scrolls in from right */}
            <div className={`flex items-center gap-2 flex-shrink-0 px-3 py-1.5 border-r border-[var(--hl-border)] ${regimeStyle.bg}`}>
              <span className={`font-bold text-[12px] tracking-wide ${regimeStyle.text}`}>
                {regimeStyle.label}
              </span>
              {regime && regime.confidence > 0 && (
                <span className="text-[var(--hl-muted)] text-[10px] tabular-nums">
                  {regime.confidence}%
                </span>
              )}
              {regime?.action && (
                <span className="text-[var(--hl-text)] text-[10px] whitespace-nowrap">
                  {regime.action}
                </span>
              )}
              {regime?.description && (
                <span className="text-[var(--hl-muted)] text-[10px] whitespace-nowrap">
                  — {regime.description}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
