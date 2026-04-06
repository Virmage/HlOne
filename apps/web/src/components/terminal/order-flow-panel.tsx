"use client";

import type { OrderFlowCoin } from "@/lib/api";

interface OrderFlowPanelProps {
  data: OrderFlowCoin[];
  onSelectToken: (coin: string) => void;
}

function formatVol(value: number): string {
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function ImbalanceBar({ value }: { value: number }) {
  // value is -1 to +1
  const pct = Math.abs(value) * 50; // max 50% width
  const isPositive = value >= 0;

  return (
    <div className="relative w-full h-3 flex items-center">
      {/* Center line */}
      <div className="absolute left-1/2 top-0 bottom-0 w-px bg-[var(--hl-border)]" />
      {/* Bar */}
      <div
        className="absolute top-0.5 bottom-0.5 rounded-sm"
        style={{
          backgroundColor: isPositive ? "var(--hl-green)" : "var(--hl-red)",
          opacity: 0.6,
          width: `${Math.max(pct, 1)}%`,
          left: isPositive ? "50%" : `${50 - pct}%`,
        }}
      />
      {/* Value label */}
      <span className={`relative z-10 text-[9px] tabular-nums w-full text-center ${
        isPositive ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"
      }`}>
        {value > 0 ? "+" : ""}{(value * 100).toFixed(0)}%
      </span>
    </div>
  );
}

export function OrderFlowPanel({ data, onSelectToken }: OrderFlowPanelProps) {
  if (!data.length) {
    return (
      <div className="flex h-32 items-center justify-center text-[var(--hl-muted)] text-[12px]">
        Loading order flow...
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-[13px] font-medium text-[var(--hl-muted)] uppercase tracking-wider mb-2 px-1">
        Order Flow Imbalance
      </h2>
      <div className="space-y-0">
        {/* Header */}
        <div className="flex items-center px-2 py-1 text-[10px] text-[var(--hl-muted)] uppercase tracking-wider border-b border-[var(--hl-border)]">
          <span className="w-12">Token</span>
          <span className="w-16 text-center">1m</span>
          <span className="w-16 text-center">5m</span>
          <span className="w-16 text-center">15m</span>
          <span className="flex-1 text-right">Net 5m</span>
        </div>
        <div className="overflow-y-auto scroll-on-hover max-h-[220px]">
          {data.map((coin) => {
            const w1m = coin.windows.find(w => w.interval === "1m");
            const w5m = coin.windows.find(w => w.interval === "5m");
            const w15m = coin.windows.find(w => w.interval === "15m");

            return (
              <div
                key={coin.coin}
                className="flex items-center px-2 py-1 text-[11px] border-b border-[var(--hl-border)] hover:bg-[var(--hl-surface-hover)] cursor-pointer transition-colors"
                onClick={() => onSelectToken(coin.coin)}
              >
                <span className="font-medium text-[var(--foreground)] w-12">{coin.coin}</span>
                <div className="w-16">
                  <ImbalanceBar value={w1m?.imbalance ?? 0} />
                </div>
                <div className="w-16">
                  <ImbalanceBar value={w5m?.imbalance ?? 0} />
                </div>
                <div className="w-16">
                  <ImbalanceBar value={w15m?.imbalance ?? 0} />
                </div>
                <span className={`flex-1 text-right tabular-nums text-[10px] ${
                  (w5m?.netFlow ?? 0) >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"
                }`}>
                  {(w5m?.netFlow ?? 0) >= 0 ? "+" : ""}{formatVol(w5m?.netFlow ?? 0)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
