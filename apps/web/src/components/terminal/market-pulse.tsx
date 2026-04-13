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
  avgCorrelation?: number | null;
}

const REGIME_STYLES: Record<string, { text: string; label: string; border: string }> = {
  risk_on:      { text: "text-[var(--hl-green)]",  label: "RISK ON",      border: "border-[rgba(80,210,193,0.4)]" },
  risk_off:     { text: "text-[var(--hl-red)]",    label: "RISK OFF",     border: "border-[rgba(240,88,88,0.4)]" },
  chop:         { text: "text-orange-400",          label: "CHOP",         border: "border-orange-400/30" },
  rotation:     { text: "text-blue-400",            label: "ROTATION",     border: "border-blue-400/30" },
  squeeze:      { text: "text-purple-400",          label: "SQUEEZE",      border: "border-purple-400/30" },
  capitulation: { text: "text-yellow-400",          label: "CAPITULATION", border: "border-yellow-400/30" },
};

function formatOI(val: number): string {
  if (val >= 1e9) return `$${(val / 1e9).toFixed(1)}B`;
  if (val >= 1e6) return `$${(val / 1e6).toFixed(0)}M`;
  return `$${(val / 1e3).toFixed(0)}K`;
}

const badgeBase = "flex items-center gap-1 px-2 py-0.5 rounded-md border border-[var(--hl-border)] transition-colors text-[10px]";
const badgeHover = "hover:border-[var(--hl-accent)] cursor-pointer";

export function MarketPulse({ regime, options, onSelectToken, onOpenOptions, avgCorrelation }: MarketPulseProps) {
  const { trackRef, onMouseEnter, onMouseLeave } = useTickerAnimation(90, false, false);
  const regimeStyle = regime ? REGIME_STYLES[regime.regime] || REGIME_STYLES.chop : REGIME_STYLES.chop;
  const optionCoins = Object.keys(options);

  // Aggregate options stats
  const totalCallOI = optionCoins.reduce((sum, c) => sum + (options[c]?.totalCallOI || 0), 0);
  const totalPutOI = optionCoins.reduce((sum, c) => sum + (options[c]?.totalPutOI || 0), 0);
  const totalOI = totalCallOI + totalPutOI;

  return (
    <div className="overflow-hidden shrink-0">
      <div ref={trackRef} className="flex py-1 px-2 gap-1" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} style={{ willChange: "transform", backfaceVisibility: "hidden" }}>
        {[0, 1].map((copy) => (
          <div key={copy} className="flex items-center shrink-0 gap-1" aria-hidden={copy === 1}>
            {/* Aggregate Options OI */}
            {totalOI > 0 && (
              <div className={badgeBase}>
                <span className="text-[var(--hl-muted)] font-medium">Options OI</span>
                <span className="tabular-nums text-[var(--foreground)]">{formatOI(totalOI)}</span>
                <span className="text-[var(--hl-green)] tabular-nums">C:{formatOI(totalCallOI)}</span>
                <span className="text-[var(--hl-red)] tabular-nums">P:{formatOI(totalPutOI)}</span>
              </div>
            )}

            {/* Per-coin options data */}
            {optionCoins.map((coin) => {
              const isDerive = DERIVE_COINS.has(coin);
              const opt = options[coin];
              if (!opt) return null;
              const maxPain = opt.maxPain ?? 0;
              const putCall = opt.putCallRatio ?? 0;
              const dvol = opt.dvol ?? 0;
              const skew = opt.skew25d ?? 0;
              const ivRank = opt.ivRank ?? 0;
              const maxPainDist = opt.maxPainDistance ?? 0;

              return (
                <button
                  key={`${copy}-${coin}`}
                  onClick={() => isDerive && onOpenOptions ? onOpenOptions(coin) : onSelectToken(coin)}
                  className={`${badgeBase} ${badgeHover}`}
                >
                  <span className={`font-bold ${isDerive ? "text-purple-400" : "text-[var(--foreground)]"}`}>{coin}</span>
                  <span className="text-[var(--hl-muted)]">MP</span>
                  <span className="tabular-nums font-semibold">${maxPain.toLocaleString()}</span>
                  {maxPainDist !== 0 && (
                    <span className={`tabular-nums ${maxPainDist > 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                      {maxPainDist > 0 ? "+" : ""}{maxPainDist.toFixed(1)}%
                    </span>
                  )}
                  <span className={`tabular-nums ${putCall > 1 ? "text-[var(--hl-red)]" : "text-[var(--hl-green)]"}`}>
                    P/C {putCall.toFixed(2)}
                  </span>
                  <span className="tabular-nums">IV {dvol.toFixed(0)}%</span>
                  {ivRank > 0 && (
                    <span className={`tabular-nums ${ivRank > 70 ? "text-[var(--hl-red)]" : ivRank < 30 ? "text-[var(--hl-green)]" : "text-[var(--hl-muted)]"}`}>
                      Rank:{ivRank}%
                    </span>
                  )}
                  {skew !== 0 && (
                    <span className={`tabular-nums ${skew > 5 ? "text-[var(--hl-red)]" : skew < -5 ? "text-[var(--hl-green)]" : "text-[var(--hl-muted)]"}`}>
                      Skew {skew > 0 ? "+" : ""}{skew.toFixed(1)}
                    </span>
                  )}
                </button>
              );
            })}

            {/* Market Regime */}
            <div className={`${badgeBase} ${regimeStyle.border}`}>
              <span className={`font-bold tracking-wide ${regimeStyle.text}`}>
                {regimeStyle.label}
              </span>
              {regime && regime.confidence > 0 && (
                <span className="text-[var(--hl-muted)] tabular-nums">
                  {regime.confidence}%
                </span>
              )}
              {regime?.action && (
                <span className="text-[var(--hl-text)] whitespace-nowrap">
                  {regime.action}
                </span>
              )}
            </div>

            {/* Market Correlation — how correlated top coins are (1.0 = all moving together, 0 = independent) */}
            {avgCorrelation !== null && avgCorrelation !== undefined && (
              <div className={badgeBase} title="Market correlation: how similarly top coins are moving. High = herd mode, Low = diversified/rotation.">
                <span className="text-[var(--hl-muted)]">Mkt Corr</span>
                <span className={`font-bold tabular-nums ${
                  avgCorrelation > 0.6 ? "text-[var(--hl-red)]" : avgCorrelation > 0.3 ? "text-orange-400" : "text-[var(--hl-green)]"
                }`}>
                  {avgCorrelation.toFixed(2)}
                </span>
                <span className="text-[var(--hl-muted)] text-[9px]">
                  {avgCorrelation > 0.6 ? "herd" : avgCorrelation > 0.3 ? "mixed" : "diverse"}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
