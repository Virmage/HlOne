"use client";

import type { TradingSignal, FundingOpportunity, SharpSquareCallout } from "@/lib/api";

/** Strip dex prefix from coin names (e.g. "xyz:GOLD" → "GOLD") */
const displayCoin = (c: string) => c.includes(":") ? c.split(":")[1] : c;

interface SignalsPanelProps {
  signals: TradingSignal[];
  fundingOpps: FundingOpportunity[];
  callout: SharpSquareCallout | null;
  onSelectToken: (coin: string) => void;
}

export function SignalsPanel({ signals, fundingOpps, callout, onSelectToken }: SignalsPanelProps) {
  const hasContent = signals.length > 0 || fundingOpps.length > 0 || callout;
  if (!hasContent) return null;

  const calloutItems = callout ? [
    callout.sharpTopLong && { label: "Sharps", side: "LONG" as const, ...callout.sharpTopLong },
    callout.sharpTopShort && { label: "Sharps", side: "SHORT" as const, ...callout.sharpTopShort },
    callout.squareTopLong && { label: "Squares", side: "LONG" as const, ...callout.squareTopLong },
    callout.squareTopShort && { label: "Squares", side: "SHORT" as const, ...callout.squareTopShort },
  ].filter(Boolean) as { label: string; side: "LONG" | "SHORT"; coin: string; count: number; pct: number }[] : [];

  return (
    <div className="border-b border-[var(--hl-border)]">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-0 lg:gap-px bg-[var(--hl-border)]">
        {/* Sharps vs Squares */}
        <div className="bg-[var(--background)] p-2">
          <h3 className="text-[10px] font-medium text-[var(--hl-muted)] uppercase tracking-wider mb-1.5 px-1">
            Sharps vs Squares
          </h3>
          <div className="space-y-0.5">
            {calloutItems.length === 0 ? (
              <p className="text-[11px] text-[var(--hl-muted)] px-1">Loading...</p>
            ) : (
              calloutItems.map((item, i) => (
                <button
                  key={i}
                  onClick={() => onSelectToken(item.coin)}
                  className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-[var(--hl-surface-hover)] transition-colors text-[12px]"
                >
                  <span className="text-[var(--hl-muted)] text-[10px] w-14">{item.label}</span>
                  <span className={`font-bold w-4 ${item.side === "LONG" ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                    {item.side === "LONG" ? "L" : "S"}
                  </span>
                  <span className="font-medium text-[var(--foreground)]">{displayCoin(item.coin)}</span>
                  <span className="text-[var(--hl-muted)] tabular-nums ml-auto">{item.count} · {item.pct}%</span>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Funding Opportunities */}
        <div className="bg-[var(--background)] p-2">
          <h3 className="text-[10px] font-medium text-[var(--hl-muted)] uppercase tracking-wider mb-1.5 px-1">
            Funding Arbitrage
          </h3>
          <div className="space-y-0.5">
            {fundingOpps.length === 0 ? (
              <p className="text-[11px] text-[var(--hl-muted)] px-1">No opportunities</p>
            ) : (
              fundingOpps.map((f) => (
                <button
                  key={f.coin}
                  onClick={() => onSelectToken(f.coin)}
                  className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-[var(--hl-surface-hover)] transition-colors text-[12px]"
                >
                  <span className={`font-bold w-4 ${f.direction === "long" ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                    {f.direction === "long" ? "L" : "S"}
                  </span>
                  <span className="font-medium text-[var(--foreground)] w-16">{displayCoin(f.coin)}</span>
                  <span className={`tabular-nums font-semibold ${Math.abs(f.annualizedPct) > 100 ? "text-[var(--hl-green)]" : "text-[var(--foreground)]"}`}>
                    {Math.abs(f.annualizedPct).toFixed(0)}% APR
                  </span>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Trading Signals */}
        <div className="bg-[var(--background)] p-2">
          <h3 className="text-[10px] font-medium text-[var(--hl-muted)] uppercase tracking-wider mb-1.5 px-1">
            Signals
          </h3>
          <div className="space-y-0.5">
            {signals.length === 0 ? (
              <p className="text-[11px] text-[var(--hl-muted)] px-1">No active signals</p>
            ) : (
              signals.slice(0, 5).map((s, i) => (
                <button
                  key={i}
                  onClick={() => onSelectToken(s.coin)}
                  className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-[var(--hl-surface-hover)] transition-colors text-[12px]"
                >
                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                    s.severity === "critical" ? "bg-[var(--hl-red)] text-white" :
                    s.severity === "warning" ? "bg-yellow-600 text-white" :
                    "bg-[var(--hl-surface)] text-[var(--hl-muted)]"
                  }`}>
                    {s.severity === "critical" ? "!!" : s.severity === "warning" ? "!" : "~"}
                  </span>
                  <span className="font-medium text-[var(--foreground)] w-16">{displayCoin(s.coin)}</span>
                  <span className="text-[var(--foreground)] truncate">{s.title.replace(/^\w+:/, "")}</span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
