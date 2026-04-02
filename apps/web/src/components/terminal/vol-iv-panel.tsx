"use client";

import type { OptionsSnapshot, TokenOverview } from "@/lib/api";

interface VolIVPanelProps {
  options: Record<string, OptionsSnapshot>;
  tokens: TokenOverview[];
}

export function VolIVPanel({ options, tokens }: VolIVPanelProps) {
  const entries = Object.entries(options).filter(([, v]) => v.dvol > 0);

  if (!entries.length) {
    return (
      <div className="flex h-32 items-center justify-center text-[var(--hl-muted)] text-[12px]">
        No options data available (Deribit BTC/ETH only)
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-[13px] font-medium text-[var(--hl-muted)] uppercase tracking-wider mb-2 px-1">
        Volatility — IV vs Realized
      </h2>
      <div className="space-y-3 px-1">
        {entries.map(([coin, opts]) => {
          const token = tokens.find(t => t.coin === coin);
          // Estimate realized vol from 24h change (annualized)
          // RV ≈ |daily return| × √365 × 100
          const dailyReturn = token ? Math.abs(token.change24h / 100) : 0;
          const realizedVol = dailyReturn * Math.sqrt(365) * 100;
          const iv = opts.dvol;
          const ivPremium = iv - realizedVol;
          const ivPremiumPct = realizedVol > 0 ? ((iv / realizedVol - 1) * 100) : 0;

          return (
            <div key={coin} className="border border-[var(--hl-border)] rounded p-2">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[12px] font-medium text-[var(--foreground)]">{coin}</span>
                <span className="text-[10px] text-[var(--hl-muted)]">Deribit Options</span>
              </div>

              {/* IV vs RV bars */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="w-20 text-[var(--hl-muted)]">Implied Vol</span>
                  <div className="flex-1 h-3 bg-[var(--hl-surface)] rounded overflow-hidden">
                    <div
                      className="h-full bg-[var(--hl-green)] rounded"
                      style={{ width: `${Math.min(iv / 1.5, 100)}%` }}
                    />
                  </div>
                  <span className="w-12 text-right tabular-nums text-[var(--foreground)] font-medium">
                    {iv.toFixed(0)}%
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="w-20 text-[var(--hl-muted)]">Realized Vol</span>
                  <div className="flex-1 h-3 bg-[var(--hl-surface)] rounded overflow-hidden">
                    <div
                      className="h-full bg-[var(--hl-muted)] rounded"
                      style={{ width: `${Math.min(realizedVol / 1.5, 100)}%` }}
                    />
                  </div>
                  <span className="w-12 text-right tabular-nums text-[var(--foreground)]">
                    {realizedVol.toFixed(0)}%
                  </span>
                </div>
              </div>

              {/* Stats row */}
              <div className="flex items-center justify-between mt-2 text-[10px]">
                <span className={ivPremium > 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}>
                  IV Premium: {ivPremium > 0 ? "+" : ""}{ivPremium.toFixed(1)}% ({ivPremiumPct > 0 ? "+" : ""}{ivPremiumPct.toFixed(0)}%)
                </span>
                <span className="text-[var(--hl-muted)]">
                  P/C: {opts.putCallRatio.toFixed(2)}
                </span>
                <span className="text-[var(--hl-muted)]">
                  25δ Skew: {opts.skew25d > 0 ? "+" : ""}{opts.skew25d.toFixed(1)}
                </span>
                <span className="text-[var(--hl-muted)]">
                  IV Rank: {opts.ivRank.toFixed(0)}%
                </span>
              </div>

              {/* GEX indicator */}
              <div className="flex items-center gap-2 mt-1.5 text-[10px]">
                <span className="text-[var(--hl-muted)]">GEX:</span>
                <span className={
                  opts.gexLevel === "dampening" ? "text-[var(--hl-green)]" :
                  opts.gexLevel === "amplifying" ? "text-[var(--hl-red)]" :
                  "text-[var(--hl-muted)]"
                }>
                  {(opts.gex / 1e6).toFixed(1)}M ({opts.gexLevel})
                </span>
                <span className="text-[var(--hl-muted)]">|</span>
                <span className="text-[var(--hl-muted)]">
                  Max Pain: ${opts.maxPain.toLocaleString()} ({opts.maxPainDistance > 0 ? "+" : ""}{opts.maxPainDistance.toFixed(1)}%)
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
