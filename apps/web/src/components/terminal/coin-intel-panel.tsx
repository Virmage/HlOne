"use client";

import type { TokenDetail } from "@/lib/api";

interface Props {
  detail: TokenDetail | null;
  coin: string;
}

/** Compute a 0-100 combined score from all available coin data */
function computeScore(detail: TokenDetail): { score: number; direction: "long" | "short" | "neutral" } {
  let bullPoints = 0;
  let bearPoints = 0;
  let totalWeight = 0;

  const flow = detail.coinFlow;
  const accum = detail.coinAccumulation;
  const overview = detail.overview;
  const options = detail.options;
  const book = detail.bookAnalysis;

  // Sharp conviction (weight 30)
  if (flow) {
    const w = 30;
    totalWeight += w;
    if (flow.sharpDirection === "long") bullPoints += w * (flow.sharpStrength / 100);
    else if (flow.sharpDirection === "short") bearPoints += w * (flow.sharpStrength / 100);
  }

  // Square conviction (weight 10 — less trusted)
  if (flow) {
    const w = 10;
    totalWeight += w;
    if (flow.squareDirection === "long") bullPoints += w * (flow.squareStrength / 100);
    else if (flow.squareDirection === "short") bearPoints += w * (flow.squareStrength / 100);
  }

  // Whale accumulation (weight 25)
  if (accum) {
    const w = 25;
    totalWeight += w;
    if (accum.trend === "accumulating") bullPoints += w * 0.8;
    else if (accum.trend === "distributing") bearPoints += w * 0.8;
  }

  // Funding rate (weight 10) — negative funding = longs pay less = bullish setup
  if (overview) {
    const w = 10;
    totalWeight += w;
    const rate = overview.fundingRate;
    if (rate < -0.0001) bullPoints += w * Math.min(1, Math.abs(rate) * 5000);
    else if (rate > 0.0001) bearPoints += w * Math.min(1, rate * 5000);
  }

  // Book imbalance (weight 10)
  if (book && book.imbalance !== 0) {
    const w = 10;
    totalWeight += w;
    if (book.imbalance > 0.1) bullPoints += w * Math.min(1, book.imbalance);
    else if (book.imbalance < -0.1) bearPoints += w * Math.min(1, Math.abs(book.imbalance));
  }

  // Options put/call ratio (weight 15) — low P/C = bullish
  if (options && options.putCallRatio > 0) {
    const w = 15;
    totalWeight += w;
    if (options.putCallRatio < 0.7) bullPoints += w * (1 - options.putCallRatio);
    else if (options.putCallRatio > 1.3) bearPoints += w * Math.min(1, (options.putCallRatio - 1) * 0.7);
  }

  if (totalWeight === 0) return { score: 50, direction: "neutral" };

  const bullNorm = (bullPoints / totalWeight) * 100;
  const bearNorm = (bearPoints / totalWeight) * 100;

  // Score: 50 = neutral, >50 = bullish, <50 = bearish
  const raw = 50 + (bullNorm - bearNorm) / 2;
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const direction = score >= 55 ? "long" : score <= 45 ? "short" : "neutral";

  return { score, direction };
}

export function CoinIntelPanel({ detail }: Props) {
  if (!detail) return null;

  const flow = detail.coinFlow;
  const accum = detail.coinAccumulation;
  const { score, direction } = computeScore(detail);

  const hasData = flow || accum;
  if (!hasData) return null;

  const scoreColor = score >= 60 ? "text-[var(--hl-green)]" : score <= 40 ? "text-[var(--hl-red)]" : "text-orange-400";
  const dirLabel = direction === "long" ? "BULL" : direction === "short" ? "BEAR" : "NEUTRAL";
  const dirColor = direction === "long" ? "text-[var(--hl-green)]" : direction === "short" ? "text-[var(--hl-red)]" : "text-[var(--hl-muted)]";

  return (
    <div className="flex items-center gap-2.5 text-[11px]">
      {/* Overall Score */}
      <div className="flex items-center gap-1">
        <span className="text-[9px] text-[var(--hl-muted)] uppercase font-medium">Score</span>
        <span className={`font-bold tabular-nums ${scoreColor}`}>{score}</span>
        <span className={`font-bold ${dirColor}`}>{dirLabel}</span>
      </div>

      <span className="text-[var(--hl-border)]">|</span>

      {/* Sharp direction — simplified */}
      {flow && (
        <div className="flex items-center gap-1">
          <span className="text-[9px] text-[var(--hl-muted)] uppercase">Sharps</span>
          <span className={`font-bold ${flow.sharpDirection === "long" ? "text-[var(--hl-green)]" : flow.sharpDirection === "short" ? "text-[var(--hl-red)]" : "text-[var(--hl-muted)]"}`}>
            {flow.sharpDirection === "long" ? "LONG" : flow.sharpDirection === "short" ? "SHORT" : "FLAT"}
          </span>
        </div>
      )}

      {/* Square direction — simplified */}
      {flow && (
        <div className="flex items-center gap-1">
          <span className="text-[9px] text-[var(--hl-muted)] uppercase">Squares</span>
          <span className={`font-bold ${flow.squareDirection === "long" ? "text-[var(--hl-green)]" : flow.squareDirection === "short" ? "text-[var(--hl-red)]" : "text-[var(--hl-muted)]"}`}>
            {flow.squareDirection === "long" ? "LONG" : flow.squareDirection === "short" ? "SHORT" : "FLAT"}
          </span>
        </div>
      )}

      {/* Divergence badge */}
      {flow?.divergence && (
        <span className="text-[9px] px-1 py-0.5 rounded bg-yellow-500/15 text-yellow-400 font-medium">
          DIV
        </span>
      )}

      {/* Whale trend */}
      {accum && (
        <div className="flex items-center gap-1">
          <span className="text-[9px] text-[var(--hl-muted)] uppercase">Whales</span>
          <span className={`font-bold ${
            accum.trend === "accumulating" ? "text-[var(--hl-green)]" :
            accum.trend === "distributing" ? "text-[var(--hl-red)]" :
            "text-[var(--hl-muted)]"
          }`}>
            {accum.trend === "accumulating" ? "ACCUM" : accum.trend === "distributing" ? "DIST" : "FLAT"}
          </span>
        </div>
      )}
    </div>
  );
}
