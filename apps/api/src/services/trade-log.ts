/**
 * Trade logging service — tracks all trades placed through the terminal.
 * Stores in-memory ring buffer + logs to console for observability.
 * This gives you visibility into fee collection, trade success rates,
 * and user activity without needing user reports.
 */

export interface TradeLogEntry {
  id: number;
  timestamp: number;
  userAddress: string;
  asset: string;
  side: "buy" | "sell";
  orderType: "market" | "limit";
  size: number;
  price: number;
  notionalUsd: number;
  feeEstimatedUsd: number; // builder fee estimate (0.02% of notional)
  success: boolean;
  orderId?: string;
  filledSize?: string;
  avgPrice?: string;
  error?: string;
  latencyMs: number;
}

// ─── In-memory ring buffer (last 1000 trades) ────────────────────────────────

const MAX_LOG_SIZE = 1000;
const tradeLog: TradeLogEntry[] = [];
let logCounter = 0;

// ─── Aggregate stats ─────────────────────────────────────────────────────────

const stats = {
  totalTrades: 0,
  successfulTrades: 0,
  failedTrades: 0,
  totalNotionalUsd: 0,
  totalFeesEstimatedUsd: 0,
  startedAt: Date.now(),
  // Per-hour buckets for rate tracking (last 24h)
  hourlyBuckets: new Map<number, { trades: number; volume: number; fees: number }>(),
  // Unique users ever seen (lowercased addresses). Populated from HL's
  // onchain builder-code fills on next query to keep cross-restart state.
  uniqueUsers: new Set<string>(),
  uniqueUsers24h: new Map<string, number>(), // address → last-seen timestamp
};

function getHourBucket(ts: number): number {
  return Math.floor(ts / (60 * 60 * 1000)) * (60 * 60 * 1000);
}

function pruneHourlyBuckets() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [hour] of stats.hourlyBuckets) {
    if (hour < cutoff) stats.hourlyBuckets.delete(hour);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function logTrade(entry: Omit<TradeLogEntry, "id" | "timestamp">): void {
  logCounter++;
  const fullEntry: TradeLogEntry = {
    ...entry,
    id: logCounter,
    timestamp: Date.now(),
  };

  // Ring buffer
  tradeLog.unshift(fullEntry);
  if (tradeLog.length > MAX_LOG_SIZE) tradeLog.length = MAX_LOG_SIZE;

  // Update stats
  stats.totalTrades++;
  if (entry.success) {
    stats.successfulTrades++;
    stats.totalNotionalUsd += entry.notionalUsd;
    stats.totalFeesEstimatedUsd += entry.feeEstimatedUsd;
  } else {
    stats.failedTrades++;
  }

  // Track unique users — both all-time (until restart) and rolling 24h
  const userLower = entry.userAddress.toLowerCase();
  stats.uniqueUsers.add(userLower);
  stats.uniqueUsers24h.set(userLower, Date.now());

  // Hourly bucket
  const hour = getHourBucket(Date.now());
  const bucket = stats.hourlyBuckets.get(hour) || { trades: 0, volume: 0, fees: 0 };
  bucket.trades++;
  if (entry.success) {
    bucket.volume += entry.notionalUsd;
    bucket.fees += entry.feeEstimatedUsd;
  }
  stats.hourlyBuckets.set(hour, bucket);

  // Structured console log for server logs (Railway, Vercel, etc.)
  const emoji = entry.success ? "✓" : "✗";
  const sizeStr = entry.filledSize || entry.size.toString();
  const priceStr = entry.avgPrice || entry.price.toFixed(2);
  console.log(
    `[trade] ${emoji} ${entry.side.toUpperCase()} ${sizeStr} ${entry.asset} @ ${priceStr}` +
    ` | $${entry.notionalUsd.toFixed(0)} | fee ~$${entry.feeEstimatedUsd.toFixed(2)}` +
    ` | ${entry.latencyMs}ms | ${entry.userAddress.slice(0, 8)}...` +
    (entry.error ? ` | ERROR: ${entry.error}` : entry.orderId ? ` | oid:${entry.orderId}` : ""),
  );
}

export function getTradeLog(limit = 50): TradeLogEntry[] {
  return tradeLog.slice(0, limit);
}

export function getTradeStats() {
  pruneHourlyBuckets();

  const now = Date.now();
  const last1h = getHourBucket(now);
  const last24h = [...stats.hourlyBuckets.values()];

  const uptimeMs = now - stats.startedAt;
  const uptimeHours = uptimeMs / (60 * 60 * 1000);

  // Prune 24h unique-user map
  const dayAgo = now - 24 * 60 * 60 * 1000;
  for (const [addr, ts] of stats.uniqueUsers24h) {
    if (ts < dayAgo) stats.uniqueUsers24h.delete(addr);
  }

  return {
    total: stats.totalTrades,
    successful: stats.successfulTrades,
    failed: stats.failedTrades,
    successRate: stats.totalTrades > 0
      ? Math.round((stats.successfulTrades / stats.totalTrades) * 100)
      : 0,
    totalVolumeUsd: Math.round(stats.totalNotionalUsd),
    totalFeesEstimatedUsd: Math.round(stats.totalFeesEstimatedUsd * 100) / 100,
    avgFeesPerHour: uptimeHours > 0
      ? Math.round((stats.totalFeesEstimatedUsd / uptimeHours) * 100) / 100
      : 0,
    // NEW: unique-user counts
    uniqueUsers: stats.uniqueUsers.size,
    uniqueUsers24h: stats.uniqueUsers24h.size,
    last1h: stats.hourlyBuckets.get(last1h) || { trades: 0, volume: 0, fees: 0 },
    last24h: {
      trades: last24h.reduce((s, b) => s + b.trades, 0),
      volume: Math.round(last24h.reduce((s, b) => s + b.volume, 0)),
      fees: Math.round(last24h.reduce((s, b) => s + b.fees, 0) * 100) / 100,
    },
    uptimeHours: Math.round(uptimeHours * 10) / 10,
    startedAt: stats.startedAt,
    // Disclaimer: these counts reset on API restart. For onchain-verified
    // cumulative numbers, query HL's /info endpoint directly with type
    // 'userFees' or similar for the builder address 0xbB0f7533... — every
    // fill that pays our builder code is fully public onchain.
    note: "Counters reset on API restart. For permanent onchain history, query HL's public API for builder-code fills.",
  };
}
