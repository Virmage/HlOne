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

// ─── Leaderboard scraping ────────────────────────────────────────────────────

/**
 * Hyperliquid has no official leaderboard API.
 * We use the undocumented endpoint that the website calls.
 * This may break — we handle it gracefully.
 */
export async function getLeaderboard() {
  try {
    const res = await fetch(`${HL_API}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "leaderboard" }),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
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
