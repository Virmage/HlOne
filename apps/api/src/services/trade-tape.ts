/**
 * Large Trade Tape service — tracks large trades across top coins.
 * Polls recentTrades for top 15 coins by volume, aggregates fills
 * by hash, and keeps a capped buffer of trades > $25K.
 */

import { getRecentTrades } from "./hyperliquid.js";
import { getCachedAssetCtxs, getCachedMids } from "./market-data.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LargeTrade {
  coin: string;
  side: "buy" | "sell";
  sizeUsd: number;
  sizeNative: number;
  price: number;
  time: number;
  hash: string;
  taker: string;
}

// ─── Storage ────────────────────────────────────────────────────────────────

const MAX_TRADES = 200;
const MIN_SIZE_USD = 25_000;
const POLL_INTERVAL = 20_000; // 20 seconds
const TOP_COINS_COUNT = 15;

let trades: LargeTrade[] = [];
const seenHashes = new Set<string>();
let intervalId: ReturnType<typeof setInterval> | null = null;

// ─── Polling ────────────────────────────────────────────────────────────────

async function getTopCoins(): Promise<string[]> {
  const ctxs = await getCachedAssetCtxs();
  return [...ctxs.entries()]
    .map(([coin, ctx]) => ({
      coin,
      volume: parseFloat(ctx.dayNtlVlm || "0"),
    }))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, TOP_COINS_COUNT)
    .map(c => c.coin);
}

async function pollTrades(): Promise<void> {
  try {
    const coins = await getTopCoins();
    const mids = await getCachedMids();

    for (const coin of coins) {
      try {
        const rawTrades = await getRecentTrades(coin) as {
          coin: string;
          side: string;
          px: string;
          sz: string;
          hash: string;
          time: number;
          tid: number;
          users?: string[];
        }[];

        if (!rawTrades || rawTrades.length === 0) continue;

        const price = mids[coin] || 0;
        if (price === 0) continue;

        // Aggregate fills by hash (same hash = same order)
        const byHash = new Map<string, {
          coin: string;
          side: string;
          totalSize: number;
          totalNotional: number;
          weightedPrice: number;
          time: number;
          hash: string;
          taker: string;
        }>();

        for (const t of rawTrades) {
          const hash = t.hash;
          if (seenHashes.has(hash)) continue;

          const sz = parseFloat(t.sz) || 0;
          const px = parseFloat(t.px) || 0;
          if (sz === 0 || px === 0) continue;
          const notional = sz * px;

          const existing = byHash.get(hash);
          if (existing) {
            existing.totalSize += sz;
            existing.totalNotional += notional;
            existing.weightedPrice = existing.totalNotional / existing.totalSize;
            if (t.time > existing.time) existing.time = t.time;
          } else {
            byHash.set(hash, {
              coin,
              side: t.side,
              totalSize: sz,
              totalNotional: notional,
              weightedPrice: px,
              time: t.time,
              hash,
              taker: (t.users && t.users[0]) || "",
            });
          }
        }

        // Filter for large trades and add to buffer
        for (const [hash, agg] of byHash) {
          if (agg.totalNotional >= MIN_SIZE_USD) {
            seenHashes.add(hash);
            trades.push({
              coin: agg.coin,
              side: agg.side === "B" ? "buy" : "sell",
              sizeUsd: agg.totalNotional,
              sizeNative: agg.totalSize,
              price: agg.weightedPrice,
              time: agg.time,
              hash: agg.hash,
              taker: agg.taker,
            });
          }
        }
      } catch (err) {
        // Skip individual coin errors silently
      }
    }

    // Sort by time descending and cap
    trades.sort((a, b) => b.time - a.time);
    if (trades.length > MAX_TRADES) {
      const removed = trades.splice(MAX_TRADES);
      for (const t of removed) seenHashes.delete(t.hash);
    }

    // Also prune seenHashes if it gets too large (keep last 5000)
    if (seenHashes.size > 5000) {
      const hashArr = [...seenHashes];
      const toRemove = hashArr.slice(0, hashArr.length - 5000);
      for (const h of toRemove) seenHashes.delete(h);
    }
  } catch (err) {
    console.error("[trade-tape] Poll failed:", (err as Error).message);
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function startTradeTapeTracking(): void {
  if (intervalId) return;
  console.log("[trade-tape] Starting large trade tracking (20s interval, top 15 coins)");
  intervalId = setInterval(pollTrades, POLL_INTERVAL);
  // Initial poll after a short delay
  setTimeout(pollTrades, 5000);
}

export function getLargeTrades(limit?: number): LargeTrade[] {
  const n = limit ?? MAX_TRADES;
  return trades.slice(0, n);
}

export function getLargeTradesCached(): LargeTrade[] {
  return trades;
}
