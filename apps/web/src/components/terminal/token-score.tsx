"use client";

import type { CpycatScore } from "@/lib/api";

interface TokenScoreCardProps {
  score: CpycatScore;
}

const SIGNAL_LABELS: Record<string, { label: string; color: string }> = {
  strong_buy: { label: "STRONG BUY", color: "text-[var(--hl-green)]" },
  buy: { label: "BUY", color: "text-[var(--hl-green)]" },
  neutral: { label: "NEUTRAL", color: "text-[var(--hl-muted)]" },
  sell: { label: "SELL", color: "text-[var(--hl-red)]" },
  strong_sell: { label: "STRONG SELL", color: "text-[var(--hl-red)]" },
};

export function TokenScoreCard({ score }: TokenScoreCardProps) {
  const sig = SIGNAL_LABELS[score.signal] || SIGNAL_LABELS.neutral;

  // Score bar color
  let barColor = "bg-[var(--hl-muted)]";
  if (score.score >= 70) barColor = "bg-[var(--hl-green)]";
  else if (score.score >= 55) barColor = "bg-[#5dea8d80]";
  else if (score.score <= 30) barColor = "bg-[var(--hl-red)]";
  else if (score.score <= 45) barColor = "bg-[#f0585880]";

  return (
    <div className="rounded-md border border-[var(--hl-border)] bg-[var(--hl-surface)] p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-medium text-[var(--hl-muted)] uppercase tracking-wider">HLOne Score</span>
        <div className="flex items-center gap-2">
          <span className={`text-[16px] font-bold tabular-nums ${sig.color}`}>{score.score}</span>
          <span className={`text-[11px] font-medium ${sig.color}`}>{sig.label}</span>
        </div>
      </div>

      {/* Score bar */}
      <div className="h-2 rounded-full bg-[var(--hl-border)] overflow-hidden mb-3">
        <div className={`h-full rounded-full ${barColor} transition-all`} style={{ width: `${score.score}%` }} />
      </div>

      {/* Breakdown */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
        <BreakdownRow label="Sharp Conviction" value={score.breakdown.sharpConviction} />
        <BreakdownRow label="Whale Accumulation" value={score.breakdown.whaleAccumulation} />
        <BreakdownRow label="Price Trend" value={score.breakdown.priceTrend} />
        <BreakdownRow label="Funding Regime" value={score.breakdown.fundingRegime} />
      </div>

      {/* Sharp info */}
      <div className="flex items-center gap-3 mt-2 pt-2 border-t border-[var(--hl-border)] text-[11px]">
        <span className="text-[var(--hl-muted)]">{score.sharpCount} sharps positioned</span>
        {score.sharpDirection !== "neutral" && (
          <span className={score.sharpDirection === "long" ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}>
            Net {score.sharpDirection.toUpperCase()}
          </span>
        )}
        {score.divergence && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#f058581a] text-[var(--hl-red)] font-medium">
            DIVERGENCE
          </span>
        )}
      </div>
    </div>
  );
}

function BreakdownRow({ label, value }: { label: string; value: number }) {
  let color = "text-[var(--hl-muted)]";
  if (value >= 65) color = "text-[var(--hl-green)]";
  else if (value <= 35) color = "text-[var(--hl-red)]";
  else color = "text-[var(--hl-text)]";

  return (
    <div className="flex items-center justify-between">
      <span className="text-[var(--hl-muted)]">{label}</span>
      <div className="flex items-center gap-1">
        <div className="w-12 h-1 rounded-full bg-[var(--hl-border)] overflow-hidden">
          <div
            className={`h-full rounded-full ${value >= 50 ? "bg-[var(--hl-green)]" : "bg-[var(--hl-red)]"}`}
            style={{ width: `${value}%` }}
          />
        </div>
        <span className={`tabular-nums ${color}`}>{value}</span>
      </div>
    </div>
  );
}
