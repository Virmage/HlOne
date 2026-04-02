/**
 * Top Trader Fills — fetches and caches recent fills from the top 50 PnL traders.
 * Updates daily. Used to show buy/sell dots on the price chart.
 */

import { getUserFillsByTime } from "./hyperliquid.js";
import { getSmartMoneyData } from "./smart-money.js";

export interface TopTraderFill {
  time: number;
  coin: string;
  side: "buy" | "sell"; // "buy" = opening/adding long or closing short
  price: number;
  sizeUsd: number;
  trader: string; // display name
  address: string;
}

// Cache: coin -> fills[]
const fillsCache = new Map<string, TopTraderFill[]>();
let lastFetchTime = 0;
const CACHE_TTL = 30 * 60_000; // 30 min — fills don't change that fast
const TOP_TRADER_COUNT = 50;

// Fetch fills for all top traders, aggregate by coin
async function refreshTopTraderFills(): Promise<void> {
  try {
    const smartMoney = await getSmartMoneyData();
    if (!smartMoney?.sharps?.length) return;

    // Top 50 sharps by account value (most significant traders)
    const topSharps = smartMoney.sharps
      .sort((a, b) => b.accountValue - a.accountValue)
      .slice(0, TOP_TRADER_COUNT);

    // Fetch last 7 days of fills for each trader
    const since = Date.now() - 7 * 24 * 60 * 60_000;
    const allFills: TopTraderFill[] = [];

    // Batch in groups of 10 to avoid overwhelming the API
    for (let i = 0; i < topSharps.length; i += 10) {
      const batch = topSharps.slice(i, i + 10);
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

    // Sort each coin's fills by time
    for (const [coin, fills] of fillsCache) {
      fills.sort((a, b) => a.time - b.time);
      // Cap at 500 per coin to save memory
      if (fills.length > 500) {
        fillsCache.set(coin, fills.slice(-500));
      }
    }

    lastFetchTime = Date.now();
    const totalFills = [...fillsCache.values()].reduce((sum, f) => sum + f.length, 0);
    console.log(`[top-trader-fills] Cached ${totalFills} fills across ${fillsCache.size} coins from ${topSharps.length} traders`);
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
  console.log("[top-trader-fills] Starting (30min refresh, top 50 traders)");
  // Initial fetch after smart money has warmed up (45s)
  setTimeout(refreshTopTraderFills, 45_000);
  intervalId = setInterval(refreshTopTraderFills, CACHE_TTL);
}
