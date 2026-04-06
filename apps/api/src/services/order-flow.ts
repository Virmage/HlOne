/**
 * Order Flow Imbalance — tracks net taker buy/sell pressure per coin
 * using Hyperliquid's recentTrades endpoint.
 */

import { getRecentTrades } from "./hyperliquid.js";
import { getCachedAssetCtxs, getCachedMids } from "./market-data.js";

export interface OrderFlowWindow {
  interval: "1m" | "5m" | "15m";
  buyVolume: number;
  sellVolume: number;
  netFlow: number;
  imbalance: number; // -1 to +1
  buyCount: number;
  sellCount: number;
}

export interface OrderFlowCoin {
  coin: string;
  currentPrice: number;
  windows: OrderFlowWindow[];
  delta5m: number; // shortcut for sorting
}

// ─── Storage ────────────────────────────────────────────────────────────────

interface TradeRecord {
  time: number;
  side: "B" | "A";
  notional: number;
}

const BUFFER_DURATION = 15 * 60_000; // 15 minutes
const POLL_INTERVAL = 20_000;
const TOP_COINS_COUNT = 15;

const coinBuffers = new Map<string, TradeRecord[]>();
const seenTids = new Set<string>();
let intervalId: ReturnType<typeof setInterval> | null = null;

// ─── Polling ────────────────────────────────────────────────────────────────

async function getTopCoins(): Promise<string[]> {
  const ctxs = await getCachedAssetCtxs();
  return [...ctxs.entries()]
    .map(([coin, ctx]) => ({ coin, volume: parseFloat(ctx.dayNtlVlm || "0") }))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, TOP_COINS_COUNT)
    .map(c => c.coin);
}

async function pollOrderFlow(): Promise<void> {
  try {
    const coins = await getTopCoins();
    const now = Date.now();

    for (const coin of coins) {
      try {
        const rawTrades = await getRecentTrades(coin) as {
          side: string;
          px: string;
          sz: string;
          time: number;
          tid: number;
        }[];

        if (!rawTrades || rawTrades.length === 0) continue;

        const buffer = coinBuffers.get(coin) || [];

        for (const t of rawTrades) {
          const tid = `${coin}-${t.tid}`;
          if (seenTids.has(tid)) continue;
          seenTids.add(tid);

          const px = parseFloat(t.px) || 0;
          const sz = parseFloat(t.sz) || 0;
          if (px === 0 || sz === 0) continue;

          buffer.push({
            time: t.time,
            side: t.side === "B" ? "B" : "A",
            notional: sz * px,
          });
        }

        // Prune old entries
        const cutoff = now - BUFFER_DURATION;
        const pruned = buffer.filter(t => t.time > cutoff);
        coinBuffers.set(coin, pruned);
      } catch {
        // Skip individual coin errors
      }
    }

    // Prune seenTids periodically
    if (seenTids.size > 50_000) {
      const arr = [...seenTids];
      for (let i = 0; i < arr.length - 30_000; i++) {
        seenTids.delete(arr[i]);
      }
    }
  } catch (err) {
    console.error("[order-flow] Poll failed:", (err as Error).message);
  }
}

function computeWindow(trades: TradeRecord[], windowMs: number, now: number): OrderFlowWindow {
  const cutoff = now - windowMs;
  const recent = trades.filter(t => t.time > cutoff);

  let buyVol = 0, sellVol = 0, buyCount = 0, sellCount = 0;
  for (const t of recent) {
    if (t.side === "B") {
      buyVol += t.notional;
      buyCount++;
    } else {
      sellVol += t.notional;
      sellCount++;
    }
  }

  const total = buyVol + sellVol;
  const netFlow = buyVol - sellVol;
  const imbalance = total > 0 ? Math.round((netFlow / total) * 100) / 100 : 0;

  const intervalLabel = windowMs === 60_000 ? "1m" : windowMs === 5 * 60_000 ? "5m" : "15m";

  return {
    interval: intervalLabel as OrderFlowWindow["interval"],
    buyVolume: Math.round(buyVol),
    sellVolume: Math.round(sellVol),
    netFlow: Math.round(netFlow),
    imbalance,
    buyCount,
    sellCount,
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function startOrderFlowTracking(): void {
  if (intervalId) return;
  console.log("[order-flow] Starting order flow tracking (20s interval, top 15 coins)");
  intervalId = setInterval(pollOrderFlow, POLL_INTERVAL);
  setTimeout(pollOrderFlow, 3000);
}

export function getOrderFlow(): OrderFlowCoin[] {
  const now = Date.now();
  const mids = midCache;
  const results: OrderFlowCoin[] = [];

  for (const [coin, buffer] of coinBuffers) {
    if (buffer.length === 0) continue;

    const windows: OrderFlowWindow[] = [
      computeWindow(buffer, 60_000, now),
      computeWindow(buffer, 5 * 60_000, now),
      computeWindow(buffer, 15 * 60_000, now),
    ];

    const delta5m = windows[1].imbalance;

    results.push({
      coin,
      currentPrice: mids[coin] || 0,
      windows,
      delta5m,
    });
  }

  // Sort by absolute 5m imbalance
  results.sort((a, b) => Math.abs(b.delta5m) - Math.abs(a.delta5m));
  return results;
}

// Sync mid cache
let midCache: Record<string, number> = {};

export async function warmOrderFlowMids(): Promise<void> {
  try {
    const mids = await getCachedMids();
    midCache = mids;
  } catch { /* ignore */ }
}
