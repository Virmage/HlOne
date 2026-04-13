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

  // Square conviction (weight 10)
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

  // Funding rate (weight 10)
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

  // Options put/call ratio (weight 15)
  if (options && options.putCallRatio > 0) {
    const w = 15;
    totalWeight += w;
    if (options.putCallRatio < 0.7) bullPoints += w * (1 - options.putCallRatio);
    else if (options.putCallRatio > 1.3) bearPoints += w * Math.min(1, (options.putCallRatio - 1) * 0.7);
  }

  if (totalWeight === 0) return { score: 50, direction: "neutral" };

  const bullNorm = (bullPoints / totalWeight) * 100;
  const bearNorm = (bearPoints / totalWeight) * 100;
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

  const scoreColor = score >= 60 ? "text-[var(--hl-green)]" : score <= 40 ? "text-[var(--hl-red)]" : "text-orange-400";
  const dirLabel = direction === "long" ? "BULL" : direction === "short" ? "BEAR" : "—";

  return (
    <>
      {/* Score column */}
      <div className="flex flex-col shrink-0">
        <span className="text-[8px] sm:text-[9px] text-[var(--hl-muted)] uppercase">Score</span>
        <span className={`tabular-nums font-medium ${scoreColor}`}>
          {score} {dirLabel}
        </span>
      </div>

      {/* Sharps column */}
      <div className="flex flex-col shrink-0">
        <span className="text-[8px] sm:text-[9px] text-[var(--hl-muted)] uppercase">Sharps</span>
        <span className={`font-medium ${flow ? (flow.sharpDirection === "long" ? "text-[var(--hl-green)]" : flow.sharpDirection === "short" ? "text-[var(--hl-red)]" : "text-[var(--hl-muted)]") : "text-[var(--hl-muted)]"}`}>
          {flow ? (flow.sharpDirection === "long" ? "Long" : flow.sharpDirection === "short" ? "Short" : "Flat") : "—"}
        </span>
      </div>

      {/* Squares column */}
      <div className="flex flex-col shrink-0">
        <span className="text-[8px] sm:text-[9px] text-[var(--hl-muted)] uppercase">Squares</span>
        <span className={`font-medium ${flow ? (flow.squareDirection === "long" ? "text-[var(--hl-green)]" : flow.squareDirection === "short" ? "text-[var(--hl-red)]" : "text-[var(--hl-muted)]") : "text-[var(--hl-muted)]"}`}>
          {flow ? (flow.squareDirection === "long" ? "Long" : flow.squareDirection === "short" ? "Short" : "Flat") : "—"}
        </span>
      </div>

      {/* Whales column */}
      <div className="flex flex-col shrink-0">
        <span className="text-[8px] sm:text-[9px] text-[var(--hl-muted)] uppercase">Whales</span>
        <span className={`font-medium ${accum ? (
          accum.trend === "accumulating" ? "text-[var(--hl-green)]" :
          accum.trend === "distributing" ? "text-[var(--hl-red)]" :
          "text-[var(--hl-muted)]"
        ) : "text-[var(--hl-muted)]"}`}>
          {accum ? (accum.trend === "accumulating" ? "Accum" : accum.trend === "distributing" ? "Dist" : "Flat") : "—"}
        </span>
      </div>

      {/* Divergence badge */}
      {flow?.divergence && (
        <div className="flex flex-col shrink-0">
          <span className="text-[8px] sm:text-[9px] text-[var(--hl-muted)] uppercase">Signal</span>
          <span className="text-yellow-400 font-medium">Diverge</span>
        </div>
      )}
    </>
  );
}
