/**
 * Trading signals — unusual volume, funding arb, liquidation zones,
 * money flow, position crowding, cross-asset regime.
 * All computed from existing HL API data.
 */

import { getCachedAssetCtxs, getTokenOverviews, type TokenOverview } from "./market-data.js";
import { getCandleSnapshot, getRecentTrades } from "./hyperliquid.js";
import { getSmartMoneyCached } from "./smart-money.js";
import { getWhaleAlerts } from "./whale-tracker.js";

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

export interface MarketRegime {
  regime: "risk_on" | "risk_off" | "neutral" | "divergent";
  bullishCount: number;
  bearishCount: number;
  avgChange24h: number;
  description: string;
}

export interface SharpSquareCallout {
  sharpTopLong: { coin: string; count: number; pct: number } | null;
  sharpTopShort: { coin: string; count: number; pct: number } | null;
  squareTopLong: { coin: string; count: number; pct: number } | null;
  squareTopShort: { coin: string; count: number; pct: number } | null;
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

function computeMarketRegime(overviews: TokenOverview[]): MarketRegime {
  // Use top 20 coins by volume
  const top = overviews.slice(0, 20);
  let bullish = 0;
  let bearish = 0;
  let totalChange = 0;

  for (const t of top) {
    totalChange += t.change24h;
    if (t.change24h > 1) bullish++;
    else if (t.change24h < -1) bearish++;
  }

  const avgChange = top.length > 0 ? totalChange / top.length : 0;

  let regime: MarketRegime["regime"] = "neutral";
  let description = "";

  if (bullish >= 14) {
    regime = "risk_on";
    description = `Strong risk-on: ${bullish}/20 top coins up >1%. Avg ${avgChange >= 0 ? "+" : ""}${avgChange.toFixed(1)}%`;
  } else if (bearish >= 14) {
    regime = "risk_off";
    description = `Risk-off: ${bearish}/20 top coins down >1%. Avg ${avgChange.toFixed(1)}%`;
  } else if (bullish >= 8 && bearish >= 8) {
    regime = "divergent";
    description = `Divergent: ${bullish} up, ${bearish} down — no clear direction. Selective market.`;
  } else {
    regime = "neutral";
    description = `Neutral: ${bullish} up, ${bearish} down. Avg ${avgChange >= 0 ? "+" : ""}${avgChange.toFixed(1)}%`;
  }

  return { regime, bullishCount: bullish, bearishCount: bearish, avgChange24h: avgChange, description };
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
        title: `${t.coin} volume ${turnover.toFixed(0)}x OI`,
        description: `24h volume $${(t.volume24h / 1e6).toFixed(0)}M vs $${(t.openInterest / 1e6).toFixed(0)}M OI — extreme turnover`,
        value: turnover,
        timestamp: Date.now(),
      });
    } else if (turnover > 3) {
      signals.push({
        type: "unusual_volume",
        coin: t.coin,
        severity: "warning",
        title: `${t.coin} high volume`,
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
        title: `${t.coin} funding ${annualized.toFixed(0)}% APR — crowded long`,
        description: `Extreme positive funding. Longs paying ${annualized.toFixed(0)}% annualized. Squeeze risk.`,
        value: annualized,
        timestamp: Date.now(),
      });
    } else if (annualized < -30) {
      signals.push({
        type: "funding_extreme",
        coin: t.coin,
        severity: "critical",
        title: `${t.coin} funding ${annualized.toFixed(0)}% APR — crowded short`,
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
    return { sharpTopLong: null, sharpTopShort: null, squareTopLong: null, squareTopShort: null };
  }

  let sharpTopLong: SharpSquareCallout["sharpTopLong"] = null;
  let sharpTopShort: SharpSquareCallout["sharpTopShort"] = null;
  let squareTopLong: SharpSquareCallout["squareTopLong"] = null;
  let squareTopShort: SharpSquareCallout["squareTopShort"] = null;

  for (const f of smartMoney.flow) {
    const sharpTotal = f.sharpLongCount + f.sharpShortCount;
    const squareTotal = f.squareLongCount + f.squareShortCount;
    if (sharpTotal < 5) continue;

    const sharpLongPct = (f.sharpLongCount / sharpTotal) * 100;
    const sharpShortPct = (f.sharpShortCount / sharpTotal) * 100;

    // Find strongest sharp long conviction
    if (sharpLongPct > 65 && (!sharpTopLong || f.sharpLongCount > sharpTopLong.count)) {
      sharpTopLong = { coin: f.coin, count: f.sharpLongCount, pct: Math.round(sharpLongPct) };
    }

    // Find strongest sharp short conviction
    if (sharpShortPct > 65 && (!sharpTopShort || f.sharpShortCount > sharpTopShort.count)) {
      sharpTopShort = { coin: f.coin, count: f.sharpShortCount, pct: Math.round(sharpShortPct) };
    }

    if (squareTotal >= 5) {
      const squareLongPct = (f.squareLongCount / squareTotal) * 100;
      const squareShortPct = (f.squareShortCount / squareTotal) * 100;

      if (squareLongPct > 60 && (!squareTopLong || f.squareLongCount > squareTopLong.count)) {
        squareTopLong = { coin: f.coin, count: f.squareLongCount, pct: Math.round(squareLongPct) };
      }
      if (squareShortPct > 60 && (!squareTopShort || f.squareShortCount > squareTopShort.count)) {
        squareTopShort = { coin: f.coin, count: f.squareShortCount, pct: Math.round(squareShortPct) };
      }
    }
  }

  return { sharpTopLong, sharpTopShort, squareTopLong, squareTopShort };
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
