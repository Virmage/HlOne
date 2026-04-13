"use client";

import type { KoreanPremium } from "@/lib/api";

interface Props {
  data: KoreanPremium | null;
}

export function KoreanPremiumPanel({ data }: Props) {
  if (!data) {
    return <p className="text-[11px] text-[var(--hl-muted)] px-1">Loading Korean premium...</p>;
  }

  const sentimentLabel = {
    extreme_fomo: "EXTREME FOMO",
    fomo: "FOMO",
    neutral: "NEUTRAL",
    fear: "FEAR",
    extreme_fear: "EXTREME FEAR",
  }[data.sentiment];

  const sentimentColor = {
    extreme_fomo: "text-[var(--hl-red)] bg-[var(--hl-red)]/15",
    fomo: "text-orange-400 bg-orange-400/15",
    neutral: "text-[var(--hl-muted)] bg-[var(--hl-surface)]",
    fear: "text-blue-400 bg-blue-400/15",
    extreme_fear: "text-[var(--hl-green)] bg-[var(--hl-green)]/15", // contrarian: extreme fear = buy
  }[data.sentiment];

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-[10px] font-medium text-[var(--hl-accent)] uppercase tracking-wider px-1">
          Korean Premium
        </h3>
        <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${sentimentColor}`}>
          {sentimentLabel}
        </span>
        <span className="text-[9px] text-[var(--hl-muted)] ml-auto">
          USD/KRW: {data.usdKrw.toFixed(0)}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 px-1">
        {data.btc && (
          <div className="rounded border border-[var(--hl-border)] p-2">
            <div className="text-[10px] text-[var(--hl-muted)] mb-0.5">BTC Premium</div>
            <div className={`text-[18px] font-bold tabular-nums ${
              data.btc.premiumPct > 2 ? "text-[var(--hl-red)]" :
              data.btc.premiumPct < -1 ? "text-[var(--hl-green)]" :
              "text-[var(--foreground)]"
            }`}>
              {data.btc.premiumPct > 0 ? "+" : ""}{data.btc.premiumPct.toFixed(2)}%
            </div>
            <div className="text-[9px] text-[var(--hl-muted)] mt-0.5">
              Upbit: ₩{data.btc.krwPrice.toLocaleString()} | Global: ${data.btc.globalUsd.toLocaleString()}
            </div>
          </div>
        )}
        {data.eth && (
          <div className="rounded border border-[var(--hl-border)] p-2">
            <div className="text-[10px] text-[var(--hl-muted)] mb-0.5">ETH Premium</div>
            <div className={`text-[18px] font-bold tabular-nums ${
              data.eth.premiumPct > 2 ? "text-[var(--hl-red)]" :
              data.eth.premiumPct < -1 ? "text-[var(--hl-green)]" :
              "text-[var(--foreground)]"
            }`}>
              {data.eth.premiumPct > 0 ? "+" : ""}{data.eth.premiumPct.toFixed(2)}%
            </div>
            <div className="text-[9px] text-[var(--hl-muted)] mt-0.5">
              Upbit: ₩{data.eth.krwPrice.toLocaleString()} | Global: ${data.eth.globalUsd.toLocaleString()}
            </div>
          </div>
        )}
      </div>

      <div className="mt-2 px-1 text-[9px] text-[var(--hl-muted)] leading-relaxed">
        Premium &gt;3% = Korean retail FOMO (contrarian sell signal). Negative = capitulation (contrarian buy).
      </div>
    </div>
  );
}
