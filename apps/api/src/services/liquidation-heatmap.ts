/**
 * Liquidation Heatmap — estimates liquidation clusters from tracked positions.
 * Pure computation from smart money cache + asset contexts. No extra API calls.
 */

import { getSmartMoneyCached } from "./smart-money.js";
import { getCachedMids } from "./market-data.js";

export interface LiquidationBand {
  priceLow: number;
  priceHigh: number;
  priceMid: number;
  longLiqValue: number;
  shortLiqValue: number;
  traderCount: number;
  distancePct: number; // % from current price (negative = below)
}

export interface LiquidationHeatmap {
  coin: string;
  currentPrice: number;
  bands: LiquidationBand[];
  totalLongLiqAbove: number;
  totalShortLiqBelow: number;
}

export function getLiquidationHeatmap(): LiquidationHeatmap[] {
  const sm = getSmartMoneyCached();
  if (!sm) return [];

  const mids = getCachedMidsSync();
  const results: LiquidationHeatmap[] = [];

  for (const [coin, positions] of sm.sharpPositions) {
    const currentPrice = mids[coin];
    if (!currentPrice || positions.length === 0) continue;

    // Band width = 1% of current price
    const bandWidth = currentPrice * 0.01;
    const bandMap = new Map<number, { longVal: number; shortVal: number; count: number }>();

    for (const pos of positions) {
      if (!pos.liquidationPx || pos.liquidationPx <= 0) continue;

      const bandIndex = Math.round((pos.liquidationPx - currentPrice) / bandWidth);
      const existing = bandMap.get(bandIndex) || { longVal: 0, shortVal: 0, count: 0 };

      if (pos.side === "long") {
        existing.longVal += pos.positionValue;
      } else {
        existing.shortVal += pos.positionValue;
      }
      existing.count++;
      bandMap.set(bandIndex, existing);
    }

    // Convert to bands, filter meaningful ones
    const bands: LiquidationBand[] = [];
    let totalLongAbove = 0;
    let totalShortBelow = 0;

    for (const [idx, data] of bandMap) {
      if (data.longVal + data.shortVal < 10_000) continue; // skip tiny

      const priceMid = currentPrice + idx * bandWidth;
      const distancePct = (idx * bandWidth / currentPrice) * 100;

      bands.push({
        priceLow: priceMid - bandWidth / 2,
        priceHigh: priceMid + bandWidth / 2,
        priceMid,
        longLiqValue: Math.round(data.longVal),
        shortLiqValue: Math.round(data.shortVal),
        traderCount: data.count,
        distancePct: Math.round(distancePct * 10) / 10,
      });

      // Longs liquidate when price drops (liq below current = long liqs)
      // Shorts liquidate when price rises (liq above current = short liqs)
      if (priceMid > currentPrice) totalShortBelow += data.shortVal; // shorts squeezed above
      if (priceMid < currentPrice) totalLongAbove += data.longVal; // longs rekt below
    }

    bands.sort((a, b) => a.priceMid - b.priceMid);

    if (bands.length > 0) {
      results.push({
        coin,
        currentPrice,
        bands: bands.slice(0, 30), // cap at 30 bands
        totalLongLiqAbove: Math.round(totalLongAbove),
        totalShortLiqBelow: Math.round(totalShortBelow),
      });
    }
  }

  // Sort by total liquidation value
  results.sort((a, b) => {
    const aTotal = a.bands.reduce((s, b) => s + b.longLiqValue + b.shortLiqValue, 0);
    const bTotal = b.bands.reduce((s, b) => s + b.longLiqValue + b.shortLiqValue, 0);
    return bTotal - aTotal;
  });

  return results.slice(0, 15);
}

// Sync version of getCachedMids — returns empty if not cached yet
function getCachedMidsSync(): Record<string, number> {
  // getCachedMids returns a promise, but the data is already cached in-memory
  // We need to access it synchronously. Use a module-level cache.
  return midCache;
}

let midCache: Record<string, number> = {};

export async function warmLiquidationMids(): Promise<void> {
  try {
    const mids = await getCachedMids();
    midCache = mids;
  } catch { /* ignore */ }
}
