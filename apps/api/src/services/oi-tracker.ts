/**
 * Open Interest history tracker.
 * Hyperliquid API only provides current OI — no historical candles.
 * This service snapshots OI every minute and builds OI candles in-memory.
 */

import { getCachedAssetCtxs, getCachedMids } from "./market-data.js";

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

// Per-coin snapshots, capped at 40320 entries (~7 days at 15s intervals)
const MAX_SNAPSHOTS = 40320;
const snapshots = new Map<string, OISnapshot[]>();

// Track which coins to monitor (top 30 by volume)
let trackedCoins: string[] = [];

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

      // Trim old entries
      if (arr.length > MAX_SNAPSHOTS) {
        arr.splice(0, arr.length - MAX_SNAPSHOTS);
      }
    }
  } catch (err) {
    console.error("[oi-tracker] Snapshot failed:", (err as Error).message);
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
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
  "1M": 30 * 24 * 60 * 60_000,
};

export function getOICandlesForInterval(coin: string, interval: string, count = 60): OICandle[] {
  const ms = INTERVAL_MS[interval] || INTERVAL_MS["5m"];
  return getOICandles(coin, ms, count);
}
