/**
 * Whale Alert API — tracks large CEX deposits & withdrawals.
 * Free tier: 10 req/min, last 1 hour of transfers.
 * Set WHALE_ALERT_API_KEY env var to enable.
 */

export interface CexTransfer {
  blockchain: string;
  symbol: string;
  hash: string;
  from: { owner: string; ownerType: string };
  to: { owner: string; ownerType: string };
  amountUsd: number;
  timestamp: number;
  /** "deposit" = to exchange, "withdrawal" = from exchange */
  direction: "deposit" | "withdrawal" | "inter_exchange";
}

export interface CexFlowSummary {
  /** Net flow in last hour (positive = net deposits = sell pressure) */
  netFlowUsd1h: number;
  totalDepositsUsd1h: number;
  totalWithdrawalsUsd1h: number;
  /** Top individual transfers */
  recentTransfers: CexTransfer[];
  /** Per-exchange breakdown */
  byExchange: { exchange: string; deposits: number; withdrawals: number; net: number }[];
  /** Per-coin breakdown */
  byCoin: { symbol: string; deposits: number; withdrawals: number; net: number }[];
  fetchedAt: number;
}

const API_KEY = process.env.WHALE_ALERT_API_KEY || "";
const BASE_URL = "https://api.whale-alert.io/v1";
const MIN_VALUE = 500_000; // $500K minimum
const POLL_INTERVAL = 60_000; // 1 min (well within 10 req/min free limit)

let cache: CexFlowSummary | null = null;
let lastFetch = 0;

export function isWhaleAlertConfigured(): boolean {
  return API_KEY.length > 0;
}

export async function fetchCexFlows(): Promise<CexFlowSummary | null> {
  if (!API_KEY) return null;
  if (cache && Date.now() - lastFetch < POLL_INTERVAL) return cache;

  try {
    const oneHourAgo = Math.floor((Date.now() - 3600_000) / 1000);
    const url = `${BASE_URL}/transactions?api_key=${API_KEY}&min_value=${MIN_VALUE}&start=${oneHourAgo}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.warn(`[whale-alert] HTTP ${resp.status}`);
      return cache;
    }

    const data = await resp.json() as {
      result: string;
      transactions?: {
        blockchain: string;
        symbol: string;
        hash: string;
        from: { address: string; owner: string; owner_type: string };
        to: { address: string; owner: string; owner_type: string };
        amount_usd: number;
        timestamp: number;
      }[];
    };

    if (data.result !== "success" || !data.transactions) {
      return cache;
    }

    const transfers: CexTransfer[] = [];
    const exchangeMap = new Map<string, { deposits: number; withdrawals: number }>();
    const coinMap = new Map<string, { deposits: number; withdrawals: number }>();
    let totalDeposits = 0;
    let totalWithdrawals = 0;

    for (const tx of data.transactions) {
      const fromExchange = tx.from.owner_type === "exchange";
      const toExchange = tx.to.owner_type === "exchange";

      let direction: CexTransfer["direction"];
      if (toExchange && !fromExchange) direction = "deposit";
      else if (fromExchange && !toExchange) direction = "withdrawal";
      else if (fromExchange && toExchange) direction = "inter_exchange";
      else continue; // unknown-to-unknown, skip

      const transfer: CexTransfer = {
        blockchain: tx.blockchain,
        symbol: tx.symbol.toUpperCase(),
        hash: tx.hash,
        from: { owner: tx.from.owner || "unknown", ownerType: tx.from.owner_type },
        to: { owner: tx.to.owner || "unknown", ownerType: tx.to.owner_type },
        amountUsd: tx.amount_usd,
        timestamp: tx.timestamp * 1000,
        direction,
      };
      transfers.push(transfer);

      // Accumulate per-exchange
      const exchangeName = direction === "deposit" ? tx.to.owner : tx.from.owner;
      if (exchangeName && exchangeName !== "unknown") {
        const e = exchangeMap.get(exchangeName) || { deposits: 0, withdrawals: 0 };
        if (direction === "deposit") { e.deposits += tx.amount_usd; totalDeposits += tx.amount_usd; }
        else if (direction === "withdrawal") { e.withdrawals += tx.amount_usd; totalWithdrawals += tx.amount_usd; }
        exchangeMap.set(exchangeName, e);
      }

      // Accumulate per-coin
      const sym = tx.symbol.toUpperCase();
      const c = coinMap.get(sym) || { deposits: 0, withdrawals: 0 };
      if (direction === "deposit") c.deposits += tx.amount_usd;
      else if (direction === "withdrawal") c.withdrawals += tx.amount_usd;
      coinMap.set(sym, c);
    }

    // Sort transfers by size
    transfers.sort((a, b) => b.amountUsd - a.amountUsd);

    const byExchange = [...exchangeMap.entries()]
      .map(([exchange, { deposits, withdrawals }]) => ({
        exchange, deposits, withdrawals, net: deposits - withdrawals,
      }))
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

    const byCoin = [...coinMap.entries()]
      .map(([symbol, { deposits, withdrawals }]) => ({
        symbol, deposits, withdrawals, net: deposits - withdrawals,
      }))
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

    cache = {
      netFlowUsd1h: totalDeposits - totalWithdrawals,
      totalDepositsUsd1h: totalDeposits,
      totalWithdrawalsUsd1h: totalWithdrawals,
      recentTransfers: transfers.slice(0, 20),
      byExchange,
      byCoin,
      fetchedAt: Date.now(),
    };
    lastFetch = Date.now();
    return cache;
  } catch (err) {
    console.warn("[whale-alert] fetch error:", err);
    return cache;
  }
}

export function getCexFlowsCached(): CexFlowSummary | null {
  return cache;
}
