/**
 * Cached market data service — prices, metadata, asset contexts.
 * All data stored in-memory with TTL-based expiry.
 */

import {
  getAllMids,
  getMeta,
  getMetaAndAssetCtxs,
  getSpotMetaAndAssetCtxs,
  getHip3MetaAndAssetCtxs,
  HIP3_DEXES,
  type Hip3Dex,
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
let spotCache: Cache<{ name: string; pair: string; price: number; prevDayPx: number; volume24h: number }[]> | null = null;
let hip3Cache: Cache<Hip3Token[]> | null = null;

const MIDS_TTL = 15_000; // 15 seconds (was 5s — reduces upstream calls 3x)
const META_TTL = 60 * 60 * 1000; // 1 hour
const ASSET_CTX_TTL = 30_000; // 30 seconds (was 10s — reduces upstream calls 3x)
const SPOT_TTL = 60_000; // 60 seconds (was 30s)
const HIP3_TTL = 60_000; // 60 seconds (refreshed by background job)

// ─── In-flight request deduplication ────────────────────────────────────────
// Prevents thundering herd: if 100 users hit the API at once and cache expires,
// only ONE upstream request is made. All others await the same promise.
const inFlight = new Map<string, Promise<unknown>>();

function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const promise = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

export interface Hip3Token {
  coin: string;       // e.g. "xyz:GOLD"
  baseName: string;   // e.g. "GOLD"
  dex: Hip3Dex;       // e.g. "xyz"
  price: number;
  prevDayPx: number;
  volume24h: number;
  openInterest: number;
  fundingRate: number;
  markPx: number;
  oraclePx: number;
  maxLeverage: number;
  category: "stocks" | "indices" | "commodities" | "fx" | "pre-ipo" | "sectors" | "crypto";
}

// ─── Cached getters ──────────────────────────────────────────────────────────

export async function getCachedMids(): Promise<Record<string, number>> {
  if (midsCache && Date.now() - midsCache.fetchedAt < MIDS_TTL) {
    return midsCache.data;
  }
  return dedupe("mids", async () => {
    const raw = await getAllMids();
    const parsed: Record<string, number> = {};
    for (const [coin, px] of Object.entries(raw)) {
      parsed[coin] = parseFloat(px as string);
    }
    midsCache = { data: parsed, fetchedAt: Date.now() };
    return parsed;
  });
}

export async function getCachedMeta() {
  if (metaCache && Date.now() - metaCache.fetchedAt < META_TTL) {
    return metaCache.data;
  }
  return dedupe("meta", async () => {
    const raw = await getMeta() as { universe: { name: string; szDecimals: number; maxLeverage: number }[] };
    metaCache = { data: raw, fetchedAt: Date.now() };
    return raw;
  });
}

export async function getCachedAssetCtxs(): Promise<Map<string, AssetCtx & { coin: string }>> {
  if (assetCtxCache && Date.now() - assetCtxCache.fetchedAt < ASSET_CTX_TTL) {
    return assetCtxCache.data;
  }
  return dedupe("assetCtxs", async () => {
    const [metaData, ctxs] = await getMetaAndAssetCtxs();
    const meta = metaData as { universe: { name: string }[] };
    const map = new Map<string, AssetCtx & { coin: string }>();

    for (let i = 0; i < meta.universe.length && i < ctxs.length; i++) {
      const coin = meta.universe[i].name;
      map.set(coin, { ...ctxs[i], coin });
    }

    assetCtxCache = { data: map, fetchedAt: Date.now() };
    return map;
  });
}

// ─── Spot data ──────────────────────────────────────────────────────────────

export async function getCachedSpotTokens() {
  if (spotCache && Date.now() - spotCache.fetchedAt < SPOT_TTL) {
    return spotCache.data;
  }
  return dedupe("spot", async () => {
  try {
    const [meta, ctxs] = await getSpotMetaAndAssetCtxs();
    const idxToName: Record<number, string> = {};
    for (const t of meta.tokens) {
      idxToName[t.index] = t.name;
    }

    const results: { name: string; pair: string; price: number; prevDayPx: number; volume24h: number }[] = [];
    for (let i = 0; i < meta.universe.length && i < ctxs.length; i++) {
      const u = meta.universe[i];
      const ctx = ctxs[i];
      const pairName = u.name; // e.g. "PURR/USDC" or "@88"
      let displayName: string;
      if (pairName.startsWith("@")) {
        const idx = parseInt(pairName.slice(1));
        displayName = idxToName[idx] || pairName;
      } else {
        displayName = pairName.split("/")[0];
      }
      const price = parseFloat(ctx.midPx || "0");
      const prevDayPx = parseFloat(ctx.prevDayPx || "0");
      const volume = parseFloat(ctx.dayNtlVlm || "0");
      if (price > 0 && volume > 0) {
        results.push({ name: displayName, pair: pairName, price, prevDayPx, volume24h: volume });
      }
    }
    results.sort((a, b) => b.volume24h - a.volume24h);
    spotCache = { data: results, fetchedAt: Date.now() };
    return results;
  } catch {
    return spotCache?.data || [];
  }
  }); // dedupe
}

/**
 * Resolve a display name (e.g. "WATER") to the Hyperliquid API identifier
 * (e.g. "@155" for spot pairs). Returns the input unchanged if no mapping found.
 */
export function resolveSpotName(displayName: string): string {
  const spots = spotCache?.data;
  if (!spots) return displayName;
  const match = spots.find(s => s.name === displayName);
  return match ? match.pair : displayName;
}

/**
 * Resolve a raw pair (e.g. "@155") to its display name (e.g. "WATER").
 * Returns the input unchanged if no mapping found.
 */
export function resolveSpotPair(pair: string): string {
  const spots = spotCache?.data;
  if (!spots) return pair;
  const match = spots.find(s => s.pair === pair);
  return match ? match.name : pair;
}

// ─── HIP-3 Builder Perps ────────────────────────────────────────────────────

// Categorize HIP-3 assets by name
const STOCK_NAMES = new Set(["TSLA", "NVDA", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "NFLX", "AMD", "MU", "INTC", "PLTR", "COIN", "HOOD", "MSTR", "BABA", "ORCL", "COST", "LLY", "TSM", "RIVN", "SNDK", "SKHX", "CRCL", "RTX", "EWY", "KWEB", "BMNR"]);
const INDEX_NAMES = new Set(["XYZ100", "SP500", "USA500", "USA100", "US500", "USTECH", "SMALL2000", "JPN225", "MAG7"]);
const COMMODITY_NAMES = new Set(["GOLD", "SILVER", "CL", "OIL", "BRENTOIL", "WTI", "USOIL", "COPPER", "NATGAS", "GAS", "PALLADIUM", "PLATINUM", "GLDMINE"]);
const FX_NAMES = new Set(["EUR", "JPY"]);
const PREIPO_NAMES = new Set(["SPACEX", "OPENAI", "ANTHROPIC"]);
const SECTOR_NAMES = new Set(["SEMIS", "SEMI", "ROBOT", "INFOTECH", "NUCLEAR", "DEFENSE", "ENERGY", "USENERGY", "BIOTECH", "USBOND"]);

function categorizeHip3(name: string): Hip3Token["category"] {
  if (STOCK_NAMES.has(name)) return "stocks";
  if (INDEX_NAMES.has(name)) return "indices";
  if (COMMODITY_NAMES.has(name)) return "commodities";
  if (FX_NAMES.has(name)) return "fx";
  if (PREIPO_NAMES.has(name)) return "pre-ipo";
  if (SECTOR_NAMES.has(name)) return "sectors";
  return "crypto"; // hyna has crypto duplicates
}

export async function getCachedHip3Tokens(): Promise<Hip3Token[]> {
  if (hip3Cache && Date.now() - hip3Cache.fetchedAt < HIP3_TTL) {
    return hip3Cache.data;
  }
  return dedupe("hip3", async () => {
  try {
    // Fetch DEXes sequentially with delays to avoid 429s
    const dexResults: { dex: Hip3Dex; meta: { universe: { name: string; szDecimals: number; maxLeverage: number }[] }; ctxs: AssetCtx[] }[] = [];
    for (const dex of HIP3_DEXES) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const [meta, ctxs] = await getHip3MetaAndAssetCtxs(dex);
          console.log(`[hip3] ${dex}: ${meta.universe.length} assets`);
          dexResults.push({ dex, meta, ctxs });
          break;
        } catch (e) {
          if (attempt < 2 && (e as Error).message?.includes("429")) {
            await new Promise(r => setTimeout(r, 5000 * (attempt + 1))); // exponential backoff
            continue;
          }
          console.warn(`[hip3] ${dex} failed:`, (e as Error).message);
          dexResults.push({ dex, meta: { universe: [] }, ctxs: [] });
          break;
        }
      }
      await new Promise(r => setTimeout(r, 2000)); // 2s between DEXes
    }

    // Collect all tokens, keyed by baseName → pick highest volume
    const bestByName = new Map<string, Hip3Token>();

    for (const { dex, meta, ctxs } of dexResults) {
      for (let i = 0; i < meta.universe.length && i < ctxs.length; i++) {
        const u = meta.universe[i];
        const ctx = ctxs[i];
        const fullName = u.name; // e.g. "xyz:GOLD" — API includes dex prefix
        const baseName = fullName.includes(":") ? fullName.split(":")[1] : fullName;
        const price = parseFloat(ctx.midPx || "0");
        const volume24h = parseFloat(ctx.dayNtlVlm || "0");

        if (price <= 0) continue; // skip dead markets

        const token: Hip3Token = {
          coin: fullName, // use the full name as-is (xyz:GOLD)
          baseName,
          dex,
          price,
          prevDayPx: parseFloat(ctx.prevDayPx || "0"),
          volume24h,
          openInterest: parseFloat(ctx.openInterest || "0") * price,
          fundingRate: parseFloat(ctx.funding || "0"),
          markPx: parseFloat(ctx.markPx || "0"),
          oraclePx: parseFloat(ctx.oraclePx || "0"),
          maxLeverage: u.maxLeverage || 10,
          category: categorizeHip3(baseName),
        };

        const existing = bestByName.get(baseName);
        if (!existing || volume24h > existing.volume24h) {
          bestByName.set(baseName, token);
        }
      }
    }

    const results = Array.from(bestByName.values())
      .filter(t => t.category !== "crypto") // skip crypto duplicates (hyna:BTC etc)
      .sort((a, b) => b.volume24h - a.volume24h);

    hip3Cache = { data: results, fetchedAt: Date.now() };
    return results;
  } catch {
    return hip3Cache?.data || [];
  }
  }); // dedupe
}

// ─── Derived data ────────────────────────────────────────────────────────────

export interface TokenOverview {
  coin: string;
  displayName?: string; // resolved name for spot tokens (e.g. "HYPE" instead of "@109")
  price: number;
  prevDayPx: number;
  change24h: number; // percentage
  volume24h: number;
  openInterest: number;
  fundingRate: number;
  markPx: number;
  oraclePx: number;
  premium: number; // mark vs oracle difference %
  maxLeverage: number; // per-asset max leverage from HL meta
  isSpot?: boolean; // true for spot tokens
  dex?: string; // HIP-3 builder dex (xyz, flx, etc.) — undefined for core perps
  category?: string; // stocks, indices, commodities, fx, pre-ipo, sectors
}

export async function getTokenOverviews(): Promise<TokenOverview[]> {
  // Fetch core perps + spot first, then HIP-3 (to avoid 429 rate limits)
  const [mids, ctxs, meta, spotTokens] = await Promise.all([
    getCachedMids(),
    getCachedAssetCtxs(),
    getCachedMeta(),
    getCachedSpotTokens().catch(() => []),
  ]);
  // HIP-3: use cached data only (background job populates cache).
  // Never block request path with sequential DEX fetches.
  const hip3Tokens = hip3Cache?.data || [];
  const results: TokenOverview[] = [];

  // Build maxLeverage lookup from meta
  const leverageMap = new Map<string, number>();
  for (const u of meta.universe) {
    leverageMap.set(u.name, u.maxLeverage);
  }

  // Perps
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
      openInterest: parseFloat(ctx.openInterest || "0") * price,
      fundingRate: parseFloat(ctx.funding || "0"),
      markPx,
      oraclePx,
      premium: oraclePx > 0 ? ((markPx - oraclePx) / oraclePx) * 100 : 0,
      maxLeverage: leverageMap.get(coin) || 50,
    });
  }

  // Spot — add top spot tokens (by volume, skip duplicates with perps)
  const perpCoins = new Set(results.map(r => r.coin));
  for (const st of spotTokens.slice(0, 50)) {
    if (perpCoins.has(st.name)) continue; // skip if perp already exists
    const change24h = st.prevDayPx > 0 ? ((st.price - st.prevDayPx) / st.prevDayPx) * 100 : 0;
    results.push({
      coin: st.pair, // use pair name (@88, PURR/USDC) for API calls
      displayName: st.name, // resolved name (e.g. "HYPE" instead of "@109")
      price: st.price,
      prevDayPx: st.prevDayPx,
      change24h,
      volume24h: st.volume24h,
      openInterest: 0,
      fundingRate: 0,
      markPx: st.price,
      oraclePx: st.price,
      premium: 0,
      maxLeverage: 1, // spot tokens have no leverage
      isSpot: true,
    });
  }

  // HIP-3 builder perps (tradfi, stocks, indices, etc.)
  const allCoins = new Set(results.map(r => r.coin));
  for (const ht of hip3Tokens) {
    if (allCoins.has(ht.coin)) continue;
    const change24h = ht.prevDayPx > 0 ? ((ht.price - ht.prevDayPx) / ht.prevDayPx) * 100 : 0;
    results.push({
      coin: ht.coin,
      price: ht.price,
      prevDayPx: ht.prevDayPx,
      change24h,
      volume24h: ht.volume24h,
      openInterest: ht.openInterest,
      fundingRate: ht.fundingRate,
      markPx: ht.markPx,
      oraclePx: ht.oraclePx,
      premium: ht.oraclePx > 0 ? ((ht.markPx - ht.oraclePx) / ht.oraclePx) * 100 : 0,
      maxLeverage: ht.maxLeverage,
      dex: ht.dex,
      category: ht.category,
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
