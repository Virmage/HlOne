/**
 * Options data from Derive (formerly Lyra Finance).
 * Replaces Deribit — Derive supports BTC, ETH, SOL, HYPE options.
 * Free public API, no auth needed for market data.
 * Auth required for trading (Ethereum signatures + session keys).
 */

const DERIVE_API = "https://api.lyra.finance/public";

// Derive supports these currencies for options
const SUPPORTED_COINS = ["BTC", "ETH", "SOL", "HYPE"];

// ─── Types ───────────────────────────────────────────────────────────────────

interface DeriveInstrument {
  instrument_name: string;
  is_active: boolean;
  option_details: {
    index: string;
    expiry: number;
    strike: string;
    option_type: "C" | "P";
    settlement_price: string | null;
  } | null;
  base_currency: string;
  quote_currency: string;
  minimum_amount: string;
  maximum_amount: string;
  maker_fee_rate: string;
  taker_fee_rate: string;
}

interface DeriveTicker {
  instrument_name: string;
  instrument_type: string;
  mark_price: string;
  index_price: string;
  best_bid_price: string;
  best_ask_price: string;
  best_bid_amount: string;
  best_ask_amount: string;
  option_details: {
    expiry: number;
    strike: string;
    option_type: "C" | "P";
  } | null;
  option_pricing: {
    delta: string;
    gamma: string;
    vega: string;
    theta: string;
    rho: string;
    iv: string;
    bid_iv: string;
    ask_iv: string;
    mark_price: string;
    forward_price: string;
    discount_factor: string;
  } | null;
  open_interest: {
    PM2?: { current_open_interest: string; interest_cap: string }[];
    PM?: { current_open_interest: string; interest_cap: string }[];
    SM?: { current_open_interest: string; interest_cap: string }[];
  };
  stats?: {
    high: string;
    low: string;
    volume: string;
    num_trades: number;
    percent_change: string;
  };
}

// ─── Exported Types ─────────────────────────────────────────────────────────

export interface DeriveOptionsSnapshot {
  currency: string;
  source: "derive";
  maxPain: number;
  maxPainExpiry: string;
  maxPainDistance: number;
  putCallRatio: number;
  totalCallOI: number;
  totalPutOI: number;
  dvol: number;
  ivRank: number;
  skew25d: number;
  gex: number;
  gexLevel: "dampening" | "amplifying" | "neutral";
  topStrikes: { strike: number; callOI: number; putOI: number }[];
  fetchedAt: number;
  spotPrice: number;
  expiryDates: string[];
  totalVolume24h: number;
}

export interface DeriveOptionRow {
  instrument: string;
  expiry: string;
  expiryTimestamp: number;
  strike: number;
  type: "C" | "P";
  markPrice: number;
  bidPrice: number;
  askPrice: number;
  bidAmount: number;
  askAmount: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  openInterest: number;
  volume24h: number;
}

// ─── Cache ───────────────────────────────────────────────────────────────────

const snapshotCache = new Map<string, DeriveOptionsSnapshot>();
const CACHE_TTL = 5 * 60_000;

const ivHistoryCache = new Map<string, { values: number[]; fetchedAt: number }>();
const IV_HISTORY_TTL = 30 * 60_000;

// ─── Fetcher ─────────────────────────────────────────────────────────────────

async function deriveGet(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const url = new URL(`${DERIVE_API}/${method}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`Derive API error: ${resp.status}`);
  const data = await resp.json() as { result: unknown; error?: { message: string; code?: number } };
  if (data.error) throw new Error(`Derive API: ${data.error.message}`);
  return data.result;
}

// ─── Data fetching ───────────────────────────────────────────────────────────

async function getInstruments(currency: string): Promise<DeriveInstrument[]> {
  const result = await deriveGet("get_instruments", {
    currency,
    instrument_type: "option",
    expired: "false",
  });
  return (result as DeriveInstrument[]).filter(i => i.is_active);
}

async function getTickerForInstrument(instrumentName: string): Promise<DeriveTicker | null> {
  try {
    return await deriveGet("get_ticker", { instrument_name: instrumentName }) as DeriveTicker;
  } catch {
    return null;
  }
}

async function getTickersForExpiry(currency: string, expiryDate: string): Promise<Record<string, DeriveTicker>> {
  try {
    const result = await deriveGet("get_tickers", {
      instrument_type: "option",
      currency,
      expiry_date: expiryDate,
    }) as { tickers: Record<string, DeriveTicker> };
    return result.tickers || {};
  } catch {
    return {};
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getTotalOI(ticker: DeriveTicker): number {
  let total = 0;
  const oi = ticker.open_interest;
  if (oi.PM2) total += oi.PM2.reduce((s, o) => s + parseFloat(o.current_open_interest || "0"), 0);
  if (oi.PM) total += oi.PM.reduce((s, o) => s + parseFloat(o.current_open_interest || "0"), 0);
  if (oi.SM) total += oi.SM.reduce((s, o) => s + parseFloat(o.current_open_interest || "0"), 0);
  return total;
}

function formatExpiryDate(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function formatExpiryLabel(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  return `${d.getDate()}${months[d.getMonth()]}${String(d.getFullYear()).slice(2)}`;
}

function computeIvRank(history: number[], current: number): number {
  if (history.length < 2) return 50;
  const min = Math.min(...history);
  const max = Math.max(...history);
  if (max === min) return 50;
  return Math.round(((current - min) / (max - min)) * 100);
}

// GEX thresholds by coin (BTC/ETH are bigger markets)
function gexThreshold(coin: string): number {
  if (coin === "BTC") return 5;
  if (coin === "ETH") return 5;
  return 0.5; // SOL, HYPE — smaller markets
}

// ─── Option Entry type ──────────────────────────────────────────────────────

interface OptionEntry {
  strike: number;
  isCall: boolean;
  oi: number;
  iv: number;
  delta: number;
  gamma: number;
  expiry: number;
  expiryLabel: string;
}

// ─── Max Pain ────────────────────────────────────────────────────────────────

function computeMaxPain(options: OptionEntry[]): { maxPain: number; expiry: string; topStrikes: { strike: number; callOI: number; putOI: number }[] } {
  const expiries = new Map<string, OptionEntry[]>();
  for (const opt of options) {
    const label = opt.expiryLabel;
    if (!expiries.has(label)) expiries.set(label, []);
    expiries.get(label)!.push(opt);
  }

  const sorted = [...expiries.entries()]
    .map(([exp, opts]) => ({ exp, opts, totalOI: opts.reduce((s, o) => s + o.oi, 0) }))
    .filter(e => e.totalOI > 10)
    .sort((a, b) => a.exp.localeCompare(b.exp));

  if (sorted.length === 0) return { maxPain: 0, expiry: "", topStrikes: [] };

  const nearest = sorted[0];
  const strikes = [...new Set(nearest.opts.map(o => o.strike))].sort((a, b) => a - b);

  let minPain = Infinity;
  let maxPainStrike = 0;

  for (const s of strikes) {
    let pain = 0;
    for (const o of nearest.opts) {
      if (o.isCall && s > o.strike) pain += (s - o.strike) * o.oi;
      else if (!o.isCall && s < o.strike) pain += (o.strike - s) * o.oi;
    }
    if (pain < minPain) { minPain = pain; maxPainStrike = s; }
  }

  const strikeOI = new Map<number, { callOI: number; putOI: number }>();
  for (const o of nearest.opts) {
    const existing = strikeOI.get(o.strike) || { callOI: 0, putOI: 0 };
    if (o.isCall) existing.callOI += o.oi;
    else existing.putOI += o.oi;
    strikeOI.set(o.strike, existing);
  }

  const topStrikes = [...strikeOI.entries()]
    .map(([strike, oi]) => ({ strike, ...oi }))
    .sort((a, b) => (b.callOI + b.putOI) - (a.callOI + a.putOI))
    .slice(0, 5);

  return { maxPain: maxPainStrike, expiry: nearest.exp, topStrikes };
}

// ─── Core: fetch + compute for any supported coin ──────────────────────────

async function fetchTickersForCoin(currency: string, instruments: DeriveInstrument[]): Promise<DeriveTicker[]> {
  const expiryTimestamps = [...new Set(
    instruments.map(i => i.option_details?.expiry || 0).filter(e => e * 1000 > Date.now())
  )].sort((a, b) => a - b);

  const allTickers: DeriveTicker[] = [];

  for (const expiryTs of expiryTimestamps) {
    const dateStr = formatExpiryDate(expiryTs);
    try {
      const tickers = await getTickersForExpiry(currency, dateStr);
      const tickerList = Object.values(tickers);
      if (tickerList.length > 0) {
        allTickers.push(...tickerList);
        continue;
      }
    } catch { /* fall through */ }

    // Fallback to individual
    const expiryInstruments = instruments
      .filter(i => i.option_details?.expiry === expiryTs)
      .slice(0, 30);
    const tickers = (await Promise.all(
      expiryInstruments.map(i => getTickerForInstrument(i.instrument_name))
    )).filter(Boolean) as DeriveTicker[];
    allTickers.push(...tickers);
  }

  return allTickers;
}

function computeSnapshot(currency: string, allTickers: DeriveTicker[]): DeriveOptionsSnapshot | null {
  if (allTickers.length === 0) return null;

  const spotPrice = parseFloat(allTickers[0]?.index_price || "0");
  if (spotPrice === 0) return null;

  const options: OptionEntry[] = [];
  let totalCallOI = 0;
  let totalPutOI = 0;
  const ivValues: number[] = [];
  let totalVolume24h = 0;

  const expirySet = new Set<number>();

  for (const ticker of allTickers) {
    const details = ticker.option_details;
    const pricing = ticker.option_pricing;
    if (!details || !pricing) continue;

    const strike = parseFloat(details.strike);
    const isCall = details.option_type === "C";
    const oi = getTotalOI(ticker);
    const iv = parseFloat(pricing.iv || "0") * 100;
    const delta = parseFloat(pricing.delta || "0");
    const gamma = parseFloat(pricing.gamma || "0");

    if (isCall) totalCallOI += oi;
    else totalPutOI += oi;
    if (iv > 0) ivValues.push(iv);
    if (ticker.stats?.volume) totalVolume24h += parseFloat(ticker.stats.volume);
    if (details.expiry * 1000 > Date.now()) expirySet.add(details.expiry);

    options.push({ strike, isCall, oi, iv, delta, gamma, expiry: details.expiry, expiryLabel: formatExpiryLabel(details.expiry) });
  }

  if (totalCallOI === 0 && totalPutOI === 0) return null;

  const { maxPain, expiry, topStrikes } = computeMaxPain(options);
  const maxPainDistance = spotPrice > 0 ? ((maxPain - spotPrice) / spotPrice) * 100 : 0;
  const putCallRatio = totalCallOI > 0 ? totalPutOI / totalCallOI : 0;

  // Avg IV
  let avgIv = 0;
  if (ivValues.length > 0) avgIv = ivValues.reduce((a, b) => a + b, 0) / ivValues.length;

  // IV Rank
  let ivRank = 50;
  const cached = ivHistoryCache.get(currency);
  if (cached && Date.now() - cached.fetchedAt < IV_HISTORY_TTL) {
    ivRank = computeIvRank(cached.values, avgIv);
  } else {
    const existing = cached?.values || [];
    existing.push(avgIv);
    if (existing.length > 90) existing.shift();
    ivHistoryCache.set(currency, { values: existing, fetchedAt: Date.now() });
    ivRank = computeIvRank(existing, avgIv);
  }

  // 25-delta skew from nearest expiry
  let skew25d = 0;
  const sortedExpiries = [...expirySet].sort((a, b) => a - b);
  const nearestExpiry = sortedExpiries[0];
  if (nearestExpiry) {
    const nearOptions = options.filter(o => o.expiry === nearestExpiry);
    let closest25Put: OptionEntry | null = null;
    let closest25Call: OptionEntry | null = null;
    let minPutDist = Infinity;
    let minCallDist = Infinity;

    for (const o of nearOptions) {
      const absDelta = Math.abs(o.delta);
      if (!o.isCall) {
        const dist = Math.abs(absDelta - 0.25);
        if (dist < minPutDist) { minPutDist = dist; closest25Put = o; }
      } else {
        const dist = Math.abs(absDelta - 0.25);
        if (dist < minCallDist) { minCallDist = dist; closest25Call = o; }
      }
    }
    if (closest25Put && closest25Call) skew25d = closest25Put.iv - closest25Call.iv;
  }

  // GEX
  let totalGex = 0;
  for (const o of options) {
    const sign = o.isCall ? 1 : -1;
    totalGex += sign * o.gamma * o.oi * spotPrice * spotPrice * 0.01;
  }
  const gexM = totalGex / 1_000_000;
  const threshold = gexThreshold(currency);
  let gexLevel: "dampening" | "amplifying" | "neutral" = "neutral";
  if (gexM > threshold) gexLevel = "dampening";
  else if (gexM < -threshold) gexLevel = "amplifying";

  return {
    currency,
    source: "derive",
    maxPain,
    maxPainExpiry: expiry,
    maxPainDistance: Math.round(maxPainDistance * 100) / 100,
    putCallRatio: Math.round(putCallRatio * 100) / 100,
    totalCallOI,
    totalPutOI,
    dvol: Math.round(avgIv * 10) / 10,
    ivRank,
    skew25d: Math.round(skew25d * 100) / 100,
    gex: Math.round(gexM * 10) / 10,
    gexLevel,
    topStrikes,
    fetchedAt: Date.now(),
    spotPrice,
    expiryDates: sortedExpiries.map(e => formatExpiryLabel(e)),
    totalVolume24h,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Get options snapshot for a single coin */
export async function getDeriveOptionsData(coin: string): Promise<DeriveOptionsSnapshot | null> {
  if (!SUPPORTED_COINS.includes(coin)) return null;

  const cached = snapshotCache.get(coin);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached;

  try {
    const instruments = await getInstruments(coin);
    if (instruments.length === 0) {
      console.log(`[derive] No active ${coin} options found`);
      return null;
    }

    const allTickers = await fetchTickersForCoin(coin, instruments);
    const snapshot = computeSnapshot(coin, allTickers);

    if (snapshot) {
      snapshotCache.set(coin, snapshot);
      console.log(`[derive] ${coin} options: ${allTickers.length} instruments, IV=${snapshot.dvol.toFixed(1)}%, P/C=${snapshot.putCallRatio.toFixed(2)}, MaxPain=$${snapshot.maxPain}`);
    }

    return snapshot;
  } catch (err) {
    console.error(`[derive] Failed to fetch ${coin} options:`, (err as Error).message);
    return cached || null;
  }
}

/** Get options snapshots for all supported coins */
export async function getAllDeriveOptionsData(): Promise<Map<string, DeriveOptionsSnapshot>> {
  const results = new Map<string, DeriveOptionsSnapshot>();

  // Fetch in parallel but with slight stagger to be nice to the API
  const promises = SUPPORTED_COINS.map(async (coin) => {
    const data = await getDeriveOptionsData(coin);
    if (data) results.set(coin, data);
  });

  await Promise.all(promises);
  return results;
}

/** Get full options chain for a coin — used for the options trading UI */
export async function getDeriveOptionsChain(coin: string): Promise<{
  chain: DeriveOptionRow[];
  spotPrice: number;
  expiries: { label: string; timestamp: number }[];
} | null> {
  if (!SUPPORTED_COINS.includes(coin)) return null;

  try {
    const instruments = await getInstruments(coin);
    if (instruments.length === 0) return null;

    const allTickers = await fetchTickersForCoin(coin, instruments);
    if (allTickers.length === 0) return null;

    let spotPrice = 0;
    const chain: DeriveOptionRow[] = [];
    const expirySet = new Set<number>();

    for (const ticker of allTickers) {
      const details = ticker.option_details;
      const pricing = ticker.option_pricing;
      if (!details || !pricing) continue;

      if (!spotPrice) spotPrice = parseFloat(ticker.index_price || "0");
      if (details.expiry * 1000 > Date.now()) expirySet.add(details.expiry);

      chain.push({
        instrument: ticker.instrument_name,
        expiry: formatExpiryLabel(details.expiry),
        expiryTimestamp: details.expiry,
        strike: parseFloat(details.strike),
        type: details.option_type,
        markPrice: parseFloat(pricing.mark_price || ticker.mark_price || "0"),
        bidPrice: parseFloat(ticker.best_bid_price || "0"),
        askPrice: parseFloat(ticker.best_ask_price || "0"),
        bidAmount: parseFloat(ticker.best_bid_amount || "0"),
        askAmount: parseFloat(ticker.best_ask_amount || "0"),
        iv: parseFloat(pricing.iv || "0") * 100,
        delta: parseFloat(pricing.delta || "0"),
        gamma: parseFloat(pricing.gamma || "0"),
        theta: parseFloat(pricing.theta || "0"),
        vega: parseFloat(pricing.vega || "0"),
        openInterest: getTotalOI(ticker),
        volume24h: parseFloat(ticker.stats?.volume || "0"),
      });
    }

    chain.sort((a, b) => a.expiryTimestamp - b.expiryTimestamp || a.strike - b.strike);

    const expiries = [...expirySet]
      .sort((a, b) => a - b)
      .map(ts => ({ label: formatExpiryLabel(ts), timestamp: ts }));

    return { chain, spotPrice, expiries };
  } catch (err) {
    console.error(`[derive] Failed to fetch ${coin} options chain:`, (err as Error).message);
    return null;
  }
}

/** Which coins does Derive support? */
export function getDeriveSupportedCoins(): string[] {
  return [...SUPPORTED_COINS];
}
