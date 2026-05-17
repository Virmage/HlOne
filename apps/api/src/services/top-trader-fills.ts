/**
 * Top Trader Fills — fetches and caches fills from the top 50 traders by performance.
 * Ranked by: 30d ROI × sharp score × log(accountValue) — rewards consistent profitable traders.
 * Lookback: 30 days (covers daily/weekly chart timeframes).
 * Updates every 30min. Persists to DB so fills survive server restarts.
 */

import { getUserFillsByTime } from "./hyperliquid.js";
import { getSmartMoneyData } from "./smart-money.js";
import { topTraderFills as fillsTable } from "@hl-copy/db";
import { gte, desc } from "drizzle-orm";

export interface TopTraderFill {
  time: number;
  coin: string;
  side: "buy" | "sell";
  price: number;
  sizeUsd: number;
  trader: string;
  address: string;
  accountValue?: number;
}

// Cache: coin -> fills[]
const fillsCache = new Map<string, TopTraderFill[]>();
// Cap the number of coins kept in cache — the top traders touch many
// niche assets over 30 days and without this bound the cache grows
// indefinitely (each coin entry up to MAX_FILLS_PER_COIN × ~200 bytes).
// We keep the coins with the most-recent fill activity; the rest are
// dropped and their fills remain on disk only.
const MAX_COINS_IN_CACHE = 80;
let lastFetchTime = 0;
const CACHE_TTL = 30 * 60_000; // 30 min
const TOP_TRADER_COUNT = 50;
const LOOKBACK_DAYS = 30;
const MAX_FILLS_PER_COIN = 1000;

// DB reference — set via initTopTraderFillsDb()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any = null;

export function initTopTraderFillsDb(dbInstance: unknown): void {
  db = dbInstance;
}

// ─── Load from DB on startup ────────────────────────────────────────────────

export async function loadFillsFromDb(): Promise<void> {
  if (!db) {
    console.warn("[top-trader-fills] No DB — fills won't persist across restarts");
    return;
  }
  try {
    // Previously: `WHERE fillTime >= now - 30d ORDER BY fillTime` with NO
    // LIMIT. The DB has been accumulating fills for weeks; this SELECT
    // returned hundreds of thousands of rows and Drizzle materialised
    // the entire result array in memory before we even started looping.
    // That single query was enough to push the heap past 6GB on boot
    // and OOM the container 3 minutes after start.
    //
    // Fix: only load the last 7 days (recent enough to be useful for
    // the chart's "recent fills" feature) AND hard-cap at MAX_BOOT_ROWS.
    // The 30-day persistence on disk is still kept for the periodic
    // cleanup job; we just don't slurp it all into RAM at boot.
    const BOOT_LOOKBACK_DAYS = 7;
    const MAX_BOOT_ROWS = 20_000;
    const since = new Date(Date.now() - BOOT_LOOKBACK_DAYS * 24 * 60 * 60_000);
    const rows = await db
      .select()
      .from(fillsTable)
      .where(gte(fillsTable.fillTime, since))
      .orderBy(fillsTable.fillTime)
      .limit(MAX_BOOT_ROWS);

    let loaded = 0;
    for (const row of rows) {
      const fill: TopTraderFill = {
        time: new Date(row.fillTime).getTime(),
        coin: row.coin,
        side: row.side as "buy" | "sell",
        price: parseFloat(row.price),
        sizeUsd: parseFloat(row.sizeUsd),
        trader: row.trader,
        address: row.address,
        accountValue: row.accountValue ? parseFloat(row.accountValue) : undefined,
      };
      const existing = fillsCache.get(fill.coin) || [];
      // Apply per-coin cap immediately during load — don't let one
      // hot coin accumulate 20k rows in the cache.
      if (existing.length >= MAX_FILLS_PER_COIN) continue;
      existing.push(fill);
      fillsCache.set(fill.coin, existing);
      loaded++;
    }
    if (loaded > 0) {
      lastFetchTime = Date.now(); // Don't immediately refetch if we have DB data
      console.log(`[top-trader-fills] Loaded ${loaded} fills from DB across ${fillsCache.size} coins (capped at ${MAX_BOOT_ROWS} rows, ${BOOT_LOOKBACK_DAYS}d lookback)`);
    }
  } catch (err) {
    console.error("[top-trader-fills] Failed to load from DB:", (err as Error).message);
  }
}

// ─── Persist to DB ──────────────────────────────────────────────────────────

async function persistFillsToDb(fills: TopTraderFill[]): Promise<void> {
  if (!db || fills.length === 0) return;
  try {
    // Insert in batches of 200
    for (let i = 0; i < fills.length; i += 200) {
      const batch = fills.slice(i, i + 200).map(f => ({
        coin: f.coin,
        side: f.side,
        price: f.price.toFixed(6),
        sizeUsd: f.sizeUsd.toFixed(2),
        trader: f.trader,
        address: f.address,
        accountValue: f.accountValue?.toFixed(2) || null,
        fillTime: new Date(f.time),
      }));
      await db.insert(fillsTable).values(batch).onConflictDoNothing();
    }
  } catch (err) {
    console.error("[top-trader-fills] DB persist failed:", (err as Error).message);
  }
}

async function cleanupOldFills(): Promise<void> {
  if (!db) return;
  try {
    const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60_000);
    const { lte } = await import("drizzle-orm");
    await db.delete(fillsTable).where(lte(fillsTable.fillTime, cutoff));
  } catch (err) {
    console.error("[top-trader-fills] Cleanup failed:", (err as Error).message);
  }
}

// ─── Refresh from HL API ────────────────────────────────────────────────────

async function refreshTopTraderFills(): Promise<void> {
  try {
    const smartMoney = await getSmartMoneyData();
    if (!smartMoney?.sharps?.length) return;

    const ranked = smartMoney.sharps
      .filter(t => t.roi30d > 0 && t.accountValue > 5_000)
      .map(t => {
        const sharpScore = smartMoney.traderScores.get(t.address.toLowerCase()) || 50;
        const performanceRank =
          Math.min(t.roi30d, 500) *
          (sharpScore / 100) *
          Math.log10(t.accountValue + 1);
        return { ...t, performanceRank };
      })
      .sort((a, b) => b.performanceRank - a.performanceRank)
      .slice(0, TOP_TRADER_COUNT);

    if (ranked.length === 0) {
      console.log("[top-trader-fills] No qualifying traders found");
      return;
    }

    const since = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60_000;
    const allFills: TopTraderFill[] = [];

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
            accountValue: trader.accountValue,
          });
        }
      }
    }

    // Merge new fills with existing cache (preserves DB-loaded historical fills)
    // Deduplicate by time+address+coin
    for (const fill of allFills) {
      const existing = fillsCache.get(fill.coin) || [];
      existing.push(fill);
      fillsCache.set(fill.coin, existing);
    }

    // Deduplicate, sort by time, keep biggest fills when capping
    for (const [coin, fills] of fillsCache) {
      // Deduplicate by time+address (same trader, same timestamp = same fill)
      const seen = new Set<string>();
      const unique = fills.filter(f => {
        const key = `${f.time}:${f.address}:${f.price}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (unique.length > MAX_FILLS_PER_COIN) {
        unique.sort((a, b) => b.sizeUsd - a.sizeUsd);
        const kept = unique.slice(0, MAX_FILLS_PER_COIN);
        kept.sort((a, b) => a.time - b.time);
        fillsCache.set(coin, kept);
      } else {
        unique.sort((a, b) => a.time - b.time);
        fillsCache.set(coin, unique);
      }
    }

    // Cap the COIN count too — top traders touch many niche assets and
    // without this bound the cache grows indefinitely. Keep the coins
    // with the most-recent fill activity (the ones likely to still be
    // queried) and drop the rest.
    if (fillsCache.size > MAX_COINS_IN_CACHE) {
      const coinsByRecency = [...fillsCache.entries()]
        .map(([coin, fills]) => ({
          coin,
          newest: fills.length ? fills[fills.length - 1].time : 0,
        }))
        .sort((a, b) => b.newest - a.newest);
      const drop = coinsByRecency.slice(MAX_COINS_IN_CACHE);
      for (const { coin } of drop) fillsCache.delete(coin);
      if (drop.length) {
        console.log(`[top-trader-fills] memory cap: dropped ${drop.length} stale coins, kept ${fillsCache.size}`);
      }
    }

    lastFetchTime = Date.now();
    const totalFills = [...fillsCache.values()].reduce((sum, f) => sum + f.length, 0);
    const topTrader = ranked[0];
    console.log(`[top-trader-fills] Cached ${totalFills} fills across ${fillsCache.size} coins from ${ranked.length} traders (top: ${topTrader.displayName || topTrader.address.slice(0, 8)} roi30d:${topTrader.roi30d.toFixed(1)}%)`);

    // Persist to DB (fire-and-forget)
    persistFillsToDb(allFills).catch(() => {});
    // Cleanup old fills periodically
    cleanupOldFills().catch(() => {});
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
