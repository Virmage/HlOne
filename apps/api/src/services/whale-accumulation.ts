/**
 * Whale Accumulation Trend — tracks net whale positioning changes over time.
 * Aggregates whale events to show whether whales are net accumulating or distributing
 * each coin over 1h / 24h / 7d windows.
 */

import { getWhaleAlerts, type WhaleEvent } from "./whale-tracker.js";

export interface WhaleAccumulation {
  coin: string;
  /** Net USD flow (positive = accumulating long, negative = distributing / adding shorts) */
  net1h: number;
  net24h: number;
  net7d: number;
  /** Number of distinct whales active in each window */
  whales1h: number;
  whales24h: number;
  whales7d: number;
  /** Dominant direction in 24h */
  trend: "accumulating" | "distributing" | "neutral";
  /** Strength 0-100 */
  strength: number;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

let cache: { data: WhaleAccumulation[]; at: number } | null = null;
const CACHE_TTL = 30_000; // 30s

function eventToNetUsd(e: WhaleEvent): number {
  const size = Math.abs(e.positionValueUsd);
  switch (e.eventType) {
    case "open_long":
    case "added":
      return e.newSize > 0 ? size : -size; // added to long = positive, added to short = negative
    case "open_short":
      return -size;
    case "close_long":
      return -size; // closing long = removing bullish exposure
    case "close_short":
      return size; // closing short = removing bearish exposure
    case "flip":
      return e.newSize > 0 ? size * 2 : -size * 2; // double impact
    case "trimmed":
      return e.newSize > 0 ? -size * 0.5 : size * 0.5; // partial reduction
    default:
      return 0;
  }
}

export function getWhaleAccumulation(): WhaleAccumulation[] {
  if (cache && Date.now() - cache.at < CACHE_TTL) return cache.data;

  const now = Date.now();
  const allEvents = getWhaleAlerts(1000); // get all in-memory events

  // Bucket events by coin and time window
  const coinData = new Map<string, {
    net1h: number; net24h: number; net7d: number;
    whales1h: Set<string>; whales24h: Set<string>; whales7d: Set<string>;
  }>();

  for (const e of allEvents) {
    const age = now - e.detectedAt;
    if (age > WEEK) continue;

    const d = coinData.get(e.coin) || {
      net1h: 0, net24h: 0, net7d: 0,
      whales1h: new Set(), whales24h: new Set(), whales7d: new Set(),
    };

    const net = eventToNetUsd(e);
    d.net7d += net;
    d.whales7d.add(e.whaleAddress);

    if (age <= DAY) {
      d.net24h += net;
      d.whales24h.add(e.whaleAddress);
    }
    if (age <= HOUR) {
      d.net1h += net;
      d.whales1h.add(e.whaleAddress);
    }

    coinData.set(e.coin, d);
  }

  const result: WhaleAccumulation[] = [];
  for (const [coin, d] of coinData) {
    // Determine trend from 24h net flow
    const absNet = Math.abs(d.net24h);
    const trend: WhaleAccumulation["trend"] =
      absNet < 50_000 ? "neutral" :
      d.net24h > 0 ? "accumulating" : "distributing";

    // Strength: blend of magnitude + whale count + consistency across windows
    const magScore = Math.min(1, Math.log10(absNet + 1) / 7); // $10M = 1.0
    const countScore = Math.min(1, d.whales24h.size / 10); // 10 whales = 1.0
    // Consistency: do 1h and 7d agree with 24h direction?
    const sign24 = Math.sign(d.net24h);
    const consistency = (
      (Math.sign(d.net1h) === sign24 || d.net1h === 0 ? 0.5 : 0) +
      (Math.sign(d.net7d) === sign24 || d.net7d === 0 ? 0.5 : 0)
    );
    const strength = Math.round((magScore * 0.4 + countScore * 0.3 + consistency * 0.3) * 100);

    result.push({
      coin,
      net1h: Math.round(d.net1h),
      net24h: Math.round(d.net24h),
      net7d: Math.round(d.net7d),
      whales1h: d.whales1h.size,
      whales24h: d.whales24h.size,
      whales7d: d.whales7d.size,
      trend,
      strength,
    });
  }

  // Sort by absolute 24h flow descending
  result.sort((a, b) => Math.abs(b.net24h) - Math.abs(a.net24h));

  cache = { data: result, at: now };
  return result;
}
