/**
 * Cached market data service — prices, metadata, asset contexts.
 * All data stored in-memory with TTL-based expiry.
 */

import {
  getAllMids,
  getMeta,
  getMetaAndAssetCtxs,
  getL2Book,
  type AssetCtx,
  type BookLevel,
} from "./hyperliquid.js";

// ─── Caches ──────────────────────────────────────────────────────────────────

interface Cache<T> {
  data: T;
  fetchedAt: number;
}

let midsCache: Cache<Record<string, number>> | null = null;
let metaCache: Cache<{ universe: { name: string; szDecimals: number; maxLeverage: number }[] }> | null = null;
let assetCtxCache: Cache<Map<string, AssetCtx & { coin: string }>> | null = null;

const MIDS_TTL = 5_000; // 5 seconds
const META_TTL = 60 * 60 * 1000; // 1 hour
const ASSET_CTX_TTL = 10_000; // 10 seconds

// ─── Cached getters ──────────────────────────────────────────────────────────

export async function getCachedMids(): Promise<Record<string, number>> {
  if (midsCache && Date.now() - midsCache.fetchedAt < MIDS_TTL) {
    return midsCache.data;
  }
  const raw = await getAllMids();
  const parsed: Record<string, number> = {};
  for (const [coin, px] of Object.entries(raw)) {
    parsed[coin] = parseFloat(px as string);
  }
  midsCache = { data: parsed, fetchedAt: Date.now() };
  return parsed;
}

export async function getCachedMeta() {
  if (metaCache && Date.now() - metaCache.fetchedAt < META_TTL) {
    return metaCache.data;
  }
  const raw = await getMeta() as { universe: { name: string; szDecimals: number; maxLeverage: number }[] };
  metaCache = { data: raw, fetchedAt: Date.now() };
  return raw;
}

export async function getCachedAssetCtxs(): Promise<Map<string, AssetCtx & { coin: string }>> {
  if (assetCtxCache && Date.now() - assetCtxCache.fetchedAt < ASSET_CTX_TTL) {
    return assetCtxCache.data;
  }
  const [metaData, ctxs] = await getMetaAndAssetCtxs();
  const meta = metaData as { universe: { name: string }[] };
  const map = new Map<string, AssetCtx & { coin: string }>();

  for (let i = 0; i < meta.universe.length && i < ctxs.length; i++) {
    const coin = meta.universe[i].name;
    map.set(coin, { ...ctxs[i], coin });
  }

  assetCtxCache = { data: map, fetchedAt: Date.now() };
  return map;
}

// ─── Derived data ────────────────────────────────────────────────────────────

export interface TokenOverview {
  coin: string;
  price: number;
  prevDayPx: number;
  change24h: number; // percentage
  volume24h: number;
  openInterest: number;
  fundingRate: number;
  markPx: number;
  oraclePx: number;
  premium: number; // mark vs oracle difference %
}

export async function getTokenOverviews(): Promise<TokenOverview[]> {
  const [mids, ctxs] = await Promise.all([getCachedMids(), getCachedAssetCtxs()]);
  const results: TokenOverview[] = [];

  for (const [coin, ctx] of ctxs) {
    const price = mids[coin] || parseFloat(ctx.midPx || "0");
    const prevDayPx = parseFloat(ctx.prevDayPx || "0");
    const change24h = prevDayPx > 0 ? ((price - prevDayPx) / prevDayPx) * 100 : 0;
    const markPx = parseFloat(ctx.markPx || "0");
    const oraclePx = parseFloat(ctx.oraclePx || "0");

    results.push({
      coin,
      price,
      prevDayPx,
      change24h,
      volume24h: parseFloat(ctx.dayNtlVlm || "0"),
      openInterest: parseFloat(ctx.openInterest || "0") * price, // Convert from coin units to USD
      fundingRate: parseFloat(ctx.funding || "0"),
      markPx,
      oraclePx,
      premium: oraclePx > 0 ? ((markPx - oraclePx) / oraclePx) * 100 : 0,
    });
  }

  // Sort by volume descending
  results.sort((a, b) => b.volume24h - a.volume24h);
  return results;
}

// ─── Book analysis ───────────────────────────────────────────────────────────

export interface BookAnalysis {
  coin: string;
  bidDepth: number; // total bid volume
  askDepth: number; // total ask volume
  imbalance: number; // bid/ask ratio (>1 = buy pressure)
  spread: number; // best ask - best bid
  spreadBps: number; // spread in basis points
  walls: BookWall[];
  levels: { bids: BookLevel[]; asks: BookLevel[] };
}

export interface BookWall {
  side: "bid" | "ask";
  price: number;
  size: number;
  multiplier: number; // how many times larger than average level
}

export async function analyzeBook(coin: string): Promise<BookAnalysis> {
  const book = await getL2Book(coin);
  const [bids, asks] = book.levels;

  let bidDepth = 0;
  let askDepth = 0;
  const allSizes: number[] = [];

  for (const level of bids) {
    const sz = parseFloat(level.sz);
    bidDepth += sz;
    allSizes.push(sz);
  }
  for (const level of asks) {
    const sz = parseFloat(level.sz);
    askDepth += sz;
    allSizes.push(sz);
  }

  const avgSize = allSizes.length > 0 ? allSizes.reduce((a, b) => a + b, 0) / allSizes.length : 0;
  const wallThreshold = avgSize * 5; // 5x average = wall

  const walls: BookWall[] = [];
  for (const level of bids) {
    const sz = parseFloat(level.sz);
    if (sz >= wallThreshold && avgSize > 0) {
      walls.push({ side: "bid", price: parseFloat(level.px), size: sz, multiplier: sz / avgSize });
    }
  }
  for (const level of asks) {
    const sz = parseFloat(level.sz);
    if (sz >= wallThreshold && avgSize > 0) {
      walls.push({ side: "ask", price: parseFloat(level.px), size: sz, multiplier: sz / avgSize });
    }
  }

  const bestBid = bids.length > 0 ? parseFloat(bids[0].px) : 0;
  const bestAsk = asks.length > 0 ? parseFloat(asks[0].px) : 0;
  const midPrice = (bestBid + bestAsk) / 2;

  return {
    coin,
    bidDepth,
    askDepth,
    imbalance: askDepth > 0 ? bidDepth / askDepth : 0,
    spread: bestAsk - bestBid,
    spreadBps: midPrice > 0 ? ((bestAsk - bestBid) / midPrice) * 10000 : 0,
    walls,
    levels: { bids, asks },
  };
}
