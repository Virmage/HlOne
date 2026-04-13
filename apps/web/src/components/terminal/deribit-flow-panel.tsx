"use client";

import type { OptionsFlowSummary } from "@/lib/api";

function formatUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function formatNum(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(1);
}

interface Props {
  btc: OptionsFlowSummary | null;
  eth: OptionsFlowSummary | null;
}

function CurrencyBlock({ label, data }: { label: string; data: OptionsFlowSummary }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] font-medium text-[var(--hl-accent)] uppercase tracking-wider">{label}</span>
        <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
          data.sentiment === "bullish" ? "bg-[var(--hl-green)]/15 text-[var(--hl-green)]" :
          data.sentiment === "bearish" ? "bg-[var(--hl-red)]/15 text-[var(--hl-red)]" :
          "bg-[var(--hl-surface)] text-[var(--hl-muted)]"
        }`}>
          {data.sentiment.toUpperCase()}
        </span>
        <span className="text-[10px] text-[var(--hl-muted)] ml-auto">
          P/C: <span className={`font-medium ${data.putCallRatio > 1.2 ? "text-[var(--hl-red)]" : data.putCallRatio < 0.8 ? "text-[var(--hl-green)]" : "text-[var(--foreground)]"}`}>
            {data.putCallRatio.toFixed(2)}
          </span>
        </span>
      </div>

      {/* Summary stats */}
      <div className="flex gap-3 text-[10px] mb-2">
        <span className="text-[var(--hl-muted)]">
          Call flow: <span className="text-[var(--hl-green)] font-medium">{formatUsd(data.netCallPremiumUsd)}</span>
        </span>
        <span className="text-[var(--hl-muted)]">
          Put flow: <span className="text-[var(--hl-red)] font-medium">{formatUsd(data.netPutPremiumUsd)}</span>
        </span>
        <span className="text-[var(--hl-muted)]">
          Total: <span className="text-[var(--foreground)] font-medium">{formatUsd(data.totalNotionalUsd)}</span>
        </span>
      </div>

      {/* Recent large trades */}
      {data.recentTrades.length > 0 && (
        <div className="space-y-0.5">
          {data.recentTrades.slice(0, 6).map((t, i) => (
            <div key={i} className="flex items-center gap-1.5 text-[10px] px-1 py-0.5 rounded hover:bg-[var(--hl-surface-hover)]">
              <span className={`font-bold w-3 ${t.type === "call" ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                {t.type === "call" ? "C" : "P"}
              </span>
              <span className={`w-3 ${t.direction === "buy" ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                {t.direction === "buy" ? "B" : "S"}
              </span>
              <span className="text-[var(--foreground)] font-medium w-14">{formatNum(t.strike)}</span>
              <span className="text-[var(--hl-muted)] w-16">{t.expiry}</span>
              <span className="text-[var(--foreground)] tabular-nums font-medium">{formatUsd(t.notionalUsd)}</span>
              <span className="text-[var(--hl-muted)] ml-auto tabular-nums">IV {t.iv.toFixed(0)}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function DeribitFlowPanel({ btc, eth }: Props) {
  if (!btc && !eth) {
    return (
      <div className="flex h-32 items-center justify-center text-[var(--hl-muted)] text-[11px]">
        Loading options flow...
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-[13px] font-medium text-[var(--hl-accent)] uppercase tracking-wider mb-2 px-1">
        Deribit Options Flow
      </h2>
      <div className="space-y-3">
        {btc && <CurrencyBlock label="BTC Options" data={btc} />}
        {eth && <CurrencyBlock label="ETH Options" data={eth} />}
      </div>
    </div>
  );
}
