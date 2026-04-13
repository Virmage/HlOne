/**
 * Deribit Options Flow — tracks large options trades on Deribit.
 * Fully free, no API key needed.
 * Provides: recent large trades, put/call ratio, net flow direction.
 */

export interface DeribitOptionTrade {
  instrument: string;
  direction: "buy" | "sell";
  amount: number; // contracts (1 contract = 1 BTC/ETH)
  price: number; // premium in underlying
  indexPrice: number;
  iv: number; // implied volatility
  notionalUsd: number;
  timestamp: number;
  /** Parsed from instrument name */
  underlying: string; // BTC or ETH
  expiry: string; // e.g. "28JUN26"
  strike: number;
  type: "call" | "put";
}

export interface OptionsFlowSummary {
  /** Recent large trades ($50K+) */
  recentTrades: DeribitOptionTrade[];
  /** Put/call volume ratio (>1 = more puts = bearish) */
  putCallRatio: number;
  /** Net premium flow (positive = net call buying = bullish) */
  netCallPremiumUsd: number;
  netPutPremiumUsd: number;
  /** Total notional traded in last poll window */
  totalNotionalUsd: number;
  /** Sentiment summary */
  sentiment: "bullish" | "bearish" | "neutral";
  fetchedAt: number;
}

const DERIBIT_BASE = "https://www.deribit.com/api/v2";
const POLL_INTERVAL = 30_000; // 30s
const MIN_NOTIONAL = 50_000; // $50K+ trades

let btcCache: OptionsFlowSummary | null = null;
let ethCache: OptionsFlowSummary | null = null;
let lastFetch = 0;

function parseInstrumentName(name: string): { underlying: string; expiry: string; strike: number; type: "call" | "put" } | null {
  // Format: BTC-28JUN26-100000-C
  const parts = name.split("-");
  if (parts.length !== 4) return null;
  return {
    underlying: parts[0],
    expiry: parts[1],
    strike: parseInt(parts[2], 10),
    type: parts[3] === "C" ? "call" : "put",
  };
}

async function fetchTradesForCurrency(currency: "BTC" | "ETH"): Promise<DeribitOptionTrade[]> {
  const url = `${DERIBIT_BASE}/public/get_last_trades_by_currency?currency=${currency}&kind=option&count=100&sorting=desc`;
  const resp = await fetch(url);
  if (!resp.ok) {
    console.warn(`[deribit] HTTP ${resp.status} for ${currency}`);
    return [];
  }
  const data = await resp.json() as {
    result?: {
      trades?: {
        instrument_name: string;
        direction: string;
        amount: number;
        price: number;
        index_price: number;
        iv: number;
        timestamp: number;
      }[];
    };
  };

  const trades: DeribitOptionTrade[] = [];
  for (const t of data.result?.trades || []) {
    const parsed = parseInstrumentName(t.instrument_name);
    if (!parsed) continue;

    const notionalUsd = t.amount * t.index_price;

    trades.push({
      instrument: t.instrument_name,
      direction: t.direction as "buy" | "sell",
      amount: t.amount,
      price: t.price,
      indexPrice: t.index_price,
      iv: t.iv,
      notionalUsd,
      timestamp: t.timestamp,
      ...parsed,
    });
  }

  return trades;
}

function buildSummary(trades: DeribitOptionTrade[]): OptionsFlowSummary {
  let callVolume = 0;
  let putVolume = 0;
  let netCallPremium = 0;
  let netPutPremium = 0;
  let totalNotional = 0;

  const largeTrades: DeribitOptionTrade[] = [];

  for (const t of trades) {
    const premiumUsd = t.price * t.indexPrice * t.amount;
    totalNotional += t.notionalUsd;

    if (t.type === "call") {
      callVolume += t.amount;
      netCallPremium += t.direction === "buy" ? premiumUsd : -premiumUsd;
    } else {
      putVolume += t.amount;
      netPutPremium += t.direction === "buy" ? premiumUsd : -premiumUsd;
    }

    if (t.notionalUsd >= MIN_NOTIONAL) {
      largeTrades.push(t);
    }
  }

  const pcRatio = callVolume > 0 ? putVolume / callVolume : 1;

  // Sentiment from net premium flow
  const netFlow = netCallPremium - netPutPremium;
  const sentiment: OptionsFlowSummary["sentiment"] =
    netFlow > 50_000 ? "bullish" :
    netFlow < -50_000 ? "bearish" : "neutral";

  return {
    recentTrades: largeTrades.sort((a, b) => b.notionalUsd - a.notionalUsd).slice(0, 15),
    putCallRatio: Math.round(pcRatio * 100) / 100,
    netCallPremiumUsd: Math.round(netCallPremium),
    netPutPremiumUsd: Math.round(netPutPremium),
    totalNotionalUsd: Math.round(totalNotional),
    sentiment,
    fetchedAt: Date.now(),
  };
}

export async function fetchDeribitFlow(): Promise<{ btc: OptionsFlowSummary; eth: OptionsFlowSummary } | null> {
  if (btcCache && ethCache && Date.now() - lastFetch < POLL_INTERVAL) {
    return { btc: btcCache, eth: ethCache };
  }

  try {
    const [btcTrades, ethTrades] = await Promise.all([
      fetchTradesForCurrency("BTC"),
      fetchTradesForCurrency("ETH"),
    ]);

    btcCache = buildSummary(btcTrades);
    ethCache = buildSummary(ethTrades);
    lastFetch = Date.now();

    return { btc: btcCache, eth: ethCache };
  } catch (err) {
    console.warn("[deribit] fetch error:", err);
    if (btcCache && ethCache) return { btc: btcCache, eth: ethCache };
    return null;
  }
}

export function getDeribitFlowCached(): { btc: OptionsFlowSummary; eth: OptionsFlowSummary } | null {
  if (!btcCache || !ethCache) return null;
  return { btc: btcCache, eth: ethCache };
}
