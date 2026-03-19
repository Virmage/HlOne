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
  squareLongCount: number;
  squareShortCount: number;
  squareNetSize: number;
  consensus: "strong_long" | "long" | "neutral" | "short" | "strong_short";
  divergence: boolean; // sharps and squares disagree
}

export interface TraderPosition {
  address: string;
  displayName: string;
  isSharp: boolean;
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
  flow: SharpSquareFlow[];
  divergences: DivergenceSignal[];
  sharpPositions: Map<string, TraderPosition[]>; // coin → positions
  fetchedAt: number;
}

let cache: SmartMoneyCache | null = null;
const CACHE_TTL = 60_000; // 60 seconds
const FULL_REFRESH_TTL = 5 * 60_000; // 5 minutes for full position scan

let lastFullRefresh = 0;

// ─── Classification ──────────────────────────────────────────────────────────

function classifyTraders(traders: DiscoveredTrader[]) {
  // Sharps: top 500 by allTime ROI where ROI > 30% AND account > $10K
  const sharpCandidates = traders
    .filter(t => t.roiAllTime > 30 && t.accountValue > 10_000)
    .sort((a, b) => b.roiAllTime - a.roiAllTime)
    .slice(0, 500);

  const sharpAddresses = new Set(sharpCandidates.map(t => t.address.toLowerCase()));

  // Squares: everyone else with account > $1K
  const squares = traders.filter(
    t => !sharpAddresses.has(t.address.toLowerCase()) && t.accountValue > 1_000
  );

  return { sharps: sharpCandidates, sharpAddresses, squares };
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
): Map<string, { longCount: number; shortCount: number; netSize: number; avgEntry: number; positions: TraderPosition[] }> {
  const coinAgg = new Map<string, { longCount: number; shortCount: number; netSize: number; totalEntry: number; entryCount: number; positions: TraderPosition[] }>();

  for (const trader of traders) {
    const positions = positionMap.get(trader.address.toLowerCase());
    if (!positions) continue;

    for (const pos of positions) {
      const size = parseFloat(pos.szi);
      if (size === 0) continue;

      const coin = pos.coin;
      const agg = coinAgg.get(coin) || { longCount: 0, shortCount: 0, netSize: 0, totalEntry: 0, entryCount: 0, positions: [] };

      if (size > 0) agg.longCount++;
      else agg.shortCount++;
      agg.netSize += size;
      agg.totalEntry += parseFloat(pos.entryPx);
      agg.entryCount++;

      agg.positions.push({
        address: trader.address,
        displayName: getTraderDisplayName(trader.address, trader.displayName),
        isSharp,
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

  const result = new Map<string, { longCount: number; shortCount: number; netSize: number; avgEntry: number; positions: TraderPosition[] }>();
  for (const [coin, agg] of coinAgg) {
    result.set(coin, {
      longCount: agg.longCount,
      shortCount: agg.shortCount,
      netSize: agg.netSize,
      avgEntry: agg.entryCount > 0 ? agg.totalEntry / agg.entryCount : 0,
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
  const { sharps, sharpAddresses, squares } = classifyTraders(allTraders);

  // Only do full position scan every 5 minutes
  const needsFullRefresh = !cache || Date.now() - lastFullRefresh > FULL_REFRESH_TTL;

  let sharpPositionMap: Map<string, HLPosition[]>;
  let squarePositionMap: Map<string, HLPosition[]>;

  if (needsFullRefresh) {
    // Fetch positions for all sharps + sample of 200 squares
    const squareSample = squares
      .sort(() => Math.random() - 0.5)
      .slice(0, 200);

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
  const sharpFlow = aggregateFlow(sharps, sharpPositionMap, true);
  const squareFlow = aggregateFlow(squares, squarePositionMap, false);

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
    const sharpDirection = sharpLongPct > 0.6 ? "long" : sharpLongPct < 0.4 ? "short" : "neutral";

    const squareTotal = (sq?.longCount || 0) + (sq?.shortCount || 0);
    const squareLongPct = squareTotal > 0 ? (sq?.longCount || 0) / squareTotal : 0.5;
    const squareDirection = squareLongPct > 0.6 ? "long" : squareLongPct < 0.4 ? "short" : "neutral";

    let consensus: SharpSquareFlow["consensus"] = "neutral";
    if (sharpLongPct > 0.75) consensus = "strong_long";
    else if (sharpLongPct > 0.6) consensus = "long";
    else if (sharpLongPct < 0.25) consensus = "strong_short";
    else if (sharpLongPct < 0.4) consensus = "short";

    const isDivergent = (sharpDirection === "long" && squareDirection === "short") ||
                        (sharpDirection === "short" && squareDirection === "long");

    flow.push({
      coin,
      sharpLongCount: sf?.longCount || 0,
      sharpShortCount: sf?.shortCount || 0,
      sharpNetSize: sf?.netSize || 0,
      sharpAvgEntry: sf?.avgEntry || 0,
      squareLongCount: sq?.longCount || 0,
      squareShortCount: sq?.shortCount || 0,
      squareNetSize: sq?.netSize || 0,
      consensus,
      divergence: isDivergent,
    });

    if (isDivergent && sharpTotal >= 3) {
      divergences.push({
        coin,
        sharpDirection: sharpDirection as "long" | "short",
        squareDirection: squareDirection as "long" | "short",
        sharpCount: sharpTotal,
        squareCount: squareTotal,
        sharpConviction: Math.round(Math.max(sharpLongPct, 1 - sharpLongPct) * 100),
        description: `Sharps are ${sharpDirection.toUpperCase()} (${sharpTotal} traders) while Squares are ${squareDirection.toUpperCase()} (${squareTotal} traders)`,
      });
    }

    if (sf?.positions) {
      sharpPositionsByCoin.set(coin, sf.positions);
    }
  }

  // Sort flow by total sharp interest
  flow.sort((a, b) => (b.sharpLongCount + b.sharpShortCount) - (a.sharpLongCount + a.sharpShortCount));
  divergences.sort((a, b) => b.sharpConviction - a.sharpConviction);

  cache = {
    sharps,
    sharpAddresses,
    squares,
    flow,
    divergences,
    sharpPositions: sharpPositionsByCoin,
    fetchedAt: Date.now(),
  };

  return cache;
}

export function isSharpAddress(address: string): boolean {
  if (!cache) return false;
  return cache.sharpAddresses.has(address.toLowerCase());
}

export async function getSharpPositionsForCoin(coin: string): Promise<TraderPosition[]> {
  const data = await getSmartMoneyData();
  return data.sharpPositions.get(coin) || [];
}
