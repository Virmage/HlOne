/**
 * Smart Money service — classifies traders into Sharps vs Squares,
 * aggregates their positions per token, and detects divergences.
 */

import { discoverActiveTraders, getClearinghouseState, type DiscoveredTrader, type HLPosition } from "./hyperliquid.js";
import { getTraderDisplayName } from "./name-generator.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SharpSquareFlow {
  coin: string;
  sharpLongCount: number;
  sharpShortCount: number;
  sharpNetSize: number; // positive = net long
  sharpAvgEntry: number;
  sharpStrength: number; // 0-100 weighted by trader scores
  sharpDirection: "long" | "short" | "neutral";
  squareLongCount: number;
  squareShortCount: number;
  squareNetSize: number;
  squareStrength: number; // 0-100 weighted by trader scores
  squareDirection: "long" | "short" | "neutral";
  consensus: "strong_long" | "long" | "neutral" | "short" | "strong_short";
  divergence: boolean; // sharps and squares disagree
}

export interface TraderPosition {
  address: string;
  displayName: string;
  isSharp: boolean;
  traderScore: number; // 0-100, how sharp or square this trader is
  accountValue: number;
  roiAllTime: number;
  coin: string;
  side: "long" | "short";
  size: number;
  entryPx: number;
  positionValue: number;
  leverage: number;
  unrealizedPnl: number;
  liquidationPx: number | null;
}

export interface DivergenceSignal {
  coin: string;
  sharpDirection: "long" | "short";
  squareDirection: "long" | "short";
  sharpCount: number;
  squareCount: number;
  sharpConviction: number; // 0-100, how strongly sharps agree
  description: string;
}

// ─── Cache ───────────────────────────────────────────────────────────────────

interface SmartMoneyCache {
  sharps: DiscoveredTrader[];
  sharpAddresses: Set<string>;
  squares: DiscoveredTrader[];
  traderScores: Map<string, number>; // address → score (0-100)
  flow: SharpSquareFlow[];
  divergences: DivergenceSignal[];
  sharpPositions: Map<string, TraderPosition[]>; // coin → positions
  fetchedAt: number;
}

let cache: SmartMoneyCache | null = null;
const CACHE_TTL = 60_000; // 60 seconds
const FULL_REFRESH_TTL = 5 * 60_000; // 5 minutes for full position scan

let lastFullRefresh = 0;

// ─── Trader Scoring ──────────────────────────────────────────────────────────

/**
 * Score a trader 0-100 based on:
 * - ROI consistency across timeframes (30%)
 * - Magnitude of allTime ROI (30%)
 * - Account size / skin in game (20%)
 * - Recent activity / volume (20%)
 */
function scoreTrader(t: DiscoveredTrader): number {
  // ROI consistency: all three windows positive = highest score
  const weeklyPositive = t.roiWeekly > 0 ? 1 : 0;
  const monthlyPositive = t.roi30d > 0 ? 1 : 0;
  const allTimePositive = t.roiAllTime > 0 ? 1 : 0;
  const consistencyScore = ((weeklyPositive + monthlyPositive + allTimePositive) / 3) * 100;

  // ROI magnitude: log scale to handle extreme values
  // 50% = 50, 100% = 65, 500% = 80, 1000%+ = 90+
  const absRoi = Math.abs(t.roiAllTime);
  const magnitudeScore = Math.min(100, absRoi > 0 ? 30 + Math.log10(1 + absRoi) * 25 : 0);

  // Account size: $10K = 30, $100K = 60, $1M+ = 90
  const sizeScore = Math.min(100, t.accountValue > 0 ? Math.log10(t.accountValue) * 20 : 0);

  // Activity: has volume in recent windows
  const hasRecentVolume = (t.roiWeekly !== 0 || t.roi30d !== 0) ? 80 : 30;

  const score = Math.round(
    consistencyScore * 0.30 +
    magnitudeScore * 0.30 +
    sizeScore * 0.20 +
    hasRecentVolume * 0.20
  );

  return Math.min(100, Math.max(0, score));
}

/**
 * Score a square (bad trader) 0-100. Higher = worse trader = better fade signal.
 * - Consistently negative ROI across timeframes
 * - Still has meaningful account (not zeroed)
 * - Still actively trading (not dormant)
 */
function scoreSquare(t: DiscoveredTrader): number {
  // Consistency of losses: all windows negative = highest square score
  const weeklyNeg = t.roiWeekly < 0 ? 1 : 0;
  const monthlyNeg = t.roi30d < 0 ? 1 : 0;
  const allTimeNeg = t.roiAllTime < 0 ? 1 : 0;
  const lossConsistency = ((weeklyNeg + monthlyNeg + allTimeNeg) / 3) * 100;

  // Magnitude of losses (worse = higher score as fade signal)
  const absRoi = Math.abs(t.roiAllTime);
  const lossMagnitude = t.roiAllTime < 0 ? Math.min(100, absRoi > 0 ? 30 + Math.log10(1 + absRoi) * 20 : 0) : 0;

  // Still has account value (can still trade, not zeroed)
  const hasAccount = t.accountValue > 1000 ? 80 : t.accountValue > 100 ? 40 : 0;

  // Active recently
  const isActive = (t.roiWeekly !== 0 || t.roi30d !== 0) ? 80 : 20;

  const score = Math.round(
    lossConsistency * 0.35 +
    lossMagnitude * 0.25 +
    hasAccount * 0.20 +
    isActive * 0.20
  );

  return Math.min(100, Math.max(0, score));
}

// ─── Classification ──────────────────────────────────────────────────────────

function classifyTraders(traders: DiscoveredTrader[]) {
  const traderScores = new Map<string, number>();

  // Score all traders
  for (const t of traders) {
    const addr = t.address.toLowerCase();
    if (t.roiAllTime > 0 && t.accountValue > 5_000) {
      traderScores.set(addr, scoreTrader(t));
    } else if (t.roiAllTime < -5 && t.accountValue > 1_000) {
      // Negative score for squares (stored as negative to distinguish)
      traderScores.set(addr, -scoreSquare(t));
    }
  }

  // Sharps: positive score > 40, sorted by score, top 500
  const sharpCandidates = traders
    .filter(t => (traderScores.get(t.address.toLowerCase()) || 0) > 40)
    .sort((a, b) => (traderScores.get(b.address.toLowerCase()) || 0) - (traderScores.get(a.address.toLowerCase()) || 0))
    .slice(0, 500);

  const sharpAddresses = new Set(sharpCandidates.map(t => t.address.toLowerCase()));

  // Squares: negative score (consistent losers), sorted by worst first, top 500
  const squares = traders
    .filter(t => {
      const score = traderScores.get(t.address.toLowerCase()) || 0;
      return score < -30 && !sharpAddresses.has(t.address.toLowerCase());
    })
    .sort((a, b) => (traderScores.get(a.address.toLowerCase()) || 0) - (traderScores.get(b.address.toLowerCase()) || 0))
    .slice(0, 500);

  // Convert scores to absolute for external use
  const absScores = new Map<string, number>();
  for (const [addr, score] of traderScores) {
    absScores.set(addr, Math.abs(score));
  }

  return { sharps: sharpCandidates, sharpAddresses, squares, traderScores: absScores };
}

// ─── Position fetching ───────────────────────────────────────────────────────

async function fetchPositionsBatch(
  addresses: string[],
  batchSize = 10,
  delayMs = 300,
): Promise<Map<string, HLPosition[]>> {
  const result = new Map<string, HLPosition[]>();

  for (let i = 0; i < addresses.length; i += batchSize) {
    const batch = addresses.slice(i, i + batchSize);
    const promises = batch.map(async (addr) => {
      try {
        const state = await getClearinghouseState(addr);
        const positions = (state?.assetPositions || [])
          .map((p: { position: HLPosition }) => p.position)
          .filter((p: HLPosition) => parseFloat(p.szi) !== 0);
        return { addr, positions };
      } catch {
        return { addr, positions: [] as HLPosition[] };
      }
    });

    const results = await Promise.all(promises);
    for (const { addr, positions } of results) {
      result.set(addr.toLowerCase(), positions);
    }

    if (i + batchSize < addresses.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  return result;
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

function aggregateFlow(
  traders: DiscoveredTrader[],
  positionMap: Map<string, HLPosition[]>,
  isSharp: boolean,
  traderScores: Map<string, number>,
): Map<string, { longCount: number; shortCount: number; netSize: number; avgEntry: number; weightedLong: number; weightedShort: number; positions: TraderPosition[] }> {
  const coinAgg = new Map<string, { longCount: number; shortCount: number; netSize: number; totalEntry: number; entryCount: number; weightedLong: number; weightedShort: number; positions: TraderPosition[] }>();

  for (const trader of traders) {
    const positions = positionMap.get(trader.address.toLowerCase());
    if (!positions) continue;
    const tScore = traderScores.get(trader.address.toLowerCase()) || 50;

    for (const pos of positions) {
      const size = parseFloat(pos.szi);
      if (size === 0) continue;

      const coin = pos.coin;
      const agg = coinAgg.get(coin) || { longCount: 0, shortCount: 0, netSize: 0, totalEntry: 0, entryCount: 0, weightedLong: 0, weightedShort: 0, positions: [] };

      if (size > 0) {
        agg.longCount++;
        agg.weightedLong += tScore;
      } else {
        agg.shortCount++;
        agg.weightedShort += tScore;
      }
      agg.netSize += size;
      agg.totalEntry += parseFloat(pos.entryPx);
      agg.entryCount++;

      agg.positions.push({
        address: trader.address,
        displayName: getTraderDisplayName(trader.address, trader.displayName),
        isSharp,
        traderScore: tScore,
        accountValue: trader.accountValue,
        roiAllTime: trader.roiAllTime,
        coin,
        side: size > 0 ? "long" : "short",
        size: Math.abs(size),
        entryPx: parseFloat(pos.entryPx),
        positionValue: parseFloat(pos.positionValue || "0"),
        leverage: pos.leverage?.value || 0,
        unrealizedPnl: parseFloat(pos.unrealizedPnl || "0"),
        liquidationPx: pos.liquidationPx ? parseFloat(pos.liquidationPx) : null,
      });

      coinAgg.set(coin, agg);
    }
  }

  const result = new Map<string, { longCount: number; shortCount: number; netSize: number; avgEntry: number; weightedLong: number; weightedShort: number; positions: TraderPosition[] }>();
  for (const [coin, agg] of coinAgg) {
    result.set(coin, {
      longCount: agg.longCount,
      shortCount: agg.shortCount,
      netSize: agg.netSize,
      avgEntry: agg.entryCount > 0 ? agg.totalEntry / agg.entryCount : 0,
      weightedLong: agg.weightedLong,
      weightedShort: agg.weightedShort,
      positions: agg.positions,
    });
  }
  return result;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function getSmartMoneyData(): Promise<SmartMoneyCache> {
  // Return cached if fresh enough for basic reads
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL) {
    return cache;
  }

  const allTraders = await discoverActiveTraders();
  const { sharps, sharpAddresses, squares, traderScores } = classifyTraders(allTraders);

  // Only do full position scan every 5 minutes
  const needsFullRefresh = !cache || Date.now() - lastFullRefresh > FULL_REFRESH_TTL;

  let sharpPositionMap: Map<string, HLPosition[]>;
  let squarePositionMap: Map<string, HLPosition[]>;

  if (needsFullRefresh) {
    // Fetch positions for all sharps + top 500 squares by account value
    // (top by account value = most likely to have active positions)
    const squareSample = squares
      .sort((a, b) => b.accountValue - a.accountValue)
      .slice(0, 500);

    [sharpPositionMap, squarePositionMap] = await Promise.all([
      fetchPositionsBatch(sharps.map(t => t.address)),
      fetchPositionsBatch(squareSample.map(t => t.address)),
    ]);

    lastFullRefresh = Date.now();
  } else {
    // Reuse previous position data, just reclassify
    return { ...cache!, fetchedAt: Date.now() };
  }

  // Aggregate per-coin flow
  const sharpFlow = aggregateFlow(sharps, sharpPositionMap, true, traderScores);
  const squareFlow = aggregateFlow(squares, squarePositionMap, false, traderScores);

  // Build combined flow + detect divergences
  const allCoins = new Set([...sharpFlow.keys(), ...squareFlow.keys()]);
  const flow: SharpSquareFlow[] = [];
  const divergences: DivergenceSignal[] = [];
  const sharpPositionsByCoin = new Map<string, TraderPosition[]>();

  for (const coin of allCoins) {
    const sf = sharpFlow.get(coin);
    const sq = squareFlow.get(coin);

    const sharpTotal = (sf?.longCount || 0) + (sf?.shortCount || 0);
    const sharpLongPct = sharpTotal > 0 ? (sf?.longCount || 0) / sharpTotal : 0.5;
    const sharpDir: "long" | "short" | "neutral" = sharpLongPct > 0.55 ? "long" : sharpLongPct < 0.45 ? "short" : "neutral";

    const squareTotal = (sq?.longCount || 0) + (sq?.shortCount || 0);
    const squareLongPct = squareTotal > 0 ? (sq?.longCount || 0) / squareTotal : 0.5;
    const squareDir: "long" | "short" | "neutral" = squareLongPct > 0.55 ? "long" : squareLongPct < 0.45 ? "short" : "neutral";

    // Compute weighted strength (0-100)
    // Strength = (weighted score of winning side - weighted score of losing side) / total, normalized
    const sharpWeightedLong = sf?.weightedLong || 0;
    const sharpWeightedShort = sf?.weightedShort || 0;
    const sharpWeightTotal = sharpWeightedLong + sharpWeightedShort;
    const sharpStrength = sharpWeightTotal > 0
      ? Math.round(Math.abs(sharpWeightedLong - sharpWeightedShort) / sharpWeightTotal * 100)
      : 0;

    const squareWeightedLong = sq?.weightedLong || 0;
    const squareWeightedShort = sq?.weightedShort || 0;
    const squareWeightTotal = squareWeightedLong + squareWeightedShort;
    const squareStrength = squareWeightTotal > 0
      ? Math.round(Math.abs(squareWeightedLong - squareWeightedShort) / squareWeightTotal * 100)
      : 0;

    let consensus: SharpSquareFlow["consensus"] = "neutral";
    if (sharpLongPct > 0.75) consensus = "strong_long";
    else if (sharpLongPct > 0.6) consensus = "long";
    else if (sharpLongPct < 0.25) consensus = "strong_short";
    else if (sharpLongPct < 0.4) consensus = "short";

    const isDivergent = (sharpDir === "long" && squareDir === "short") ||
                        (sharpDir === "short" && squareDir === "long");

    flow.push({
      coin,
      sharpLongCount: sf?.longCount || 0,
      sharpShortCount: sf?.shortCount || 0,
      sharpNetSize: sf?.netSize || 0,
      sharpAvgEntry: sf?.avgEntry || 0,
      sharpStrength,
      sharpDirection: sharpDir,
      squareLongCount: sq?.longCount || 0,
      squareShortCount: sq?.shortCount || 0,
      squareNetSize: sq?.netSize || 0,
      squareStrength,
      squareDirection: squareDir,
      consensus,
      divergence: isDivergent,
    });

    if (isDivergent && sharpTotal >= 3) {
      divergences.push({
        coin,
        sharpDirection: sharpDir as "long" | "short",
        squareDirection: squareDir as "long" | "short",
        sharpCount: sharpTotal,
        squareCount: squareTotal,
        sharpConviction: sharpStrength,
        description: `Sharps ${sharpDir.toUpperCase()} (strength ${sharpStrength}) vs Squares ${squareDir.toUpperCase()} (strength ${squareStrength})`,
      });
    }

    if (sf?.positions) {
      sharpPositionsByCoin.set(coin, sf.positions);
    }
  }

  // Sort flow by total sharp interest
  flow.sort((a, b) => (b.sharpLongCount + b.sharpShortCount) - (a.sharpLongCount + a.sharpShortCount));
  divergences.sort((a, b) => b.sharpConviction - a.sharpConviction);

  // Trim positions per coin to top 20 by position value (saves memory)
  for (const [coin, positions] of sharpPositionsByCoin) {
    if (positions.length > 20) {
      sharpPositionsByCoin.set(coin, positions.sort((a, b) => b.positionValue - a.positionValue).slice(0, 20));
    }
  }

  cache = {
    sharps,
    sharpAddresses,
    squares,
    traderScores,
    flow,
    divergences,
    sharpPositions: sharpPositionsByCoin,
    fetchedAt: Date.now(),
  };

  return cache;
}

/** Return cached data immediately, or null if not yet available. Never triggers a fetch. */
export function getSmartMoneyCached(): SmartMoneyCache | null {
  return cache;
}

export function isSharpAddress(address: string): boolean {
  if (!cache) return false;
  return cache.sharpAddresses.has(address.toLowerCase());
}

export async function getSharpPositionsForCoin(coin: string): Promise<TraderPosition[]> {
  // Use cached data if available, otherwise trigger a fetch
  const cached = getSmartMoneyCached();
  if (cached) return cached.sharpPositions.get(coin) || [];
  const data = await getSmartMoneyData();
  return data.sharpPositions.get(coin) || [];
}
