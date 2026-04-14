/**
 * Whale tracker — monitors top accounts for position changes.
 * Events stored in-memory (capped) + persisted to DB for historical chart markers.
 */

import { discoverActiveTraders, getClearinghouseState, type HLPosition } from "./hyperliquid.js";
import { getTraderDisplayName } from "./name-generator.js";
import { getCachedMids } from "./market-data.js";
import type { Database } from "@hl-copy/db";
import { whaleEvents } from "@hl-copy/db";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WhaleEvent {
  id: string;
  whaleAddress: string;
  whaleName: string;
  accountValue: number;
  coin: string;
  eventType: "open_long" | "open_short" | "close_long" | "close_short" | "added" | "trimmed" | "flip";
  oldSize: number;
  newSize: number;
  positionValueUsd: number;
  price: number;
  detectedAt: number; // timestamp ms
}

// ─── State ───────────────────────────────────────────────────────────────────

const MAX_EVENTS = 200;
const events: WhaleEvent[] = [];
let previousPositions = new Map<string, Map<string, { size: number; side: string }>>();
let eventCounter = 0;
let isRunning = false;
let isFirstRun = true;
let db: Database | null = null;

/** Initialize DB reference for persisting whale events */
export function initWhaleTrackerDb(database: Database) {
  db = database;
}

// ─── Core logic ──────────────────────────────────────────────────────────────

export async function runWhaleCheck(): Promise<void> {
  if (isRunning) return; // prevent overlapping runs
  isRunning = true;

  try {
    const traders = await discoverActiveTraders();
    // Top 100 by account value
    const whales = [...traders]
      .sort((a, b) => b.accountValue - a.accountValue)
      .slice(0, 100);

    const mids = await getCachedMids();

    // Fetch positions in batches
    const BATCH = 10;
    for (let i = 0; i < whales.length; i += BATCH) {
      const batch = whales.slice(i, i + BATCH);
      const promises = batch.map(async (whale) => {
        try {
          const state = await getClearinghouseState(whale.address);
          const positions = (state?.assetPositions || [])
            .map((p: { position: HLPosition }) => p.position)
            .filter((p: HLPosition) => parseFloat(p.szi) !== 0);

          const currentMap = new Map<string, { size: number; side: string }>();
          for (const pos of positions) {
            const size = parseFloat(pos.szi);
            currentMap.set(pos.coin, { size, side: size > 0 ? "long" : "short" });
          }

          // Flag MMs by position diversity (>12 simultaneous positions)
          checkPositionDiversity(whale.address, currentMap.size);

          // Compare with previous
          const prevMap = previousPositions.get(whale.address.toLowerCase()) || new Map();
          const name = getTraderDisplayName(whale.address, whale.displayName);
          const seedRun = isFirstRun; // on first run, seed existing positions as events

          // Check for new positions (in current but not in previous)
          for (const [coin, curr] of currentMap) {
            const prev = prevMap.get(coin);
            const price = mids[coin] || 0;
            const posValue = Math.abs(curr.size) * price;

            if (!prev) {
              if (seedRun) {
                // First run: emit existing large positions so the feed isn't empty
                if (posValue >= 500_000 && !mmByDiversity.has(whale.address.toLowerCase()) && !isKnownMM(name)) {
                  addEvent({
                    whaleAddress: whale.address,
                    whaleName: name,
                    accountValue: whale.accountValue,
                    coin,
                    eventType: curr.side === "long" ? "open_long" : "open_short",
                    oldSize: 0,
                    newSize: curr.size,
                    positionValueUsd: posValue,
                    price,
                  }, true); // skip bot detection for seed
                }
              } else {
                // Normal: new position opened since last check
                addEvent({
                  whaleAddress: whale.address,
                  whaleName: name,
                  accountValue: whale.accountValue,
                  coin,
                  eventType: curr.side === "long" ? "open_long" : "open_short",
                  oldSize: 0,
                  newSize: curr.size,
                  positionValueUsd: posValue,
                  price,
                });
              }
            } else if (Math.sign(curr.size) !== Math.sign(prev.size)) {
              // Flipped direction
              addEvent({
                whaleAddress: whale.address,
                whaleName: name,
                accountValue: whale.accountValue,
                coin,
                eventType: "flip",
                oldSize: prev.size,
                newSize: curr.size,
                positionValueUsd: posValue,
                price,
              });
            } else {
              // Same direction — check for significant size change (>20%)
              const change = Math.abs(curr.size - prev.size) / Math.abs(prev.size);
              if (change > 0.2) {
                addEvent({
                  whaleAddress: whale.address,
                  whaleName: name,
                  accountValue: whale.accountValue,
                  coin,
                  eventType: Math.abs(curr.size) > Math.abs(prev.size) ? "added" : "trimmed",
                  oldSize: prev.size,
                  newSize: curr.size,
                  positionValueUsd: posValue,
                  price,
                });
              }
            }
          }

          // Check for closed positions (in previous but not in current)
          for (const [coin, prev] of prevMap) {
            if (!currentMap.has(coin)) {
              const price = mids[coin] || 0;
              addEvent({
                whaleAddress: whale.address,
                whaleName: name,
                accountValue: whale.accountValue,
                coin,
                eventType: prev.side === "long" ? "close_long" : "close_short",
                oldSize: prev.size,
                newSize: 0,
                positionValueUsd: Math.abs(prev.size) * price,
                price,
              });
            }
          }

          // Update previous positions
          previousPositions.set(whale.address.toLowerCase(), currentMap);
        } catch {
          // Skip failed fetches
        }
      });

      await Promise.all(promises);

      // Small delay between batches
      if (i + BATCH < whales.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }
    if (isFirstRun) {
      isFirstRun = false;
      console.log(`[whale-tracker] First run complete — seeded ${events.length} existing whale positions`);
    }
  } finally {
    isRunning = false;
  }
}

// ─── Bot / MM detection ─────────────────────────────────────────────────────
// Market makers are the largest accounts but their constant hedging/adjusting
// creates noise. We filter them out via:
// 1. Event frequency (>4 events/hr = bot)
// 2. Position diversity (>12 simultaneous positions = MM)
// 3. Known MM addresses/names

const BOT_WINDOW_MS = 60 * 60 * 1000; // 1 hour window
const BOT_EVENT_THRESHOLD = 3;         // >=3 events/hr = likely bot/MM (was 4)
const addressEventTimes = new Map<string, number[]>();  // address → timestamps
const knownBots = new Set<string>(); // addresses flagged as bots

// Addresses with too many simultaneous positions (detected at runtime)
const mmByDiversity = new Set<string>();
const MM_DIVERSITY_THRESHOLD = 8; // >=8 simultaneous positions = MM (was 12)

// Known market makers — match against display name (from leaderboard) or generated name
const KNOWN_MM_PATTERNS = [
  "wintermute", "cumberland", "jump", "flowtraders", "dvchain", "gsr",
  "alameda", "auros", "bobbybigsize", "hummingbot", "amber",
  "galaxy", "b2c2", "genesis", "virtu", "citadel", "jane street",
  "folkvang", "mgnr", "qcp", "tower", "dv trading", "optiver",
  "susquehanna", "sig", "drw", "old mission", "pattern",
];

function isKnownMM(name: string): boolean {
  const lower = name.toLowerCase();
  return KNOWN_MM_PATTERNS.some(mm => lower.includes(mm));
}

function isLikelyBot(address: string): boolean {
  const addr = address.toLowerCase();
  if (knownBots.has(addr)) return true;
  if (mmByDiversity.has(addr)) return true;

  const times = addressEventTimes.get(addr) || [];
  const now = Date.now();

  // Clean old timestamps
  const recent = times.filter(t => now - t < BOT_WINDOW_MS);
  addressEventTimes.set(addr, recent);

  if (recent.length >= BOT_EVENT_THRESHOLD) {
    knownBots.add(addr);
    console.log(`[whale-tracker] Flagged bot (frequency): ${address} (${recent.length} events/hr)`);
    return true;
  }
  return false;
}

/** Flag addresses with too many positions as MMs (called during position scan) */
function checkPositionDiversity(address: string, positionCount: number) {
  if (positionCount >= MM_DIVERSITY_THRESHOLD) {
    const addr = address.toLowerCase();
    if (!mmByDiversity.has(addr)) {
      mmByDiversity.add(addr);
      console.log(`[whale-tracker] Flagged MM (${positionCount} positions): ${address}`);
    }
  }
}

// Track coins per address in a short window — multi-asset changes = systematic/bot
const addressCoinBurst = new Map<string, Set<string>>();
let lastBurstReset = Date.now();
const BURST_WINDOW_MS = 5 * 60_000; // 5 min window
const BURST_COIN_THRESHOLD = 4;     // >=4 different coins in 5 min = bot

function trackEventFrequency(address: string, coin?: string) {
  const addr = address.toLowerCase();
  const times = addressEventTimes.get(addr) || [];
  times.push(Date.now());
  addressEventTimes.set(addr, times);

  // Track coin diversity burst
  if (coin) {
    const now = Date.now();
    if (now - lastBurstReset > BURST_WINDOW_MS) {
      addressCoinBurst.clear();
      lastBurstReset = now;
    }
    const coins = addressCoinBurst.get(addr) || new Set();
    coins.add(coin);
    addressCoinBurst.set(addr, coins);
    if (coins.size >= BURST_COIN_THRESHOLD) {
      knownBots.add(addr);
      console.log(`[whale-tracker] Flagged bot (${coins.size} coins in 5min): ${address}`);
    }
  }
}

function addEvent(event: Omit<WhaleEvent, "id" | "detectedAt">, skipBotCheck = false) {
  // Skip small position changes — minimum $500K position value for whale alerts
  if (Math.abs(event.positionValueUsd) < 500_000) return;

  // Skip known market makers by name pattern
  if (isKnownMM(event.whaleName)) return;

  // Track frequency and skip if likely market maker bot (skip during seed run)
  if (!skipBotCheck) {
    trackEventFrequency(event.whaleAddress, event.coin);
    if (isLikelyBot(event.whaleAddress)) return;
  }

  eventCounter++;
  const now = Date.now();
  events.unshift({
    ...event,
    id: `we_${eventCounter}`,
    detectedAt: now,
  });

  // Cap in-memory at MAX_EVENTS
  if (events.length > MAX_EVENTS) {
    events.length = MAX_EVENTS;
  }

  // Persist to DB (fire-and-forget) — skip seed events and if DB circuit breaker tripped
  if (db && dbFailCount < DB_FAIL_THRESHOLD && !skipBotCheck) {
    db.insert(whaleEvents).values({
      whaleAddress: event.whaleAddress,
      whaleName: event.whaleName,
      accountValue: String(event.accountValue),
      coin: event.coin,
      eventType: event.eventType,
      oldSize: String(event.oldSize),
      newSize: String(event.newSize),
      positionValueUsd: String(event.positionValueUsd),
      price: String(event.price),
      detectedAt: new Date(now),
    }).catch((err) => {
      dbFailCount++;
      if (dbFailCount === DB_FAIL_THRESHOLD) {
        console.error("[whale-tracker] DB insert failed 5 times, switching to in-memory only");
      }
    });
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function getWhaleAlerts(limit = 50, coin?: string): WhaleEvent[] {
  let filtered = events;
  if (coin) {
    filtered = events.filter(e => e.coin === coin);
  }
  return filtered.slice(0, limit);
}

export function getWhaleAlertsForCoin(coin: string, limit = 20): WhaleEvent[] {
  return events.filter(e => e.coin === coin).slice(0, limit);
}

export function getHotTokens(limit = 10): { coin: string; eventCount: number; lastEvent: WhaleEvent }[] {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recentEvents = events.filter(e => e.detectedAt > oneHourAgo);

  const coinCounts = new Map<string, { count: number; lastEvent: WhaleEvent }>();
  for (const event of recentEvents) {
    const existing = coinCounts.get(event.coin);
    if (!existing) {
      coinCounts.set(event.coin, { count: 1, lastEvent: event });
    } else {
      existing.count++;
    }
  }

  return [...coinCounts.entries()]
    .map(([coin, { count, lastEvent }]) => ({ coin, eventCount: count, lastEvent }))
    .sort((a, b) => b.eventCount - a.eventCount)
    .slice(0, limit);
}

export function getWhaleEventCount(): number {
  return events.length;
}

// ─── Historical whale events from DB (for chart markers) ────────────────────

import { desc, eq, and, gte, gt } from "drizzle-orm";

/** Min position value thresholds per interval — only show meaningful whale activity */
const INTERVAL_THRESHOLDS: Record<string, number> = {
  "5m": 25_000,      // $25K+
  "15m": 50_000,     // $50K+
  "1h": 100_000,     // $100K+
  "4h": 250_000,     // $250K+
  "1d": 500_000,     // $500K+
  "1w": 1_000_000,   // $1M+
  "1M": 2_000_000,   // $2M+
};

/** Max markers per candle to prevent visual clutter */
const MAX_PER_CANDLE: Record<string, number> = {
  "5m": 3,
  "15m": 3,
  "1h": 3,
  "4h": 3,
  "1d": 5,
};

/**
 * Get historical whale events for chart markers.
 * Filters by size threshold based on timeframe to prevent clutter.
 */
// Circuit breaker: stop querying DB after repeated failures
let dbFailCount = 0;
const DB_FAIL_THRESHOLD = 5; // disable DB after 5 consecutive failures

export async function getHistoricalWhaleEvents(
  coin: string,
  interval: string,
  since: number, // timestamp ms — start of visible candle range
): Promise<WhaleEvent[]> {
  if (!db || dbFailCount >= DB_FAIL_THRESHOLD) {
    // Fallback to in-memory events
    return events.filter(e => e.coin === coin && e.detectedAt >= since);
  }

  const threshold = INTERVAL_THRESHOLDS[interval] || 50_000;
  const maxPerCandle = MAX_PER_CANDLE[interval] || 3;

  try {
    const rows = await db.select()
      .from(whaleEvents)
      .where(
        and(
          eq(whaleEvents.coin, coin),
          gte(whaleEvents.detectedAt, new Date(since)),
          gt(whaleEvents.positionValueUsd, String(threshold))
        )
      )
      .orderBy(desc(whaleEvents.detectedAt))
      .limit(500);

    // Convert DB rows to WhaleEvent format
    const result: WhaleEvent[] = rows.map((r, i) => ({
      id: r.id,
      whaleAddress: r.whaleAddress,
      whaleName: r.whaleName,
      accountValue: Number(r.accountValue) || 0,
      coin: r.coin,
      eventType: r.eventType as WhaleEvent["eventType"],
      oldSize: Number(r.oldSize) || 0,
      newSize: Number(r.newSize) || 0,
      positionValueUsd: Number(r.positionValueUsd) || 0,
      price: Number(r.price) || 0,
      detectedAt: r.detectedAt.getTime(),
    }));

    // Group by candle time bucket and limit per bucket
    const intervalMs = getIntervalMs(interval);
    const buckets = new Map<number, WhaleEvent[]>();
    for (const evt of result) {
      const bucket = Math.floor(evt.detectedAt / intervalMs) * intervalMs;
      const arr = buckets.get(bucket) || [];
      arr.push(evt);
      buckets.set(bucket, arr);
    }

    // Take top N per bucket (by position value)
    const filtered: WhaleEvent[] = [];
    for (const [, evts] of buckets) {
      evts.sort((a, b) => Math.abs(b.positionValueUsd) - Math.abs(a.positionValueUsd));
      filtered.push(...evts.slice(0, maxPerCandle));
    }

    dbFailCount = 0; // reset on success
    return filtered;
  } catch (err) {
    dbFailCount++;
    if (dbFailCount === DB_FAIL_THRESHOLD) {
      console.error("[whale-tracker] DB failed 5 times, switching to in-memory only");
    } else {
      console.error("[whale-tracker] DB query failed:", (err as Error).message);
    }
    return events.filter(e => e.coin === coin && e.detectedAt >= since);
  }
}

function getIntervalMs(interval: string): number {
  switch (interval) {
    case "5m": return 5 * 60_000;
    case "15m": return 15 * 60_000;
    case "1h": return 60 * 60_000;
    case "4h": return 4 * 60 * 60_000;
    case "1d": return 24 * 60 * 60_000;
    default: return 60 * 60_000;
  }
}
