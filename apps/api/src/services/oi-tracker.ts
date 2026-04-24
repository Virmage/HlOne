/**
 * Open Interest history tracker.
 * Hyperliquid API only provides current OI — no historical candles.
 * This service snapshots OI every minute, persists to DB, and builds OI candles.
 */

import { getCachedAssetCtxs, getCachedMids } from "./market-data.js";
import { oiSnapshots } from "@hl-copy/db";
import { desc, eq, and, gte, lte } from "drizzle-orm";

// ─── Types ──────────────────────────────────────────────────────────────────

interface OISnapshot {
  time: number;     // unix ms
  oi: number;       // OI in USD
  price: number;    // mark price at snapshot time
}

export interface OICandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

// ─── Storage ────────────────────────────────────────────────────────────────

// In-memory cache (fast access for candle building), loaded from DB on startup
// 7 days at 15s intervals = 40,320. We cap at 20k per coin in memory which
// is ~5 days at the full sample rate — more than enough for any OI chart.
// Previously this was 172,800 (30d) and the boot-load caused OOM at 2GB.
const MAX_SNAPSHOTS = 20_000;
const snapshots = new Map<string, OISnapshot[]>();

// Track which coins to monitor (top 30 by volume)
let trackedCoins: string[] = [];

// DB reference — set via initOITrackerDb()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any = null;

export function initOITrackerDb(dbInstance: unknown): void {
  db = dbInstance;
}

// ─── Load from DB on startup ────────────────────────────────────────────────

export async function loadOIFromDb(): Promise<void> {
  if (!db) {
    console.warn("[oi-tracker] No DB connection — OI history won't persist across restarts");
    return;
  }
  try {
    // Only load the last 7 days on boot (was 30 days). 30 days × 51 coins ×
    // 4 snaps/min = ~950k rows in RAM on boot = ~1GB and we OOMed at 2GB.
    // 7 days is more than enough for any OI chart the user actually displays;
    // the DB still has 30 days, we just don't preload it all into memory.
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000);
    // Further cap per-coin to MAX_SNAPSHOTS_ON_BOOT so even the top coins
    // don't blow the heap.
    const MAX_SNAPSHOTS_ON_BOOT = 20_000;
    const rows = await db
      .select({
        coin: oiSnapshots.coin,
        openInterest: oiSnapshots.openInterest,
        price: oiSnapshots.price,
        snapshotAt: oiSnapshots.snapshotAt,
      })
      .from(oiSnapshots)
      .where(gte(oiSnapshots.snapshotAt, sevenDaysAgo))
      .orderBy(oiSnapshots.snapshotAt);

    let loaded = 0;
    let skipped = 0;
    for (const row of rows) {
      const coin = row.coin;
      if (!snapshots.has(coin)) snapshots.set(coin, []);
      const arr = snapshots.get(coin)!;
      if (arr.length >= MAX_SNAPSHOTS_ON_BOOT) { skipped++; continue; }
      arr.push({
        time: new Date(row.snapshotAt).getTime(),
        oi: parseFloat(row.openInterest),
        price: parseFloat(row.price),
      });
      loaded++;
    }
    console.log(`[oi-tracker] Loaded ${loaded} snapshots (7d) across ${snapshots.size} coins${skipped ? `, skipped ${skipped} over per-coin cap` : ""}`);
  } catch (err) {
    console.error("[oi-tracker] Failed to load from DB:", (err as Error).message);
  }
}

// ─── Snapshot Collection ────────────────────────────────────────────────────

export async function snapshotOI(): Promise<void> {
  try {
    const [ctxs, mids] = await Promise.all([getCachedAssetCtxs(), getCachedMids()]);

    // Update tracked coins list (top 30 by volume)
    const coinsByVol = [...ctxs.entries()]
      .map(([coin, ctx]) => ({
        coin,
        volume: parseFloat(ctx.dayNtlVlm || "0"),
      }))
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 30)
      .map(c => c.coin);
    trackedCoins = coinsByVol;

    const now = Date.now();
    const dbRows: { coin: string; openInterest: string; price: string; snapshotAt: Date }[] = [];

    for (const coin of trackedCoins) {
      const ctx = ctxs.get(coin);
      if (!ctx) continue;

      const price = mids[coin] || parseFloat(ctx.midPx || "0");
      const oiCoins = parseFloat(ctx.openInterest || "0");
      const oiUsd = oiCoins * price;

      if (oiUsd <= 0) continue;

      if (!snapshots.has(coin)) snapshots.set(coin, []);
      const arr = snapshots.get(coin)!;
      arr.push({ time: now, oi: oiUsd, price });

      // Trim old entries in memory
      if (arr.length > MAX_SNAPSHOTS) {
        arr.splice(0, arr.length - MAX_SNAPSHOTS);
      }

      // Queue for DB insert
      dbRows.push({
        coin,
        openInterest: oiUsd.toFixed(2),
        price: price.toFixed(6),
        snapshotAt: new Date(now),
      });
    }

    // Batch insert to DB (fire-and-forget, don't block the snapshot cycle)
    if (db && dbRows.length > 0) {
      db.insert(oiSnapshots).values(dbRows).catch((err: Error) => {
        console.error("[oi-tracker] DB insert failed:", err.message);
      });
    }
  } catch (err) {
    console.error("[oi-tracker] Snapshot failed:", (err as Error).message);
  }
}

// ─── DB Cleanup (run daily) ─────────────────────────────────────────────────

export async function cleanupOldOISnapshots(): Promise<void> {
  if (!db) return;
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000);
    const result = await db
      .delete(oiSnapshots)
      .where(lte(oiSnapshots.snapshotAt, thirtyDaysAgo));
    console.log("[oi-tracker] Cleaned up OI snapshots older than 30 days");
  } catch (err) {
    console.error("[oi-tracker] Cleanup failed:", (err as Error).message);
  }
}

// ─── OI Candle Builder ──────────────────────────────────────────────────────

/**
 * Build OI candles from snapshots for a given coin and interval.
 */
export function getOICandles(coin: string, intervalMs: number, count = 60): OICandle[] {
  const snaps = snapshots.get(coin);
  if (!snaps || snaps.length < 2) return [];

  const now = Date.now();
  const startTime = now - intervalMs * count;

  // Group snapshots into buckets
  const buckets = new Map<number, OISnapshot[]>();
  for (const snap of snaps) {
    if (snap.time < startTime) continue;
    const bucketKey = Math.floor(snap.time / intervalMs) * intervalMs;
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
    buckets.get(bucketKey)!.push(snap);
  }

  // Build candles from buckets
  const candles: OICandle[] = [];
  const sortedKeys = [...buckets.keys()].sort((a, b) => a - b);

  for (const key of sortedKeys) {
    const bucket = buckets.get(key)!;
    if (bucket.length === 0) continue;
    candles.push({
      time: key,
      open: bucket[0].oi,
      high: Math.max(...bucket.map(s => s.oi)),
      low: Math.min(...bucket.map(s => s.oi)),
      close: bucket[bucket.length - 1].oi,
    });
  }

  return candles.slice(-count);
}

/**
 * Get current OI for a coin from the latest snapshot.
 */
export function getCurrentOI(coin: string): number {
  const snaps = snapshots.get(coin);
  if (!snaps || snaps.length === 0) return 0;
  return snaps[snaps.length - 1].oi;
}

/**
 * Get raw OI snapshot count for diagnostics.
 */
export function getOISnapshotCount(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [coin, arr] of snapshots) {
    counts[coin] = arr.length;
  }
  return counts;
}

// Interval mapping for string intervals
const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "12h": 12 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
  "1M": 30 * 24 * 60 * 60_000,
};

export function getOICandlesForInterval(coin: string, interval: string, count = 60): OICandle[] {
  const ms = INTERVAL_MS[interval] || INTERVAL_MS["5m"];
  return getOICandles(coin, ms, count);
}

// ─── External OI data sources ──────────────────────────────────────────────

// In-memory cache for external OI responses
const externalOICache = new Map<string, { data: OICandle[]; fetchedAt: number }>();
const EXTERNAL_OI_CACHE_TTL = 5 * 60_000; // 5 minutes

// Coinalyze rate limiter — serialize requests to avoid hitting API limits
let coinalyzeQueue: Promise<void> = Promise.resolve();
function enqueueCoinalyze<T>(fn: () => Promise<T>): Promise<T> {
  const task = coinalyzeQueue.then(() => fn(), () => fn());
  coinalyzeQueue = task.then(() => new Promise(r => setTimeout(r, 200)), () => {}); // 200ms gap between calls
  return task;
}

// Coinalyze interval format (HL-specific OI data)
const COINALYZE_INTERVAL: Record<string, string> = {
  "1m": "1min", "5m": "5min", "15m": "15min", "1h": "1hour", "4h": "4hour",
  "12h": "12hour", "1d": "daily",
  // Coinalyze doesn't support 1w/1M — we'll aggregate from daily
};

/**
 * Fetch OI candles from Coinalyze (requires COINALYZE_API_KEY env var).
 * Returns HL-specific OI data (not proxy data from other exchanges).
 */
async function getOICandlesFromCoinalyze(
  coin: string, interval: string, fromMs: number, toMs: number
): Promise<OICandle[]> {
  const apiKey = process.env.COINALYZE_API_KEY;
  if (!apiKey) {
    console.warn(`[oi-tracker] No COINALYZE_API_KEY set`);
    return [];
  }

  const symbol = `${coin.toUpperCase()}USD_PERP.A`;
  const coinalyzeInterval = COINALYZE_INTERVAL[interval];
  if (!coinalyzeInterval) {
    console.warn(`[oi-tracker] No Coinalyze mapping for interval "${interval}"`);
    return [];
  }

  try {
    const url = `https://api.coinalyze.net/v1/open-interest-history?symbols=${symbol}&interval=${coinalyzeInterval}&from=${Math.floor(fromMs / 1000)}&to=${Math.floor(toMs / 1000)}&api_key=${apiKey}`;
    const res = await fetch(url, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`[oi-tracker] Coinalyze returned ${res.status} for ${coin} ${interval}`);
      return [];
    }
    const json = await res.json();
    const entry = Array.isArray(json) ? json[0] : null;
    if (!entry?.history?.length) return [];

    return entry.history.map((h: { t: number; o: number; h: number; l: number; c: number }) => ({
      time: h.t * 1000,
      open: h.o,
      high: h.h,
      low: h.l,
      close: h.c,
    }));
  } catch (err) {
    console.warn(`[oi-tracker] Coinalyze fetch failed for ${coin}:`, (err as Error).message);
    return [];
  }
}

/**
 * Get OI candles from Coinalyze (HL-specific data).
 * Falls back to local tracker if no API key is set.
 */
export async function getExternalOICandles(
  coin: string, interval: string, fromMs: number, toMs: number
): Promise<OICandle[]> {
  const cacheKey = `${coin}_${interval}`;
  const cached = externalOICache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < EXTERNAL_OI_CACHE_TTL) {
    return cached.data;
  }

  let candles: OICandle[];

  // For 1w/1M: fetch daily and aggregate into larger buckets
  if (interval === "1w" || interval === "1M") {
    const dailyCandles = await enqueueCoinalyze(() => getOICandlesFromCoinalyze(coin, "1d", fromMs, toMs));
    const bucketMs = interval === "1w" ? 7 * 86400_000 : 30 * 86400_000;
    const buckets = new Map<number, OICandle[]>();
    for (const c of dailyCandles) {
      const key = Math.floor(c.time / bucketMs) * bucketMs;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(c);
    }
    candles = [...buckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([time, bucket]) => ({
        time,
        open: bucket[0].open,
        high: Math.max(...bucket.map(c => c.high)),
        low: Math.min(...bucket.map(c => c.low)),
        close: bucket[bucket.length - 1].close,
      }));
  } else {
    candles = await enqueueCoinalyze(() => getOICandlesFromCoinalyze(coin, interval, fromMs, toMs));
  }

  if (candles.length > 0) {
    externalOICache.set(cacheKey, { data: candles, fetchedAt: Date.now() });
  }
  return candles;
}
