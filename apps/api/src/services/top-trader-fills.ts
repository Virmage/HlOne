/**
 * Top Trader Fills — fetches and caches fills from the top 50 traders by performance.
 * Ranked by: 30d ROI × sharp score × log(accountValue) — rewards consistent profitable traders.
 * Lookback: 30 days (covers daily/weekly chart timeframes).
 * Updates every 30min. Used to show buy/sell dots on the price chart.
 */

import { getUserFillsByTime } from "./hyperliquid.js";
import { getSmartMoneyData } from "./smart-money.js";

export interface TopTraderFill {
  time: number;
  coin: string;
  side: "buy" | "sell";
  price: number;
  sizeUsd: number;
  trader: string;
  address: string;
}

// Cache: coin -> fills[]
const fillsCache = new Map<string, TopTraderFill[]>();
let lastFetchTime = 0;
const CACHE_TTL = 30 * 60_000; // 30 min
const TOP_TRADER_COUNT = 50;
const LOOKBACK_DAYS = 30;
const MAX_FILLS_PER_COIN = 1000;

async function refreshTopTraderFills(): Promise<void> {
  try {
    const smartMoney = await getSmartMoneyData();
    if (!smartMoney?.sharps?.length) return;

    // Rank sharps by composite performance score:
    // roi30d (recent performance) × sharp score (consistency) × log(account value) (skin in game)
    // This surfaces traders who are both recently profitable AND historically consistent
    const ranked = smartMoney.sharps
      .filter(t => t.roi30d > 0 && t.accountValue > 5_000) // must be profitable recently, min $5K account
      .map(t => {
        const sharpScore = smartMoney.traderScores.get(t.address.toLowerCase()) || 50;
        const performanceRank =
          Math.min(t.roi30d, 500) *           // cap ROI to avoid one-hit wonders
          (sharpScore / 100) *                  // consistency multiplier
          Math.log10(t.accountValue + 1);       // skin in game
        return { ...t, performanceRank };
      })
      .sort((a, b) => b.performanceRank - a.performanceRank)
      .slice(0, TOP_TRADER_COUNT);

    if (ranked.length === 0) {
      console.log("[top-trader-fills] No qualifying traders found");
      return;
    }

    // Fetch fills going back 30 days
    const since = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60_000;
    const allFills: TopTraderFill[] = [];

    // Batch in groups of 10 to avoid overwhelming the API
    for (let i = 0; i < ranked.length; i += 10) {
      const batch = ranked.slice(i, i + 10);
      const results = await Promise.allSettled(
        batch.map(t => getUserFillsByTime(t.address, since))
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status !== "fulfilled" || !Array.isArray(result.value)) continue;

        const trader = batch[j];
        const displayName = trader.displayName || trader.address.slice(0, 8);

        for (const fill of result.value) {
          const px = parseFloat(fill.px);
          const sz = parseFloat(fill.sz);
          if (!px || !sz) continue;

          const isBuy = fill.side === "B";
          allFills.push({
            time: fill.time,
            coin: fill.coin,
            side: isBuy ? "buy" : "sell",
            price: px,
            sizeUsd: px * sz,
            trader: displayName,
            address: trader.address,
          });
        }
      }
    }

    // Group by coin and store in cache
    fillsCache.clear();
    for (const fill of allFills) {
      const existing = fillsCache.get(fill.coin) || [];
      existing.push(fill);
      fillsCache.set(fill.coin, existing);
    }

    // Sort by time, keep biggest fills when capping
    for (const [coin, fills] of fillsCache) {
      if (fills.length > MAX_FILLS_PER_COIN) {
        // Keep the largest fills by USD size — more meaningful on chart
        fills.sort((a, b) => b.sizeUsd - a.sizeUsd);
        const kept = fills.slice(0, MAX_FILLS_PER_COIN);
        kept.sort((a, b) => a.time - b.time);
        fillsCache.set(coin, kept);
      } else {
        fills.sort((a, b) => a.time - b.time);
      }
    }

    lastFetchTime = Date.now();
    const totalFills = [...fillsCache.values()].reduce((sum, f) => sum + f.length, 0);
    const topTrader = ranked[0];
    console.log(`[top-trader-fills] Cached ${totalFills} fills across ${fillsCache.size} coins from ${ranked.length} traders (top: ${topTrader.displayName || topTrader.address.slice(0, 8)} roi30d:${topTrader.roi30d.toFixed(1)}%)`);
  } catch (err) {
    console.error("[top-trader-fills] Refresh failed:", (err as Error).message);
  }
}

// Public API

export function getTopTraderFills(coin: string, since?: number): TopTraderFill[] {
  const fills = fillsCache.get(coin) || [];
  if (since) return fills.filter(f => f.time >= since);
  return fills;
}

export async function getTopTraderFillsCached(coin: string, since?: number): Promise<TopTraderFill[]> {
  if (Date.now() - lastFetchTime > CACHE_TTL) {
    await refreshTopTraderFills();
  }
  return getTopTraderFills(coin, since);
}

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startTopTraderFillsTracking(): void {
  if (intervalId) return;
  console.log("[top-trader-fills] Starting (30min refresh, top 50 by performance, 30d lookback)");
  // Initial fetch after smart money has warmed up (45s)
  setTimeout(refreshTopTraderFills, 45_000);
  intervalId = setInterval(refreshTopTraderFills, CACHE_TTL);
}
