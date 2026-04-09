/**
 * Large Trade Tape service — tracks large trades across top coins.
 * Polls recentTrades for top 15 coins by volume, aggregates fills
 * by taker address (a single market order fills against many resting
 * orders, each producing a separate hash), and keeps a capped buffer.
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

const MAX_TRADES = 500;
const MIN_SIZE_MAJOR = 50_000;   // $50K+ for BTC, ETH, SOL
const MIN_SIZE_ALT = 15_000;     // $15K+ for everything else
const MAJOR_COINS = new Set(["BTC", "ETH", "SOL"]);
const POLL_INTERVAL = 15_000; // 15 seconds — more frequent polling
const TOP_COINS_COUNT = 20;
const COIN_DELAY = 200; // ms between each coin request to avoid 429s

let trades: LargeTrade[] = [];
const seenTids = new Set<number>();
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

    for (let ci = 0; ci < coins.length; ci++) {
      const coin = coins[ci];
      if (ci > 0) await new Promise(r => setTimeout(r, COIN_DELAY));
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

        // Aggregate fills by taker+side — a single market order fills
        // against many resting orders, each with a different hash.
        // Grouping by taker+side within the same batch captures the full order.
        const byTaker = new Map<string, {
          coin: string;
          side: string;
          totalSize: number;
          totalNotional: number;
          time: number;
          hash: string; // keep first hash as reference
          taker: string;
          fillCount: number;
        }>();

        for (const t of rawTrades) {
          if (seenTids.has(t.tid)) continue;

          const sz = parseFloat(t.sz) || 0;
          const px = parseFloat(t.px) || 0;
          if (sz === 0 || px === 0) continue;
          const notional = sz * px;
          const taker = (t.users && t.users[0]) || t.hash;
          const key = `${taker}_${t.side}`;

          seenTids.add(t.tid);

          const existing = byTaker.get(key);
          if (existing) {
            existing.totalSize += sz;
            existing.totalNotional += notional;
            existing.fillCount++;
            if (t.time > existing.time) {
              existing.time = t.time;
              existing.hash = t.hash;
            }
          } else {
            byTaker.set(key, {
              coin,
              side: t.side,
              totalSize: sz,
              totalNotional: notional,
              time: t.time,
              hash: t.hash,
              taker,
              fillCount: 1,
            });
          }
        }

        // Filter for large trades — higher threshold for majors
        const minSize = MAJOR_COINS.has(coin) ? MIN_SIZE_MAJOR : MIN_SIZE_ALT;
        for (const [, agg] of byTaker) {
          if (agg.totalNotional >= minSize) {
            trades.push({
              coin: agg.coin,
              side: agg.side === "B" ? "buy" : "sell",
              sizeUsd: agg.totalNotional,
              sizeNative: agg.totalSize,
              price: agg.totalNotional / agg.totalSize,
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
      trades = trades.slice(0, MAX_TRADES);
    }

    // Prune seenTids if it gets too large (keep last 10000)
    if (seenTids.size > 10_000) {
      const arr = [...seenTids];
      const toRemove = arr.slice(0, arr.length - 10_000);
      for (const tid of toRemove) seenTids.delete(tid);
    }
  } catch (err) {
    console.error("[trade-tape] Poll failed:", (err as Error).message);
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function startTradeTapeTracking(): void {
  if (intervalId) return;
  console.log("[trade-tape] Starting large trade tracking (15s interval, top 20 coins, $50K+ majors / $15K+ alts)");
  intervalId = setInterval(pollTrades, POLL_INTERVAL);
  // Initial poll quickly after startup
  setTimeout(pollTrades, 5_000);
}

export function getLargeTrades(limit?: number): LargeTrade[] {
  const n = limit ?? MAX_TRADES;
  return trades.slice(0, n);
}

export function getLargeTradesCached(): LargeTrade[] {
  return trades;
}
