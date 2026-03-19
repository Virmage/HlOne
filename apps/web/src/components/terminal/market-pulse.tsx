"use client";

import type { TradingSignal, FundingOpportunity, MarketRegime, OptionsSnapshot } from "@/lib/api";

interface MarketPulseProps {
  signals: TradingSignal[];
  fundingOpps: FundingOpportunity[];
  regime: MarketRegime | null;
  options: Record<string, OptionsSnapshot>;
  onSelectToken: (coin: string) => void;
}

const REGIME_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  risk_on: { bg: "bg-[#5dea8d15]", text: "text-[var(--hl-green)]", label: "RISK ON" },
  risk_off: { bg: "bg-[#f0585815]", text: "text-[var(--hl-red)]", label: "RISK OFF" },
  neutral: { bg: "bg-[var(--hl-surface)]", text: "text-[var(--hl-muted)]", label: "NEUTRAL" },
  divergent: { bg: "bg-[#f5a62315]", text: "text-yellow-400", label: "DIVERGENT" },
};

const SEVERITY_STYLES: Record<string, string> = {
  critical: "border-[var(--hl-red)] bg-[#f0585808]",
  warning: "border-yellow-600/30 bg-[#f5a62308]",
  info: "border-[var(--hl-border)]",
};

export function MarketPulse({ signals, fundingOpps, regime, options, onSelectToken }: MarketPulseProps) {
  const regimeStyle = regime ? REGIME_STYLES[regime.regime] || REGIME_STYLES.neutral : REGIME_STYLES.neutral;

  return (
    <div className="p-3">
      <h2 className="text-[13px] font-medium text-[var(--hl-muted)] uppercase tracking-wider mb-3">
        Market Pulse
      </h2>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Market Regime */}
        <div className={`rounded-md border border-[var(--hl-border)] ${regimeStyle.bg} p-2.5`}>
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-[12px] font-bold ${regimeStyle.text}`}>{regimeStyle.label}</span>
            {regime && (
              <span className="text-[11px] text-[var(--hl-muted)]">
                {regime.avgChange24h >= 0 ? "+" : ""}{regime.avgChange24h.toFixed(1)}% avg
              </span>
            )}
          </div>
          <p className="text-[10px] text-[var(--hl-text)]">
            {regime?.description || "Loading..."}
          </p>
        </div>

        {/* Options (BTC/ETH) */}
        <div className="rounded-md border border-[var(--hl-border)] bg-[var(--hl-surface)] p-2.5">
          <p className="text-[10px] uppercase tracking-wider text-[var(--hl-muted)] mb-1.5">Options</p>
          <div className="space-y-1">
            {["BTC", "ETH"].map((coin) => {
              const opt = options[coin];
              if (!opt) return null;
              return (
                <button
                  key={coin}
                  onClick={() => onSelectToken(coin)}
                  className="w-full flex items-center gap-3 text-[11px] hover:bg-[var(--hl-surface-hover)] rounded px-1 py-0.5 transition-colors"
                >
                  <span className="font-medium text-[var(--foreground)] w-6">{coin}</span>
                  <span className="text-[var(--hl-muted)]">MP:</span>
                  <span className="text-[var(--foreground)] tabular-nums">${opt.maxPain.toLocaleString()}</span>
                  <span className="text-[var(--hl-muted)]">P/C:</span>
                  <span className={`tabular-nums ${opt.putCallRatio > 1 ? "text-[var(--hl-red)]" : "text-[var(--hl-green)]"}`}>
                    {opt.putCallRatio.toFixed(2)}
                  </span>
                  <span className="text-[var(--hl-muted)]">IV:</span>
                  <span className="text-[var(--foreground)] tabular-nums">{opt.dvol.toFixed(0)}%</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Funding Opportunities */}
        <div className="rounded-md border border-[var(--hl-border)] bg-[var(--hl-surface)] p-2.5">
          <p className="text-[10px] uppercase tracking-wider text-[var(--hl-muted)] mb-1.5">Funding Arb</p>
          {fundingOpps.length === 0 ? (
            <p className="text-[10px] text-[var(--hl-muted)]">No opportunities &gt;5% APR</p>
          ) : (
            <div className="space-y-1">
              {fundingOpps.slice(0, 3).map((f) => (
                <button
                  key={f.coin}
                  onClick={() => onSelectToken(f.coin)}
                  className="w-full flex items-center gap-2 text-[11px] hover:bg-[var(--hl-surface-hover)] rounded px-1 py-0.5 transition-colors"
                >
                  <span className={`font-bold ${f.direction === "long" ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                    {f.direction === "long" ? "LONG" : "SHORT"}
                  </span>
                  <span className="font-medium text-[var(--foreground)]">{f.coin}</span>
                  <span className="text-[var(--hl-green)] tabular-nums ml-auto">
                    {Math.abs(f.annualizedPct).toFixed(0)}% APR
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Alerts / Signals */}
      {signals.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {signals.slice(0, 5).map((s, i) => (
            <button
              key={i}
              onClick={() => onSelectToken(s.coin)}
              className={`w-full text-left flex items-center gap-2 rounded-md border px-3 py-1.5 text-[11px] hover:brightness-110 transition ${SEVERITY_STYLES[s.severity] || ""}`}
            >
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                s.severity === "critical" ? "bg-[var(--hl-red)] text-white" :
                s.severity === "warning" ? "bg-yellow-600 text-white" :
                "bg-[var(--hl-muted)] text-[var(--background)]"
              }`}>
                {s.severity === "critical" ? "!" : s.severity === "warning" ? "~" : "i"}
              </span>
              <span className="text-[var(--foreground)] font-medium">{s.title}</span>
              <span className="text-[var(--hl-muted)] ml-auto hidden sm:inline">{s.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
