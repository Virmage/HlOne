"use client";

import type { MarketRegime, OptionsSnapshot } from "@/lib/api";

interface MarketPulseProps {
  regime: MarketRegime | null;
  options: Record<string, OptionsSnapshot>;
  onSelectToken: (coin: string) => void;
}

const REGIME_STYLES: Record<string, { text: string; label: string }> = {
  risk_on: { text: "text-[var(--hl-green)]", label: "RISK ON" },
  risk_off: { text: "text-[var(--hl-red)]", label: "RISK OFF" },
  neutral: { text: "text-[var(--hl-muted)]", label: "NEUTRAL" },
  divergent: { text: "text-yellow-400", label: "DIVERGENT" },
};

export function MarketPulse({ regime, options, onSelectToken }: MarketPulseProps) {
  const regimeStyle = regime ? REGIME_STYLES[regime.regime] || REGIME_STYLES.neutral : REGIME_STYLES.neutral;

  return (
    <div className="flex items-center gap-3 px-3 py-1.5 text-[11px] overflow-x-auto">
      {/* Market Regime */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <span className={`font-bold ${regimeStyle.text}`}>{regimeStyle.label}</span>
        {regime && (
          <span className="text-[var(--hl-muted)]">
            {regime.avgChange24h >= 0 ? "+" : ""}{regime.avgChange24h.toFixed(1)}%
          </span>
        )}
      </div>

      <span className="text-[var(--hl-border)]">│</span>

      {/* Deribit Options — compact inline */}
      <span className="text-[var(--hl-muted)] text-[10px] flex-shrink-0">Deribit</span>
      {Object.keys(options).map((coin) => {
        const opt = options[coin];
        if (!opt) return null;
        const maxPain = opt.maxPain ?? 0;
        const putCall = opt.putCallRatio ?? 0;
        const dvol = opt.dvol ?? 0;
        const skew = opt.skew25d ?? 0;
        const gex = opt.gex ?? 0;
        const gexLvl = opt.gexLevel ?? "neutral";

        return (
          <button
            key={coin}
            onClick={() => onSelectToken(coin)}
            className="flex items-center gap-2 flex-shrink-0 hover:bg-[var(--hl-surface-hover)] rounded px-1 py-0.5 transition-colors"
          >
            <span className="font-semibold text-[var(--foreground)]">{coin}</span>
            <span className="text-[var(--hl-muted)]">MP:</span>
            <span className="tabular-nums">${maxPain.toLocaleString()}</span>
            <span className={`tabular-nums ${putCall > 1 ? "text-[var(--hl-red)]" : "text-[var(--hl-green)]"}`}>
              P/C {putCall.toFixed(2)}
            </span>
            <span className="tabular-nums">IV {dvol.toFixed(0)}%</span>
            {skew !== 0 && (
              <span className={`tabular-nums ${skew > 5 ? "text-[var(--hl-red)]" : skew < -5 ? "text-[var(--hl-green)]" : ""}`}>
                Skew {skew > 0 ? "+" : ""}{skew.toFixed(1)}
              </span>
            )}
            {gex !== 0 && (
              <span className={`tabular-nums ${gexLvl === "dampening" ? "text-[var(--hl-green)]" : gexLvl === "amplifying" ? "text-[var(--hl-red)]" : ""}`}>
                GEX {gex > 0 ? "+" : ""}{gex}M
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
