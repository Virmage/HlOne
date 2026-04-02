/**
 * Options data from Deribit — max pain, put/call ratio, implied volatility.
 * Free public API, no auth needed.
 * BTC/ETH: native currency options (currency=BTC, currency=ETH)
 * Altcoins (SOL, XRP, AVAX, TRX): USDC-settled options (currency=USDC, prefix=SOL_USDC)
 */

const DERIBIT_API = "https://www.deribit.com/api/v2/public";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OptionsSnapshot {
  currency: string;
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
}

interface BookSummary {
  instrument_name: string;
  open_interest: number;
  volume_usd: number;
  mark_price: number;
  mark_iv?: number;
  greeks?: { delta?: number; gamma?: number };
}

interface TickerResult {
  instrument_name: string;
  mark_iv: number;
  greeks: { delta: number; gamma: number };
  open_interest: number;
  underlying_price: number;
}

// ─── Cache ───────────────────────────────────────────────────────────────────

const cache = new Map<string, OptionsSnapshot>();
const CACHE_TTL = 5 * 60_000;

// USDC book summary cache (shared across altcoins)
let usdcBookCache: { data: BookSummary[]; fetchedAt: number } | null = null;
let usdcInstrumentsCache: { data: { instrument_name: string; strike: number; option_type: string; expiration_timestamp: number }[]; fetchedAt: number } | null = null;

// ─── Config ─────────────────────────────────────────────────────────────────

// Native currency options (fetched individually)
const NATIVE_COINS = ["BTC", "ETH"];
// USDC-settled altcoin options (fetched from currency=USDC, filtered by prefix)
const USDC_COINS = ["SOL", "XRP", "AVAX", "TRX"];
const ALL_SUPPORTED = [...NATIVE_COINS, ...USDC_COINS];

/** Get the Deribit API currency parameter for a coin */
function apiCurrency(coin: string): string {
  return USDC_COINS.includes(coin) ? "USDC" : coin;
}

/** Get the instrument prefix for filtering (e.g. "SOL_USDC" or "BTC") */
function instrumentPrefix(coin: string): string {
  return USDC_COINS.includes(coin) ? `${coin}_USDC` : coin;
}

// ─── Fetchers ────────────────────────────────────────────────────────────────

async function deribitGet(endpoint: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(`${DERIBIT_API}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Deribit API error: ${res.status}`);
  const data = await res.json() as { result: unknown };
  return data.result;
}

async function getBookSummary(currency: string): Promise<BookSummary[]> {
  return deribitGet("get_book_summary_by_currency", {
    currency,
    kind: "option",
  }) as Promise<BookSummary[]>;
}

/** Get book summary filtered by coin prefix. Uses shared USDC cache for altcoins. */
async function getBookSummaryForCoin(coin: string): Promise<BookSummary[]> {
  if (NATIVE_COINS.includes(coin)) {
    return getBookSummary(coin);
  }
  // USDC-settled: fetch all USDC options, cache, then filter
  if (!usdcBookCache || Date.now() - usdcBookCache.fetchedAt > CACHE_TTL) {
    const data = await getBookSummary("USDC");
    usdcBookCache = { data, fetchedAt: Date.now() };
  }
  const prefix = instrumentPrefix(coin);
  return usdcBookCache.data.filter(b => b.instrument_name.startsWith(prefix + "-"));
}

/** Get instruments filtered by coin prefix */
async function getInstrumentsForCoin(coin: string): Promise<{ instrument_name: string; strike: number; option_type: string; expiration_timestamp: number }[]> {
  if (NATIVE_COINS.includes(coin)) {
    return deribitGet("get_instruments", { currency: coin, kind: "option", expired: "false" }) as Promise<typeof usdcInstrumentsCache extends null ? never : NonNullable<typeof usdcInstrumentsCache>["data"]>;
  }
  // USDC-settled: fetch all USDC instruments, cache, then filter
  if (!usdcInstrumentsCache || Date.now() - usdcInstrumentsCache.fetchedAt > CACHE_TTL) {
    const data = await deribitGet("get_instruments", { currency: "USDC", kind: "option", expired: "false" }) as typeof usdcInstrumentsCache extends null ? never : NonNullable<typeof usdcInstrumentsCache>["data"];
    usdcInstrumentsCache = { data, fetchedAt: Date.now() };
  }
  const prefix = instrumentPrefix(coin);
  return usdcInstrumentsCache.data.filter(i => i.instrument_name.startsWith(prefix + "-"));
}

async function getDvol(currency: string): Promise<number> {
  const now = Date.now();
  const data = await deribitGet("get_volatility_index_data", {
    currency,
    resolution: "3600",
    start_timestamp: String(now - 2 * 3600_000),
    end_timestamp: String(now),
  }) as { data: [number, number][] };

  if (data.data && data.data.length > 0) {
    return data.data[data.data.length - 1][1];
  }
  return 0;
}

// ─── IV History for IV Rank ──────────────────────────────────────────────────

const ivHistory = new Map<string, { values: number[]; fetchedAt: number }>();
const IV_HISTORY_TTL = 30 * 60_000;

async function getIvRank(currency: string, currentDvol: number): Promise<number> {
  const cached = ivHistory.get(currency);
  if (cached && Date.now() - cached.fetchedAt < IV_HISTORY_TTL && cached.values.length > 0) {
    return computeIvRank(cached.values, currentDvol);
  }

  try {
    const now = Date.now();
    const ninetyDaysAgo = now - 90 * 24 * 3600_000;
    const data = await deribitGet("get_volatility_index_data", {
      currency,
      resolution: "86400",
      start_timestamp: String(ninetyDaysAgo),
      end_timestamp: String(now),
    }) as { data: [number, number][] };

    const values = (data.data || []).map(d => d[1]);
    ivHistory.set(currency, { values, fetchedAt: Date.now() });
    return computeIvRank(values, currentDvol);
  } catch {
    return 50;
  }
}

function computeIvRank(history: number[], current: number): number {
  if (history.length < 2) return 50;
  const min = Math.min(...history);
  const max = Math.max(...history);
  if (max === min) return 50;
  return Math.round(((current - min) / (max - min)) * 100);
}

// ─── 25-Delta Skew ──────────────────────────────────────────────────────────

async function get25DeltaSkew(coin: string): Promise<number> {
  try {
    const instruments = await getInstrumentsForCoin(coin);

    const now = Date.now();
    const byExpiry = new Map<number, typeof instruments>();
    for (const inst of instruments) {
      if (inst.expiration_timestamp < now) continue;
      const arr = byExpiry.get(inst.expiration_timestamp) || [];
      arr.push(inst);
      byExpiry.set(inst.expiration_timestamp, arr);
    }

    const sortedExpiries = [...byExpiry.keys()].sort((a, b) => a - b);
    const targetExpiry = sortedExpiries.find(e => e - now > 7 * 24 * 3600_000) || sortedExpiries[0];
    if (!targetExpiry) return 0;

    const expiryInstruments = byExpiry.get(targetExpiry)!;
    const puts = expiryInstruments.filter(i => i.option_type === "put");
    const calls = expiryInstruments.filter(i => i.option_type === "call");

    if (puts.length === 0 || calls.length === 0) return 0;

    const putNames = puts.slice(0, Math.min(puts.length, 8)).map(p => p.instrument_name);
    const callNames = calls.slice(0, Math.min(calls.length, 8)).map(c => c.instrument_name);

    const tickerPromises = [...putNames, ...callNames].map(async (name) => {
      try {
        return await deribitGet("ticker", { instrument_name: name }) as TickerResult;
      } catch {
        return null;
      }
    });

    const tickers = (await Promise.all(tickerPromises)).filter(Boolean) as TickerResult[];

    let closest25Put: TickerResult | null = null;
    let closest25Call: TickerResult | null = null;
    let minPutDist = Infinity;
    let minCallDist = Infinity;

    for (const t of tickers) {
      const absDelta = Math.abs(t.greeks?.delta || 0);
      if (t.instrument_name.endsWith("-P")) {
        const dist = Math.abs(absDelta - 0.25);
        if (dist < minPutDist) { minPutDist = dist; closest25Put = t; }
      } else {
        const dist = Math.abs(absDelta - 0.25);
        if (dist < minCallDist) { minCallDist = dist; closest25Call = t; }
      }
    }

    if (!closest25Put || !closest25Call) return 0;
    return (closest25Put.mark_iv || 0) - (closest25Call.mark_iv || 0);
  } catch {
    return 0;
  }
}

// ─── GEX (Gamma Exposure) ───────────────────────────────────────────────────

async function computeGex(coin: string): Promise<{ gex: number; gexLevel: "dampening" | "amplifying" | "neutral" }> {
  try {
    const instruments = await getInstrumentsForCoin(coin);

    const now = Date.now();
    const nearTerm = instruments.filter(i => i.expiration_timestamp > now && i.expiration_timestamp - now < 30 * 24 * 3600_000);

    if (nearTerm.length === 0) return { gex: 0, gexLevel: "neutral" };

    const sample = nearTerm.slice(0, 30);
    const tickerPromises = sample.map(async (inst) => {
      try {
        return await deribitGet("ticker", { instrument_name: inst.instrument_name }) as TickerResult;
      } catch {
        return null;
      }
    });

    const tickers = (await Promise.all(tickerPromises)).filter(Boolean) as TickerResult[];

    const spotPrice = tickers[0]?.underlying_price || 0;
    if (spotPrice === 0) return { gex: 0, gexLevel: "neutral" };

    let totalGex = 0;
    for (const t of tickers) {
      const gamma = t.greeks?.gamma || 0;
      const oi = t.open_interest || 0;
      const isCall = t.instrument_name.endsWith("-C");
      const sign = isCall ? 1 : -1;
      totalGex += sign * gamma * oi * spotPrice * spotPrice * 0.01;
    }

    const gexM = totalGex / 1_000_000;

    let gexLevel: "dampening" | "amplifying" | "neutral" = "neutral";
    if (gexM > 5) gexLevel = "dampening";
    else if (gexM < -5) gexLevel = "amplifying";

    return { gex: Math.round(gexM * 10) / 10, gexLevel };
  } catch {
    return { gex: 0, gexLevel: "neutral" };
  }
}

// ─── Max Pain Calculation ────────────────────────────────────────────────────

function computeMaxPain(options: BookSummary[]): { maxPain: number; expiry: string; topStrikes: { strike: number; callOI: number; putOI: number }[] } {
  const expiries = new Map<string, { strike: number; isCall: boolean; oi: number }[]>();

  for (const opt of options) {
    const parts = opt.instrument_name.split("-");
    if (parts.length < 4) continue;
    const expiry = parts[1];
    const strike = parseFloat(parts[2]);
    const isCall = parts[3] === "C";

    if (!expiries.has(expiry)) expiries.set(expiry, []);
    expiries.get(expiry)!.push({ strike, isCall, oi: opt.open_interest });
  }

  const sorted = [...expiries.entries()]
    .map(([exp, opts]) => ({ exp, opts, totalOI: opts.reduce((s, o) => s + o.oi, 0) }))
    .filter(e => e.totalOI > 100)
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
    if (pain < minPain) {
      minPain = pain;
      maxPainStrike = s;
    }
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

// ─── Public API ──────────────────────────────────────────────────────────────

export async function getOptionsData(coin: string): Promise<OptionsSnapshot | null> {
  if (!ALL_SUPPORTED.includes(coin)) return null;

  const cached = cache.get(coin);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached;

  try {
    const isNative = NATIVE_COINS.includes(coin);

    // Fetch core data in parallel
    const [bookSummary, dvol, skew25d, gexResult] = await Promise.all([
      getBookSummaryForCoin(coin),
      // DVOL only available for BTC/ETH
      isNative ? getDvol(coin).catch(() => 0) : Promise.resolve(0),
      get25DeltaSkew(coin),
      computeGex(coin),
    ]);

    const totalCallOI = bookSummary
      .filter(b => b.instrument_name.endsWith("-C"))
      .reduce((s, b) => s + b.open_interest, 0);
    const totalPutOI = bookSummary
      .filter(b => b.instrument_name.endsWith("-P"))
      .reduce((s, b) => s + b.open_interest, 0);

    if (totalCallOI === 0 && totalPutOI === 0) return null; // no OI = no data

    const { maxPain, expiry, topStrikes } = computeMaxPain(bookSummary);

    // IV rank only for native coins with DVOL
    const ivRank = dvol > 0 ? await getIvRank(coin, dvol) : 50;

    // For altcoins, estimate avg IV from book summary mark_iv values
    let avgIv = dvol;
    if (!isNative && bookSummary.length > 0) {
      const ivs = bookSummary.filter(b => b.mark_iv && b.mark_iv > 0).map(b => b.mark_iv!);
      if (ivs.length > 0) avgIv = ivs.reduce((a, b) => a + b, 0) / ivs.length;
    }

    // Spot price for max pain distance
    let spotPrice = 0;
    try {
      const perpName = isNative ? `${coin}-PERPETUAL` : `${coin}_USDC-PERPETUAL`;
      const ticker = await deribitGet("ticker", { instrument_name: perpName }) as { last_price: number };
      spotPrice = ticker.last_price || 0;
    } catch { /* fallback */ }

    const maxPainDistance = spotPrice > 0 ? ((maxPain - spotPrice) / spotPrice) * 100 : 0;

    const snapshot: OptionsSnapshot = {
      currency: coin,
      maxPain,
      maxPainExpiry: expiry,
      maxPainDistance: Math.round(maxPainDistance * 100) / 100,
      putCallRatio: totalCallOI > 0 ? totalPutOI / totalCallOI : 0,
      totalCallOI,
      totalPutOI,
      dvol: avgIv,
      ivRank,
      skew25d: Math.round(skew25d * 100) / 100,
      gex: gexResult.gex,
      gexLevel: gexResult.gexLevel,
      topStrikes,
      fetchedAt: Date.now(),
    };

    cache.set(coin, snapshot);
    return snapshot;
  } catch (err) {
    console.error(`[options] Failed to fetch ${coin} options:`, (err as Error).message);
    return cached || null;
  }
}

/** Get options data for all supported currencies */
export async function getAllOptionsData(): Promise<Map<string, OptionsSnapshot>> {
  const results = new Map<string, OptionsSnapshot>();
  const promises = ALL_SUPPORTED.map(async (coin) => {
    const data = await getOptionsData(coin);
    if (data) results.set(coin, data);
  });
  await Promise.all(promises);
  return results;
}
