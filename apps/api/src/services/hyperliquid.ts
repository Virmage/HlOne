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

// ─── Trader discovery via recent trades ──────────────────────────────────────

interface DiscoveredTrader {
  address: string;
  accountValue: number;
  totalPnl: number;
  winRate: number;
  tradeCount: number;
  maxLeverage: number;
  roiPercent: number;
}

/** In-memory cache to avoid hammering HL API on every page load */
let discoveryCache: { traders: DiscoveredTrader[]; fetchedAt: number } | null =
  null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Discover active traders by sampling recent trades on major coins,
 * then fetching their account details. Used as a fallback when the
 * DB has no trader data (before the worker populates it).
 */
export async function discoverActiveTraders(): Promise<DiscoveredTrader[]> {
  // Return cached results if fresh
  if (discoveryCache && Date.now() - discoveryCache.fetchedAt < CACHE_TTL) {
    return discoveryCache.traders;
  }

  const coins = [
    "BTC", "ETH", "SOL", "HYPE", "ARB", "DOGE",
    "SUI", "AVAX", "LINK", "WIF", "PEPE", "ONDO",
  ];

  // Step 1: Collect unique addresses from recent trades
  const addresses = new Set<string>();
  const tradePromises = coins.map(async (coin) => {
    try {
      const trades = await infoRequest({ type: "recentTrades", coin });
      if (Array.isArray(trades)) {
        for (const t of trades) {
          for (const u of t.users || []) {
            addresses.add(u.toLowerCase());
          }
        }
      }
    } catch {
      // Skip failed coins
    }
  });
  await Promise.all(tradePromises);

  // Step 2: Fetch account details (batch with concurrency limit)
  const results: DiscoveredTrader[] = [];
  const addrList = [...addresses];
  const BATCH = 10;

  for (let i = 0; i < addrList.length; i += BATCH) {
    const batch = addrList.slice(i, i + BATCH);
    const batchPromises = batch.map(async (addr) => {
      try {
        const [state, fills] = await Promise.all([
          infoRequest({ type: "clearinghouseState", user: addr }),
          infoRequest({ type: "userFills", user: addr }).catch(() => []),
        ]);

        const accountValue = parseFloat(
          state?.crossMarginSummary?.accountValue || "0"
        );
        if (accountValue < 1000) return null;

        let totalPnl = 0;
        let wins = 0;
        let trades = 0;
        let maxLeverage = 0;

        if (Array.isArray(fills)) {
          for (const fill of fills) {
            const closedPnl = parseFloat(fill.closedPnl || "0");
            if (closedPnl !== 0) {
              totalPnl += closedPnl;
              trades++;
              if (closedPnl > 0) wins++;
            }
          }
        }

        if (state?.assetPositions) {
          for (const pos of state.assetPositions) {
            const lev = pos.position?.leverage?.value || 0;
            if (lev > maxLeverage) maxLeverage = lev;
          }
        }

        return {
          address: addr,
          accountValue,
          totalPnl,
          winRate: trades > 0 ? wins / trades : 0,
          tradeCount: trades,
          maxLeverage,
          roiPercent: accountValue > 0 ? (totalPnl / accountValue) * 100 : 0,
        };
      } catch {
        return null;
      }
    });

    const batchResults = await Promise.all(batchPromises);
    for (const r of batchResults) {
      if (r) results.push(r);
    }

    // Small delay between batches
    if (i + BATCH < addrList.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  results.sort((a, b) => b.accountValue - a.accountValue);

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
