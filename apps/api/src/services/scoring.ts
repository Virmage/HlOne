/**
 * CPYCAT Score — composite signal per token (0-100).
 * Combines: sharp conviction, whale accumulation, price trend, funding regime.
 * Social layer added in Sprint 4.
 */

import { getSmartMoneyData } from "./smart-money.js";
import { getTokenOverviews, type TokenOverview } from "./market-data.js";
import { getWhaleAlerts } from "./whale-tracker.js";
import { getFundingHistory } from "./hyperliquid.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CpycatScore {
  coin: string;
  score: number; // 0-100
  signal: "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell";
  breakdown: {
    sharpConviction: number;  // 0-100
    whaleAccumulation: number; // 0-100
    priceTrend: number;       // 0-100
    fundingRegime: number;    // 0-100
    socialMomentum: number;   // 0-100 (placeholder until social integration)
  };
  sharpDirection: "long" | "short" | "neutral";
  sharpCount: number;
  divergence: boolean;
}

// ─── Cache ───────────────────────────────────────────────────────────────────

let scoreCache: { scores: Map<string, CpycatScore>; fetchedAt: number } | null = null;
const SCORE_TTL = 5 * 60_000; // 5 minutes

// ─── Score computation ───────────────────────────────────────────────────────

function computeSharpConviction(
  sharpLongCount: number,
  sharpShortCount: number,
): { score: number; direction: "long" | "short" | "neutral" } {
  const total = sharpLongCount + sharpShortCount;
  if (total < 2) return { score: 0, direction: "neutral" };

  const longPct = sharpLongCount / total;
  // Score based on both count and agreement
  const agreement = Math.max(longPct, 1 - longPct); // 0.5-1.0
  const countBonus = Math.min(total / 20, 1); // more traders = more conviction, caps at 20
  const score = Math.round(((agreement - 0.5) * 2) * 80 * countBonus + 20 * countBonus);

  return {
    score: Math.min(100, Math.max(0, score)),
    direction: longPct > 0.6 ? "long" : longPct < 0.4 ? "short" : "neutral",
  };
}

function computeWhaleAccumulation(coin: string): number {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recentAlerts = getWhaleAlerts(100).filter(
    e => e.coin === coin && e.detectedAt > oneHourAgo
  );

  if (recentAlerts.length === 0) return 50; // neutral

  let netFlow = 0;
  for (const alert of recentAlerts) {
    if (alert.eventType === "open_long" || alert.eventType === "added") {
      netFlow += alert.positionValueUsd;
    } else if (alert.eventType === "open_short") {
      netFlow -= alert.positionValueUsd;
    } else if (alert.eventType === "close_long" || alert.eventType === "trimmed") {
      netFlow -= alert.positionValueUsd;
    } else if (alert.eventType === "close_short") {
      netFlow += alert.positionValueUsd;
    }
  }

  // Normalize: $1M+ flow = 100, -$1M = 0
  const normalized = (netFlow / 1_000_000) * 50 + 50;
  return Math.min(100, Math.max(0, Math.round(normalized)));
}

function computePriceTrend(overview: TokenOverview): number {
  // Simple: 24h change mapped to 0-100
  // -10% or worse = 0, +10% or better = 100
  const clamped = Math.max(-10, Math.min(10, overview.change24h));
  return Math.round((clamped + 10) * 5);
}

function computeFundingRegime(fundingRate: number): number {
  // Extreme positive funding = contrarian short signal (low score)
  // Extreme negative funding = contrarian long signal (high score for contrarians)
  // Near zero = neutral
  // For CPYCAT, we interpret: negative funding = bullish (shorts paying longs)
  const annualized = fundingRate * 24 * 365 * 100;
  if (annualized < -20) return 90; // very negative funding = bullish
  if (annualized < -5) return 70;
  if (annualized > 20) return 10; // very positive funding = bearish (crowded long)
  if (annualized > 5) return 30;
  return 50; // neutral
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function getTokenScores(): Promise<Map<string, CpycatScore>> {
  if (scoreCache && Date.now() - scoreCache.fetchedAt < SCORE_TTL) {
    return scoreCache.scores;
  }

  const [smartMoney, overviews] = await Promise.all([
    getSmartMoneyData(),
    getTokenOverviews(),
  ]);

  const overviewMap = new Map(overviews.map(o => [o.coin, o]));
  const scores = new Map<string, CpycatScore>();

  for (const flow of smartMoney.flow) {
    const overview = overviewMap.get(flow.coin);
    if (!overview) continue;

    const sharp = computeSharpConviction(flow.sharpLongCount, flow.sharpShortCount);
    const whale = computeWhaleAccumulation(flow.coin);
    const trend = computePriceTrend(overview);
    const funding = computeFundingRegime(overview.fundingRate);
    const social = 50; // placeholder — Sprint 4

    // Weighted composite
    const score = Math.round(
      sharp.score * 0.30 +
      whale * 0.25 +
      trend * 0.20 +
      funding * 0.15 +
      social * 0.10
    );

    let signal: CpycatScore["signal"] = "neutral";
    if (score >= 75) signal = "strong_buy";
    else if (score >= 60) signal = "buy";
    else if (score <= 25) signal = "strong_sell";
    else if (score <= 40) signal = "sell";

    scores.set(flow.coin, {
      coin: flow.coin,
      score,
      signal,
      breakdown: {
        sharpConviction: sharp.score,
        whaleAccumulation: whale,
        priceTrend: trend,
        fundingRegime: funding,
        socialMomentum: social,
      },
      sharpDirection: sharp.direction,
      sharpCount: flow.sharpLongCount + flow.sharpShortCount,
      divergence: flow.divergence,
    });
  }

  scoreCache = { scores, fetchedAt: Date.now() };
  return scores;
}

/** Return cached scores immediately, or empty map. Never triggers a fetch. */
export function getTokenScoresCached(): Map<string, CpycatScore> {
  return scoreCache?.scores || new Map();
}

export async function getTokenScore(coin: string): Promise<CpycatScore | null> {
  const scores = await getTokenScores();
  return scores.get(coin) || null;
}
