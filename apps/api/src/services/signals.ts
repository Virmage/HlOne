/**
 * Trading signals — unusual volume, funding arb, liquidation zones,
 * money flow, position crowding, cross-asset regime.
 * All computed from existing HL API data.
 */

import { getCachedAssetCtxs, getTokenOverviews, type TokenOverview } from "./market-data.js";
import { getCandleSnapshot, getRecentTrades } from "./hyperliquid.js";
import { getSmartMoneyCached } from "./smart-money.js";
import { getWhaleAlerts } from "./whale-tracker.js";

/** Strip dex prefix for display (e.g. "xyz:GOLD" → "GOLD") */
const displayCoin = (c: string) => c.includes(":") ? c.split(":")[1] : c;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Signal {
  type: string;
  coin: string;
  severity: "info" | "warning" | "critical";
  title: string;
  description: string;
  value: number;
  timestamp: number;
}

export interface FundingOpportunity {
  coin: string;
  fundingRate: number;
  annualizedPct: number;
  direction: "long" | "short"; // direction that RECEIVES funding
  description: string;
}

export interface LiquidationZone {
  coin: string;
  price: number;
  side: "long" | "short"; // side that gets liquidated
  totalValue: number;
  traderCount: number;
  distanceFromCurrent: number; // percentage
}

export type RegimeType = "risk_on" | "risk_off" | "chop" | "rotation" | "squeeze" | "capitulation";

export interface MarketRegime {
  regime: RegimeType;
  action: string;       // what to do: "Buy dips, hold longs" etc
  description: string;  // why: "BTC flat, 8 alts breaking out on volume"
  confidence: number;   // 0-100 how many signals agree
  bullishCount: number;
  bearishCount: number;
  avgChange24h: number;
}

export interface SharpSquareCallout {
  sharpTopLong: { coin: string; count: number; pct: number } | null;
  sharpTopShort: { coin: string; count: number; pct: number } | null;
  squareTopLong: { coin: string; count: number; pct: number } | null;
  squareTopShort: { coin: string; count: number; pct: number } | null;
  sharpLongs: { coin: string; count: number; strength: number }[];
  sharpShorts: { coin: string; count: number; strength: number }[];
  squareLongs: { coin: string; count: number; strength: number }[];
  squareShorts: { coin: string; count: number; strength: number }[];
}

// ─── Cache ───────────────────────────────────────────────────────────────────

interface SignalsCache {
  signals: Signal[];
  fundingOpps: FundingOpportunity[];
  regime: MarketRegime;
  callout: SharpSquareCallout;
  fetchedAt: number;
}

let cache: SignalsCache | null = null;
const CACHE_TTL = 60_000; // 60s

// ─── Signal Generators ───────────────────────────────────────────────────────

function computeFundingOpportunities(overviews: TokenOverview[]): FundingOpportunity[] {
  const opps: FundingOpportunity[] = [];

  for (const t of overviews) {
    const annualized = t.fundingRate * 24 * 365 * 100;
    if (Math.abs(annualized) < 5) continue; // Only interesting if >5% APR

    opps.push({
      coin: t.coin,
      fundingRate: t.fundingRate,
      annualizedPct: annualized,
      direction: annualized > 0 ? "short" : "long", // positive funding = shorts receive
      description: annualized > 0
        ? `Short ${t.coin} earns ${annualized.toFixed(1)}% APR from longs`
        : `Long ${t.coin} earns ${Math.abs(annualized).toFixed(1)}% APR from shorts`,
    });
  }

  opps.sort((a, b) => Math.abs(b.annualizedPct) - Math.abs(a.annualizedPct));
  return opps;
}

// ─── Regime persistence (debounce) ──────────────────────────────────────────

let lastRegime: { regime: RegimeType; since: number } | null = null;
const REGIME_MIN_HOLD_MS = 5 * 60_000; // hold regime for at least 5 minutes

const REGIME_CONFIG: Record<RegimeType, { label: string; action: string; color: string }> = {
  risk_on:      { label: "RISK ON",      action: "Buy dips, ride longs, chase breakouts",           color: "green" },
  risk_off:     { label: "RISK OFF",     action: "Short rallies, reduce size, move to stables",     color: "red" },
  chop:         { label: "CHOP",         action: "Fade extremes, tight stops, reduce size",         color: "orange" },
  rotation:     { label: "ROTATION",     action: "Scan alts, follow volume, sector plays",          color: "blue" },
  squeeze:      { label: "SQUEEZE",      action: "Vol compressed — set alerts, prepare for move",   color: "purple" },
  capitulation: { label: "CAPITULATION", action: "Liquidation cascade — watch for reversal entries", color: "yellow" },
};

function computeMarketRegime(overviews: TokenOverview[]): MarketRegime {
  const top = overviews.slice(0, 20); // top 20 by volume
  if (top.length === 0) {
    return { regime: "chop", action: REGIME_CONFIG.chop.action, description: "No data", confidence: 0, bullishCount: 0, bearishCount: 0, avgChange24h: 0 };
  }

  // ── 1. Breadth: volume-weighted advance/decline ───────────────────────────
  let bullish = 0, bearish = 0, flat = 0;
  let volWeightedChange = 0;
  let totalVol = 0;
  const changes: number[] = [];

  for (const t of top) {
    if (t.change24h > 1) bullish++;
    else if (t.change24h < -1) bearish++;
    else flat++;
    volWeightedChange += t.change24h * t.volume24h;
    totalVol += t.volume24h;
    changes.push(t.change24h);
  }

  const avgChange = totalVol > 0 ? volWeightedChange / totalVol : 0;
  const breadthRatio = top.length > 0 ? bullish / top.length : 0.5;

  // ── 2. BTC vs alts divergence (rotation detection) ────────────────────────
  const btc = overviews.find(t => t.coin === "BTC");
  const eth = overviews.find(t => t.coin === "ETH");
  const btcChange = btc?.change24h ?? 0;
  const ethChange = eth?.change24h ?? 0;
  const majorsFlat = Math.abs(btcChange) < 2 && Math.abs(ethChange) < 2;

  // Count alts (non-BTC/ETH) with strong moves
  const alts = top.filter(t => t.coin !== "BTC" && t.coin !== "ETH");
  const altMovers = alts.filter(t => Math.abs(t.change24h) > 3).length;
  const altBullish = alts.filter(t => t.change24h > 3).length;
  const isRotation = majorsFlat && altMovers >= 5;

  // ── 3. Volatility compression (squeeze detection) ─────────────────────────
  // Low dispersion among top coins = compressed, breakout incoming
  const mean = changes.reduce((s, c) => s + c, 0) / changes.length;
  const variance = changes.reduce((s, c) => s + (c - mean) ** 2, 0) / changes.length;
  const stdDev = Math.sqrt(variance);
  const isCompressed = stdDev < 1.5 && Math.abs(avgChange) < 1;

  // ── 4. Funding & positioning tilt ─────────────────────────────────────────
  let positiveFunding = 0, negativeFunding = 0;
  let totalFundingTilt = 0;
  for (const t of top) {
    const annualized = t.fundingRate * 24 * 365 * 100;
    if (annualized > 5) positiveFunding++;
    else if (annualized < -5) negativeFunding++;
    totalFundingTilt += annualized;
  }
  const avgFunding = totalFundingTilt / top.length;
  const crowdedLongs = positiveFunding >= 10 && avgFunding > 10;
  const crowdedShorts = negativeFunding >= 8 && avgFunding < -10;

  // ── 5. Liquidation cascade detection ──────────────────────────────────────
  // Sharp move + high OI drop + extreme funding = capitulation
  const whaleAlerts = getWhaleAlerts(50);
  const recentLiqs = whaleAlerts.filter(w =>
    (w.eventType === "close_long" || w.eventType === "close_short") &&
    Date.now() - w.detectedAt < 60 * 60 * 1000 // last hour
  ).length;
  const sharpSelloff = avgChange < -4 && bearish >= 12;
  const isCapitulation = sharpSelloff && (recentLiqs >= 5 || crowdedLongs);

  // ── 6. Score each regime ──────────────────────────────────────────────────
  const scores: Record<RegimeType, number> = {
    risk_on: 0,
    risk_off: 0,
    chop: 0,
    rotation: 0,
    squeeze: 0,
    capitulation: 0,
  };

  // RISK ON: broad rally, most coins up, positive momentum
  if (breadthRatio >= 0.6) scores.risk_on += 30;
  if (breadthRatio >= 0.7) scores.risk_on += 20;
  if (avgChange > 1) scores.risk_on += 20;
  if (avgChange > 3) scores.risk_on += 15;
  if (negativeFunding > 5) scores.risk_on += 15; // shorts paying = healthy rally

  // RISK OFF: broad sell, most coins down
  if (bearish / top.length >= 0.6) scores.risk_off += 30;
  if (bearish / top.length >= 0.7) scores.risk_off += 20;
  if (avgChange < -1) scores.risk_off += 20;
  if (avgChange < -3) scores.risk_off += 15;
  if (crowdedLongs) scores.risk_off += 15; // fragile positioning

  // CAPITULATION: extreme sell + liquidations
  if (isCapitulation) scores.capitulation += 60;
  if (avgChange < -5) scores.capitulation += 20;
  if (recentLiqs >= 10) scores.capitulation += 20;
  if (bearish >= 16) scores.capitulation += 15;

  // ROTATION: majors flat, alts moving
  if (isRotation) scores.rotation += 50;
  if (majorsFlat && altMovers >= 8) scores.rotation += 25;
  if (altBullish >= 5 && Math.abs(btcChange) < 1) scores.rotation += 25;

  // SQUEEZE: everything compressed
  if (isCompressed) scores.squeeze += 50;
  if (stdDev < 1) scores.squeeze += 25;
  if (flat >= 10) scores.squeeze += 25;

  // CHOP: default — nothing strong
  if (bullish >= 5 && bearish >= 5 && bullish < 12 && bearish < 12) scores.chop += 40;
  if (stdDev >= 1.5 && stdDev < 4 && Math.abs(avgChange) < 2) scores.chop += 30;
  if (!isRotation && !isCompressed && breadthRatio > 0.3 && breadthRatio < 0.7) scores.chop += 30;

  // ── 7. Pick winner ───────────────────────────────────────────────────────
  let bestRegime: RegimeType = "chop";
  let bestScore = 0;
  for (const [r, s] of Object.entries(scores) as [RegimeType, number][]) {
    if (s > bestScore) { bestScore = s; bestRegime = r; }
  }

  // Confidence = winner score capped at 100
  const confidence = Math.min(100, bestScore);

  // ── 8. Debounce — hold regime for minimum time unless new signal is strong
  if (lastRegime && lastRegime.regime !== bestRegime) {
    const held = Date.now() - lastRegime.since;
    if (held < REGIME_MIN_HOLD_MS && confidence < 70) {
      // Keep previous regime unless new one is high confidence
      bestRegime = lastRegime.regime;
    } else {
      lastRegime = { regime: bestRegime, since: Date.now() };
    }
  } else if (!lastRegime) {
    lastRegime = { regime: bestRegime, since: Date.now() };
  }

  // ── 9. Build description (the "why") ──────────────────────────────────────
  const description = buildRegimeDescription(bestRegime, {
    bullish, bearish, flat, avgChange, btcChange, altMovers, altBullish,
    stdDev, crowdedLongs, crowdedShorts, recentLiqs, top: top.length,
  });

  return {
    regime: bestRegime,
    action: REGIME_CONFIG[bestRegime].action,
    description,
    confidence,
    bullishCount: bullish,
    bearishCount: bearish,
    avgChange24h: avgChange,
  };
}

function buildRegimeDescription(
  regime: RegimeType,
  d: {
    bullish: number; bearish: number; flat: number; avgChange: number;
    btcChange: number; altMovers: number; altBullish: number;
    stdDev: number; crowdedLongs: boolean; crowdedShorts: boolean;
    recentLiqs: number; top: number;
  },
): string {
  switch (regime) {
    case "risk_on":
      return `${d.bullish}/${d.top} coins rallying${d.crowdedShorts ? " — shorts getting squeezed" : ""}. Broad strength, buy dips`;
    case "risk_off":
      return `${d.bearish}/${d.top} coins selling off${d.crowdedLongs ? " — longs overleveraged" : ""}. Defensive mode`;
    case "capitulation":
      return `Sharp sell across ${d.bearish} coins${d.recentLiqs > 0 ? `, ${d.recentLiqs} liquidation events` : ""}. Watch for reversal`;
    case "rotation":
      return `BTC flat, ${d.altMovers} alts moving${d.altBullish >= 3 ? ` (${d.altBullish} breaking out)` : ""}. Hunt sector plays`;
    case "squeeze":
      return `Vol compressed (${d.stdDev.toFixed(1)} std dev), ${d.flat} coins rangebound. Breakout setup building`;
    case "chop":
    default:
      return `${d.bullish} up, ${d.bearish} down — mixed signals. No clear trend, fade extremes`;
  }
}

function computeUnusualVolumeSignals(overviews: TokenOverview[]): Signal[] {
  const signals: Signal[] = [];

  // We don't have historical volume averages yet, so flag coins with
  // volume > 2x their open interest (high turnover = unusual activity)
  for (const t of overviews) {
    if (t.openInterest <= 0 || t.volume24h <= 0) continue;
    const turnover = t.volume24h / t.openInterest;

    if (turnover > 5) {
      signals.push({
        type: "unusual_volume",
        coin: t.coin,
        severity: "critical",
        title: `${displayCoin(t.coin)} volume ${turnover.toFixed(0)}x OI`,
        description: `24h volume $${(t.volume24h / 1e6).toFixed(0)}M vs $${(t.openInterest / 1e6).toFixed(0)}M OI — extreme turnover`,
        value: turnover,
        timestamp: Date.now(),
      });
    } else if (turnover > 3) {
      signals.push({
        type: "unusual_volume",
        coin: t.coin,
        severity: "warning",
        title: `${displayCoin(t.coin)} high volume`,
        description: `24h volume ${turnover.toFixed(1)}x open interest`,
        value: turnover,
        timestamp: Date.now(),
      });
    }
  }

  return signals;
}

function computePositionCrowdingSignals(): Signal[] {
  const signals: Signal[] = [];
  const smartMoney = getSmartMoneyCached();
  if (!smartMoney) return signals;

  for (const [coin, positions] of smartMoney.sharpPositions) {
    if (positions.length < 3) continue;

    // Check if top 3 traders hold majority of sharp position value
    const sorted = [...positions].sort((a, b) => b.positionValue - a.positionValue);
    const totalValue = sorted.reduce((s, p) => s + p.positionValue, 0);
    const top3Value = sorted.slice(0, 3).reduce((s, p) => s + p.positionValue, 0);
    const concentration = totalValue > 0 ? (top3Value / totalValue) * 100 : 0;

    if (concentration > 80 && totalValue > 100000) {
      signals.push({
        type: "position_crowding",
        coin,
        severity: "warning",
        title: `${coin} concentrated: top 3 hold ${concentration.toFixed(0)}%`,
        description: `$${(top3Value / 1e6).toFixed(1)}M of $${(totalValue / 1e6).toFixed(1)}M sharp exposure in 3 wallets — fragile`,
        value: concentration,
        timestamp: Date.now(),
      });
    }
  }

  return signals;
}

function computeFundingRegimeSignals(overviews: TokenOverview[]): Signal[] {
  const signals: Signal[] = [];

  for (const t of overviews.slice(0, 30)) {
    const annualized = t.fundingRate * 24 * 365 * 100;

    if (annualized > 30) {
      signals.push({
        type: "funding_extreme",
        coin: t.coin,
        severity: "critical",
        title: `${displayCoin(t.coin)} funding ${annualized.toFixed(0)}% APR — crowded long`,
        description: `Extreme positive funding. Longs paying ${annualized.toFixed(0)}% annualized. Squeeze risk.`,
        value: annualized,
        timestamp: Date.now(),
      });
    } else if (annualized < -30) {
      signals.push({
        type: "funding_extreme",
        coin: t.coin,
        severity: "critical",
        title: `${displayCoin(t.coin)} funding ${annualized.toFixed(0)}% APR — crowded short`,
        description: `Extreme negative funding. Shorts paying ${Math.abs(annualized).toFixed(0)}% annualized. Short squeeze risk.`,
        value: annualized,
        timestamp: Date.now(),
      });
    }
  }

  return signals;
}

function computeSharpSquareCallout(): SharpSquareCallout {
  const smartMoney = getSmartMoneyCached();
  if (!smartMoney) {
    return {
      sharpTopLong: null, sharpTopShort: null, squareTopLong: null, squareTopShort: null,
      sharpLongs: [], sharpShorts: [], squareLongs: [], squareShorts: [],
    };
  }

  let sharpTopLong: SharpSquareCallout["sharpTopLong"] = null;
  let sharpTopShort: SharpSquareCallout["sharpTopShort"] = null;
  let squareTopLong: SharpSquareCallout["squareTopLong"] = null;
  let squareTopShort: SharpSquareCallout["squareTopShort"] = null;

  const sharpLongs: { coin: string; count: number; strength: number }[] = [];
  const sharpShorts: { coin: string; count: number; strength: number }[] = [];
  const squareLongs: { coin: string; count: number; strength: number }[] = [];
  const squareShorts: { coin: string; count: number; strength: number }[] = [];

  for (const f of smartMoney.flow) {
    const sharpTotal = f.sharpLongCount + f.sharpShortCount;
    const squareTotal = f.squareLongCount + f.squareShortCount;
    if (sharpTotal < 3) continue;

    const sharpLongPct = (f.sharpLongCount / sharpTotal) * 100;
    const sharpShortPct = (f.sharpShortCount / sharpTotal) * 100;

    // Collect sharp longs with conviction > 55%
    if (sharpLongPct > 55) {
      sharpLongs.push({ coin: f.coin, count: f.sharpLongCount, strength: f.sharpStrength });
      // Backwards compat: keep top 1 by count
      if (!sharpTopLong || f.sharpLongCount > sharpTopLong.count) {
        sharpTopLong = { coin: f.coin, count: f.sharpLongCount, pct: Math.round(sharpLongPct) };
      }
    }

    // Collect sharp shorts with conviction > 55%
    if (sharpShortPct > 55) {
      sharpShorts.push({ coin: f.coin, count: f.sharpShortCount, strength: f.sharpStrength });
      if (!sharpTopShort || f.sharpShortCount > sharpTopShort.count) {
        sharpTopShort = { coin: f.coin, count: f.sharpShortCount, pct: Math.round(sharpShortPct) };
      }
    }

    if (squareTotal >= 3) {
      const squareLongPct = (f.squareLongCount / squareTotal) * 100;
      const squareShortPct = (f.squareShortCount / squareTotal) * 100;

      if (squareLongPct > 55) {
        squareLongs.push({ coin: f.coin, count: f.squareLongCount, strength: f.squareStrength });
        if (!squareTopLong || f.squareLongCount > squareTopLong.count) {
          squareTopLong = { coin: f.coin, count: f.squareLongCount, pct: Math.round(squareLongPct) };
        }
      }
      if (squareShortPct > 55) {
        squareShorts.push({ coin: f.coin, count: f.squareShortCount, strength: f.squareStrength });
        if (!squareTopShort || f.squareShortCount > squareTopShort.count) {
          squareTopShort = { coin: f.coin, count: f.squareShortCount, pct: Math.round(squareShortPct) };
        }
      }
    }
  }

  // Sort each array by strength descending, limit to top 5
  const top5 = <T extends { strength: number }>(arr: T[]) =>
    arr.sort((a, b) => b.strength - a.strength).slice(0, 5);

  return {
    sharpTopLong, sharpTopShort, squareTopLong, squareTopShort,
    sharpLongs: top5(sharpLongs),
    sharpShorts: top5(sharpShorts),
    squareLongs: top5(squareLongs),
    squareShorts: top5(squareShorts),
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function getSignals(): Promise<SignalsCache> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL) return cache;

  const overviews = await getTokenOverviews();

  const unusualVolume = computeUnusualVolumeSignals(overviews);
  const crowding = computePositionCrowdingSignals();
  const fundingExtremes = computeFundingRegimeSignals(overviews);

  const signals = [...unusualVolume, ...crowding, ...fundingExtremes]
    .sort((a, b) => {
      const sevOrder = { critical: 0, warning: 1, info: 2 };
      return sevOrder[a.severity] - sevOrder[b.severity];
    });

  const fundingOpps = computeFundingOpportunities(overviews);
  const regime = computeMarketRegime(overviews);
  const callout = computeSharpSquareCallout();

  cache = { signals, fundingOpps, regime, callout, fetchedAt: Date.now() };
  return cache;
}

export function getSignalsCached(): SignalsCache | null {
  return cache;
}
