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
export async function getAllMids() {
  return infoRequest({ type: "allMids" });
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

  const res = await fetch(HL_LEADERBOARD);
  if (!res.ok) throw new Error(`Leaderboard fetch failed: ${res.status}`);

  const data = await res.json() as { leaderboardRows: LeaderboardRow[] };
  const rows = data.leaderboardRows || [];

  const results: DiscoveredTrader[] = [];

  for (const row of rows) {
    const accountValue = parseFloat(row.accountValue || "0");
    if (accountValue < 1000) continue; // Skip tiny accounts

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
