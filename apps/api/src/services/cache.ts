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

const memCache = new Map<string, { data: string; expiresAt: number }>();

function memGet(key: string): string | null {
  const entry = memCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memCache.delete(key);
    return null;
  }
  return entry.data;
}

function memSet(key: string, value: string, ttlMs: number): void {
  memCache.set(key, { data: value, expiresAt: Date.now() + ttlMs });
  // Lazy cleanup: evict expired entries when cache gets large
  if (memCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of memCache) {
      if (now > v.expiresAt) memCache.delete(k);
    }
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
