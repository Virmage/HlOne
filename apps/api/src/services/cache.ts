/**
 * Shared cache utility — Redis when available, in-memory fallback.
 * Enables multi-instance Railway deployments to share cached data.
 */

import Redis from "ioredis";

// ─── Redis Connection ──────────────────────────────────────────────────────

let redis: Redis | null = null;
let redisAvailable = false;

export function initRedis(): void {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.log("[cache] No REDIS_URL — using in-memory cache (single instance only)");
    return;
  }

  try {
    redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      lazyConnect: true,
    });

    redis.on("connect", () => {
      redisAvailable = true;
      console.log("[cache] Redis connected");
    });

    redis.on("error", (err) => {
      if (redisAvailable) {
        console.warn("[cache] Redis error, falling back to in-memory:", err.message);
      }
      redisAvailable = false;
    });

    redis.on("close", () => {
      redisAvailable = false;
    });

    redis.connect().catch(() => {
      console.warn("[cache] Redis connection failed — using in-memory fallback");
    });
  } catch {
    console.warn("[cache] Redis init failed — using in-memory fallback");
  }
}

// ─── In-Memory Fallback ────────────────────────────────────────────────────
//
// Bounded LRU. Previous version only evicted EXPIRED entries — if 500+
// keys were all fresh (e.g. terminal cached at 10s TTL but rewritten every
// 8s, plus per-coin / per-interval token-detail entries for HIP-4 outcome
// coins that roll daily), the cleanup loop deleted nothing and the Map
// grew without bound. Each entry holds a multi-MB JSON string of the
// terminal or token response, so a few hundred lingering entries was
// enough to OOM the Node heap.
//
// Fix:
//   - Hard cap on entry count (MAX_MEM_ENTRIES).
//   - LRU: on `get`, delete + re-insert to mark "most recently used" —
//     Map iteration order is insertion order in JS, so the head of
//     `keys()` is the least-recently-used entry.
//   - On `set`, evict the oldest entries until size ≤ cap.
//   - Still opportunistically clear expired entries.

const memCache = new Map<string, { data: string; expiresAt: number }>();
const MAX_MEM_ENTRIES = 300;

function memGet(key: string): string | null {
  const entry = memCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memCache.delete(key);
    return null;
  }
  // LRU touch — move to back of insertion order so it's no longer the
  // oldest candidate for eviction.
  memCache.delete(key);
  memCache.set(key, entry);
  return entry.data;
}

function memSet(key: string, value: string, ttlMs: number): void {
  // Drop any existing entry so the re-set lands at the END of insertion
  // order (most recently used position).
  if (memCache.has(key)) memCache.delete(key);
  memCache.set(key, { data: value, expiresAt: Date.now() + ttlMs });

  // First pass: evict expired entries (cheap, frees memory).
  if (memCache.size > MAX_MEM_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of memCache) {
      if (now > v.expiresAt) memCache.delete(k);
    }
  }

  // Second pass: hard LRU cap. Even if every remaining entry is still
  // fresh, drop the oldest until we're under the cap. This is the bit
  // the previous code was missing.
  while (memCache.size > MAX_MEM_ENTRIES) {
    const oldest = memCache.keys().next().value;
    if (oldest === undefined) break;
    memCache.delete(oldest);
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Get a cached value. Returns null if not found or expired.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  // Try Redis first
  if (redisAvailable && redis) {
    try {
      const val = await redis.get(key);
      if (val) return JSON.parse(val) as T;
    } catch {
      // Fall through to memory
    }
  }

  // In-memory fallback
  const val = memGet(key);
  if (val) return JSON.parse(val) as T;
  return null;
}

/**
 * Set a cached value with TTL in milliseconds.
 */
export async function cacheSet(key: string, value: unknown, ttlMs: number): Promise<void> {
  const json = JSON.stringify(value);

  // Always write to memory (local fast path)
  memSet(key, json, ttlMs);

  // Also write to Redis if available (shared across instances)
  if (redisAvailable && redis) {
    try {
      await redis.set(key, json, "PX", ttlMs);
    } catch {
      // Non-critical — memory cache still works
    }
  }
}

/**
 * Check if Redis is connected (for health endpoint).
 */
export function isRedisConnected(): boolean {
  return redisAvailable;
}
