/**
 * Hyperliquid API service — wraps REST + WebSocket calls.
 * Using direct fetch instead of SDK for full control over error handling.
 */

const HL_API = "https://api.hyperliquid.xyz";
const HL_WS = "wss://api.hyperliquid.xyz/ws";

// ─── Info endpoint helpers ───────────────────────────────────────────────────

async function infoRequest(body: Record<string, unknown>) {
  const res = await fetch(`${HL_API}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HL API error: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Get full account state: positions, margin, account value */
export async function getClearinghouseState(address: string) {
  return infoRequest({ type: "clearinghouseState", user: address });
}

/** Get historical performance (day/week/month/allTime buckets) */
export async function getPortfolio(address: string) {
  return infoRequest({ type: "portfolio", user: address });
}

/** Get user's recent fills */
export async function getUserFills(address: string, limit = 100) {
  return infoRequest({
    type: "userFills",
    user: address,
    aggregateByTime: false,
  });
}

/** Get user's fills within a time range (more complete than userFills) */
export async function getUserFillsByTime(address: string, startTime: number, endTime?: number) {
  return infoRequest({
    type: "userFillsByTime",
    user: address,
    startTime,
    ...(endTime ? { endTime } : {}),
  });
}

/** Get all open orders */
export async function getOpenOrders(address: string) {
  return infoRequest({ type: "openOrders", user: address });
}

/** Get asset metadata (names, decimals, etc.) */
export async function getMeta() {
  return infoRequest({ type: "meta" });
}

/** Get all mid prices */
export async function getAllMids(): Promise<Record<string, string>> {
  return infoRequest({ type: "allMids" });
}

/** Get perpetual metadata + live asset contexts (OI, funding, mark/oracle prices, 24h volume) */
export async function getMetaAndAssetCtxs(): Promise<[unknown, AssetCtx[]]> {
  return infoRequest({ type: "metaAndAssetCtxs" });
}

/** Get L2 order book (20 levels per side) */
export async function getL2Book(coin: string, nSigFigs?: number): Promise<{ levels: [BookLevel[], BookLevel[]] }> {
  return infoRequest({ type: "l2Book", coin, ...(nSigFigs ? { nSigFigs } : {}) });
}

/** Get funding rate history for a coin */
export async function getFundingHistory(coin: string, startTime: number, endTime?: number): Promise<FundingEntry[]> {
  return infoRequest({ type: "fundingHistory", coin, startTime, ...(endTime ? { endTime } : {}) });
}

/** Get OHLCV candle data (max 5000 candles) */
// Server-side candle cache — avoids hitting HL API on every interval switch
const candleCache = new Map<string, { data: Candle[]; time: number }>();
const CANDLE_TTL: Record<string, number> = {
  "5m": 10_000,   // 10s for fast intervals
  "15m": 15_000,
  "1h": 30_000,   // 30s for hourly
  "4h": 60_000,   // 1min for 4h
  "1d": 120_000,  // 2min for daily+
  "1w": 300_000,
  "1M": 300_000,
};

export async function getCandleSnapshot(coin: string, interval: string, startTime: number, endTime?: number): Promise<Candle[]> {
  const key = `${coin}:${interval}`;
  const cached = candleCache.get(key);
  const ttl = CANDLE_TTL[interval] || 30_000;
  if (cached && Date.now() - cached.time < ttl) return cached.data;

  const data = await infoRequest({ type: "candleSnapshot", req: { coin, interval, startTime, ...(endTime ? { endTime } : {}) } });
  candleCache.set(key, { data, time: Date.now() });
  return data;
}

/** Get recent trades for a coin */
export async function getRecentTrades(coin: string): Promise<unknown[]> {
  return infoRequest({ type: "recentTrades", coin });
}

/** Get spot metadata (tokens + universe of trading pairs) */
export async function getSpotMeta(): Promise<{
  tokens: { index: number; name: string; tokenId: string }[];
  universe: { name: string; tokens: [number, number] }[];
}> {
  return infoRequest({ type: "spotMeta" });
}

/** Get spot metadata + live asset contexts */
export async function getSpotMetaAndAssetCtxs(): Promise<[
  { tokens: { index: number; name: string }[]; universe: { name: string; tokens: [number, number] }[] },
  { dayNtlVlm: string; markPx: string; midPx: string; prevDayPx: string }[]
]> {
  return infoRequest({ type: "spotMetaAndAssetCtxs" });
}

// ─── HIP-3 Builder Perps (tradfi, stocks, indices, etc.) ────────────────────

/** All known HIP-3 builder DEXes */
export const HIP3_DEXES = ["xyz", "flx", "vntl", "hyna", "km", "cash"] as const;
export type Hip3Dex = (typeof HIP3_DEXES)[number];

/** Get HIP-3 builder perp metadata + live asset contexts for a specific DEX */
export async function getHip3MetaAndAssetCtxs(dex: Hip3Dex): Promise<[
  { universe: { name: string; szDecimals: number; maxLeverage: number }[] },
  AssetCtx[]
]> {
  return infoRequest({ type: "metaAndAssetCtxs", dex });
}

// ─── Trader discovery via Hyperliquid leaderboard ────────────────────────────

const HL_LEADERBOARD = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";

export interface DiscoveredTrader {
  address: string;
  displayName: string | null;
  accountValue: number;
  totalPnl: number;
  pnl30d: number;
  roi30d: number;
  roiWeekly: number;
  roiAllTime: number;
  winRate: number;
  tradeCount: number;
  maxLeverage: number;
  roiPercent: number;
  maxDrawdown: number;
}

interface LeaderboardRow {
  ethAddress: string;
  accountValue: string;
  displayName: string | null;
  windowPerformances: [string, { pnl: string; roi: string; vlm: string }][];
  prize: number;
}

/** In-memory cache — leaderboard data updates infrequently */
let discoveryCache: { traders: DiscoveredTrader[]; fetchedAt: number } | null =
  null;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/**
 * Fetch the full Hyperliquid leaderboard (~32K traders) with pre-computed
 * PnL, ROI, and volume across day/week/month/allTime windows.
 */
export async function discoverActiveTraders(): Promise<DiscoveredTrader[]> {
  // Return cached results if fresh
  if (discoveryCache && Date.now() - discoveryCache.fetchedAt < CACHE_TTL) {
    return discoveryCache.traders;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
  let res: Response;
  try {
    res = await fetch(HL_LEADERBOARD, {
      signal: controller.signal,
      headers: {
        "User-Agent": "hl-copy-trading/1.0",
        "Accept": "application/json",
      },
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new Error(`Leaderboard fetch failed: ${res.status}`);

  // Parse and extract top 8000 by account value (increased from 5000 to capture
  // more mid-size accounts with strong ROI that would otherwise be excluded)
  let rows: LeaderboardRow[];
  try {
    const data = JSON.parse(await res.text()) as { leaderboardRows: LeaderboardRow[] };
    rows = (data.leaderboardRows || [])
      .sort((a, b) => parseFloat(b.accountValue || "0") - parseFloat(a.accountValue || "0"))
      .slice(0, 8000);
  } catch (e) {
    throw new Error(`Leaderboard JSON parse failed: ${(e as Error).message}`);
  }

  const results: DiscoveredTrader[] = [];

  for (const row of rows) {
    const accountValue = parseFloat(row.accountValue || "0");
    if (accountValue < 500) continue; // Skip tiny accounts (lowered from $1K to capture more traders)

    // Parse window performances into a map
    const perfMap = new Map<string, { pnl: number; roi: number; vlm: number }>();
    for (const [window, perf] of row.windowPerformances) {
      perfMap.set(window, {
        pnl: parseFloat(perf.pnl || "0"),
        roi: parseFloat(perf.roi || "0"),
        vlm: parseFloat(perf.vlm || "0"),
      });
    }

    const allTime = perfMap.get("allTime");
    const month = perfMap.get("month");
    const week = perfMap.get("week");

    const totalPnl = allTime?.pnl ?? 0;
    const roiAllTime = (allTime?.roi ?? 0) * 100; // API returns decimal, convert to %
    const pnl30d = month?.pnl ?? 0;
    const roi30d = (month?.roi ?? 0) * 100;
    const roiWeekly = (week?.roi ?? 0) * 100;

    results.push({
      address: row.ethAddress,
      displayName: row.displayName || null,
      accountValue,
      totalPnl,
      pnl30d,
      roi30d,
      roiWeekly,
      roiAllTime,
      winRate: 0,
      tradeCount: 0,
      maxLeverage: 0,
      roiPercent: roiAllTime,
      maxDrawdown: 0,
    });
  }

  // Cache the results
  discoveryCache = { traders: results, fetchedAt: Date.now() };

  return results;
}

// ─── WebSocket helpers ───────────────────────────────────────────────────────

export function getWsUrl() {
  return HL_WS;
}

export function createFillsSubscription(traderAddress: string) {
  return {
    method: "subscribe",
    subscription: {
      type: "userFills",
      user: traderAddress,
    },
  };
}

export function createUnsubscribe(subscriptionId: number) {
  return {
    method: "unsubscribe",
    subscription: { id: subscriptionId },
  };
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HLPosition {
  coin: string;
  szi: string; // signed size
  entryPx: string;
  positionValue: string;
  unrealizedPnl: string;
  leverage: { type: string; value: number };
  liquidationPx: string | null;
  marginUsed: string;
}

export interface HLClearinghouseState {
  assetPositions: { position: HLPosition }[];
  crossMarginSummary: {
    accountValue: string;
    totalNtlPos: string;
    totalRawUsd: string;
    totalMarginUsed: string;
  };
  withdrawable: string;
}

export interface HLFill {
  coin: string;
  px: string;
  sz: string;
  side: string;
  time: number;
  startPosition: string;
  dir: string;
  closedPnl: string;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: string;
  tid: number;
}

export interface AssetCtx {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium: string;
  oraclePx: string;
  markPx: string;
  midPx: string;
  impactPxs: [string, string];
}

export interface BookLevel {
  px: string;
  sz: string;
  n: number;
}

export interface FundingEntry {
  coin: string;
  fundingRate: string;
  premium: string;
  time: number;
}

export interface Candle {
  t: number; // open time
  T: number; // close time
  s: string; // coin
  i: string; // interval
  o: string; // open
  c: string; // close
  h: string; // high
  l: string; // low
  v: string; // volume
  n: number; // number of trades
}
