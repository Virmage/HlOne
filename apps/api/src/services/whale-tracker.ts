/**
 * Whale tracker — monitors top accounts for position changes.
 * Stores events in-memory (capped at 500).
 */

import { discoverActiveTraders, getClearinghouseState, type HLPosition } from "./hyperliquid.js";
import { getTraderDisplayName } from "./name-generator.js";
import { getCachedMids } from "./market-data.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WhaleEvent {
  id: string;
  whaleAddress: string;
  whaleName: string;
  accountValue: number;
  coin: string;
  eventType: "open_long" | "open_short" | "close_long" | "close_short" | "increase" | "decrease" | "flip";
  oldSize: number;
  newSize: number;
  positionValueUsd: number;
  price: number;
  detectedAt: number; // timestamp ms
}

// ─── State ───────────────────────────────────────────────────────────────────

const MAX_EVENTS = 500;
const events: WhaleEvent[] = [];
let previousPositions = new Map<string, Map<string, { size: number; side: string }>>();
let eventCounter = 0;
let isRunning = false;

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

          // Compare with previous
          const prevMap = previousPositions.get(whale.address.toLowerCase()) || new Map();
          const name = getTraderDisplayName(whale.address, whale.displayName);

          // Check for new positions (in current but not in previous)
          for (const [coin, curr] of currentMap) {
            const prev = prevMap.get(coin);
            const price = mids[coin] || 0;
            const posValue = Math.abs(curr.size) * price;

            if (!prev) {
              // New position opened
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
                  eventType: Math.abs(curr.size) > Math.abs(prev.size) ? "increase" : "decrease",
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
  } finally {
    isRunning = false;
  }
}

function addEvent(event: Omit<WhaleEvent, "id" | "detectedAt">) {
  eventCounter++;
  events.unshift({
    ...event,
    id: `we_${eventCounter}`,
    detectedAt: Date.now(),
  });

  // Cap at MAX_EVENTS
  if (events.length > MAX_EVENTS) {
    events.length = MAX_EVENTS;
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
