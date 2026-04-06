/**
 * Position Concentration — shows top holders as % of total OI per coin.
 * Pure computation from smart money cache + asset contexts. No extra API calls.
 */

import { getSmartMoneyCached } from "./smart-money.js";
import { getCachedAssetCtxs } from "./market-data.js";
import { getTraderDisplayName } from "./name-generator.js";

export interface TopHolder {
  displayName: string;
  side: "long" | "short";
  positionValue: number;
  leverage: number;
  pctOfOI: number;
}

export interface PositionConcentration {
  coin: string;
  totalOI: number;
  trackedOI: number;
  trackedPct: number;
  top5Value: number;
  top5Pct: number;
  top10Value: number;
  top10Pct: number;
  herfindahl: number; // 0-1
  longPct: number;
  isCrowded: boolean;
  topHolders: TopHolder[];
}

export async function getPositionConcentration(): Promise<PositionConcentration[]> {
  const sm = getSmartMoneyCached();
  if (!sm) return [];

  const ctxs = await getCachedAssetCtxs();
  const results: PositionConcentration[] = [];

  for (const [coin, positions] of sm.sharpPositions) {
    if (positions.length === 0) continue;

    const ctx = ctxs.get(coin);
    if (!ctx) continue;

    const markPx = parseFloat(ctx.markPx || ctx.midPx || "0");
    const oiCoins = parseFloat(ctx.openInterest || "0");
    const totalOI = oiCoins * markPx;
    if (totalOI <= 0) continue;

    // Sort by position value descending
    const sorted = [...positions].sort((a, b) => b.positionValue - a.positionValue);

    const trackedOI = sorted.reduce((sum, p) => sum + p.positionValue, 0);
    const longValue = sorted.filter(p => p.side === "long").reduce((sum, p) => sum + p.positionValue, 0);

    const top5 = sorted.slice(0, 5);
    const top10 = sorted.slice(0, 10);
    const top5Value = top5.reduce((sum, p) => sum + p.positionValue, 0);
    const top10Value = top10.reduce((sum, p) => sum + p.positionValue, 0);

    // Herfindahl index (sum of squared market shares)
    const hhi = trackedOI > 0
      ? sorted.reduce((sum, p) => {
          const share = p.positionValue / trackedOI;
          return sum + share * share;
        }, 0)
      : 0;

    const top5Pct = totalOI > 0 ? (top5Value / totalOI) * 100 : 0;
    const top10Pct = totalOI > 0 ? (top10Value / totalOI) * 100 : 0;

    results.push({
      coin,
      totalOI: Math.round(totalOI),
      trackedOI: Math.round(trackedOI),
      trackedPct: Math.round((trackedOI / totalOI) * 1000) / 10,
      top5Value: Math.round(top5Value),
      top5Pct: Math.round(top5Pct * 10) / 10,
      top10Value: Math.round(top10Value),
      top10Pct: Math.round(top10Pct * 10) / 10,
      herfindahl: Math.round(hhi * 1000) / 1000,
      longPct: trackedOI > 0 ? Math.round((longValue / trackedOI) * 100) : 50,
      isCrowded: top5Pct > 30 || hhi > 0.3,
      topHolders: top5.map(p => ({
        displayName: getTraderDisplayName(p.address, p.displayName),
        side: p.side,
        positionValue: Math.round(p.positionValue),
        leverage: p.leverage,
        pctOfOI: Math.round((p.positionValue / totalOI) * 1000) / 10,
      })),
    });
  }

  // Sort by top5Pct descending (most concentrated first)
  results.sort((a, b) => b.top5Pct - a.top5Pct);
  return results.slice(0, 15);
}
