/**
 * HYPE options data from Derive (formerly Lyra Finance).
 * Free public API, no auth needed for market data.
 * Computes same metrics as Deribit: Max Pain, P/C ratio, IV, Skew, GEX.
 */

const DERIVE_API = "https://api.lyra.finance/public";

// ─── Types ───────────────────────────────────────────────────────────────────

interface DeriveInstrument {
  instrument_name: string;
  is_active: boolean;
  option_details: {
    index: string;
    expiry: number;       // unix timestamp
    strike: string;       // e.g. "35"
    option_type: "C" | "P";
    settlement_price: string | null;
  } | null;
  base_currency: string;
  quote_currency: string;
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
    iv: string;            // e.g. "0.993246" = 99.3%
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

// ─── Cache ───────────────────────────────────────────────────────────────────

interface DeriveOptionsSnapshot {
  currency: string;
  source: "derive";
  maxPain: number;
  maxPainExpiry: string;
  maxPainDistance: number;
  putCallRatio: number;
  totalCallOI: number;
  totalPutOI: number;
  dvol: number;             // weighted avg IV across active options
  ivRank: number;
  skew25d: number;
  gex: number;
  gexLevel: "dampening" | "amplifying" | "neutral";
  topStrikes: { strike: number; callOI: number; putOI: number }[];
  fetchedAt: number;
  // Derive-specific extras
  spotPrice: number;
  expiryDates: string[];    // available expiry dates
  totalVolume24h: number;
}

let cache: DeriveOptionsSnapshot | null = null;
const CACHE_TTL = 5 * 60_000;

// IV history for IV rank computation
let ivHistoryCache: { values: number[]; fetchedAt: number } | null = null;
const IV_HISTORY_TTL = 30 * 60_000;

// ─── Fetcher ─────────────────────────────────────────────────────────────────

async function deriveGet(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const url = new URL(`${DERIVE_API}/${method}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`Derive API error: ${resp.status}`);
  const data = await resp.json() as { result: unknown; error?: { message: string } };
  if (data.error) throw new Error(`Derive API: ${data.error.message}`);
  return data.result;
}

// ─── Data fetching ───────────────────────────────────────────────────────────

async function getHypeInstruments(): Promise<DeriveInstrument[]> {
  const result = await deriveGet("get_instruments", {
    currency: "HYPE",
    instrument_type: "option",
    expired: "false",
  });
  return (result as DeriveInstrument[]).filter(i => i.is_active);
}

async function getTickerForInstrument(instrumentName: string): Promise<DeriveTicker | null> {
  try {
    const result = await deriveGet("get_ticker", { instrument_name: instrumentName });
    return result as DeriveTicker;
  } catch {
    return null;
  }
}

/** Batch fetch tickers for an expiry date */
async function getTickersForExpiry(expiryDate: string): Promise<Record<string, DeriveTicker>> {
  try {
    const result = await deriveGet("get_tickers", {
      instrument_type: "option",
      currency: "HYPE",
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

// ─── IV Rank ─────────────────────────────────────────────────────────────────

function computeIvRank(history: number[], current: number): number {
  if (history.length < 2) return 50;
  const min = Math.min(...history);
  const max = Math.max(...history);
  if (max === min) return 50;
  return Math.round(((current - min) / (max - min)) * 100);
}

// ─── Max Pain ────────────────────────────────────────────────────────────────

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

function computeMaxPain(options: OptionEntry[]): { maxPain: number; expiry: string; topStrikes: { strike: number; callOI: number; putOI: number }[] } {
  // Group by expiry
  const expiries = new Map<string, OptionEntry[]>();
  for (const opt of options) {
    const label = opt.expiryLabel;
    if (!expiries.has(label)) expiries.set(label, []);
    expiries.get(label)!.push(opt);
  }

  // Sort by expiry timestamp and pick nearest with sufficient OI
  const sorted = [...expiries.entries()]
    .map(([exp, opts]) => ({ exp, opts, totalOI: opts.reduce((s, o) => s + o.oi, 0) }))
    .filter(e => e.totalOI > 10) // lower threshold than Deribit (HYPE is smaller market)
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

  // Top strikes by OI
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

export async function getHypeOptionsData(): Promise<DeriveOptionsSnapshot | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL) return cache;

  try {
    // 1. Get all active HYPE option instruments
    const instruments = await getHypeInstruments();
    if (instruments.length === 0) {
      console.log("[derive] No active HYPE options found");
      return null;
    }

    // 2. Group by expiry date for batch fetching
    const expiryTimestamps = new Set<number>();
    for (const inst of instruments) {
      if (inst.option_details?.expiry) {
        expiryTimestamps.add(inst.option_details.expiry);
      }
    }

    const expiryDates = [...expiryTimestamps]
      .sort((a, b) => a - b)
      .filter(e => e * 1000 > Date.now()); // only future expiries

    // 3. Fetch tickers — batch by expiry where possible, fallback to individual
    const allTickers: DeriveTicker[] = [];

    // Try batch fetch first for each expiry
    for (const expiryTs of expiryDates) {
      const dateStr = formatExpiryDate(expiryTs);
      try {
        const tickers = await getTickersForExpiry(dateStr);
        const tickerList = Object.values(tickers);
        if (tickerList.length > 0) {
          allTickers.push(...tickerList);
          continue;
        }
      } catch {
        // Batch failed, fall through to individual
      }

      // Individual fetch fallback (max 30 instruments per expiry to avoid rate limits)
      const expiryInstruments = instruments
        .filter(i => i.option_details?.expiry === expiryTs)
        .slice(0, 30);

      const tickerPromises = expiryInstruments.map(i => getTickerForInstrument(i.instrument_name));
      const tickers = (await Promise.all(tickerPromises)).filter(Boolean) as DeriveTicker[];
      allTickers.push(...tickers);
    }

    if (allTickers.length === 0) {
      console.log("[derive] No ticker data available for HYPE options");
      return null;
    }

    // 4. Parse into option entries
    const spotPrice = parseFloat(allTickers[0]?.index_price || "0");
    if (spotPrice === 0) return null;

    const options: OptionEntry[] = [];
    let totalCallOI = 0;
    let totalPutOI = 0;
    const ivValues: number[] = [];

    for (const ticker of allTickers) {
      const details = ticker.option_details;
      const pricing = ticker.option_pricing;
      if (!details || !pricing) continue;

      const strike = parseFloat(details.strike);
      const isCall = details.option_type === "C";
      const oi = getTotalOI(ticker);
      const iv = parseFloat(pricing.iv || "0") * 100; // Convert 0.99 → 99%
      const delta = parseFloat(pricing.delta || "0");
      const gamma = parseFloat(pricing.gamma || "0");

      if (isCall) totalCallOI += oi;
      else totalPutOI += oi;

      if (iv > 0) ivValues.push(iv);

      options.push({
        strike,
        isCall,
        oi,
        iv,
        delta,
        gamma,
        expiry: details.expiry,
        expiryLabel: formatExpiryLabel(details.expiry),
      });
    }

    if (totalCallOI === 0 && totalPutOI === 0) return null;

    // 5. Compute metrics
    const { maxPain, expiry, topStrikes } = computeMaxPain(options);
    const maxPainDistance = spotPrice > 0 ? ((maxPain - spotPrice) / spotPrice) * 100 : 0;
    const putCallRatio = totalCallOI > 0 ? totalPutOI / totalCallOI : 0;

    // Weighted avg IV (weight by OI)
    let avgIv = 0;
    if (ivValues.length > 0) {
      avgIv = ivValues.reduce((a, b) => a + b, 0) / ivValues.length;
    }

    // IV Rank from history
    let ivRank = 50;
    if (ivHistoryCache && Date.now() - ivHistoryCache.fetchedAt < IV_HISTORY_TTL) {
      ivRank = computeIvRank(ivHistoryCache.values, avgIv);
    } else {
      // Store current IV in history for future rank calc
      const existing = ivHistoryCache?.values || [];
      existing.push(avgIv);
      // Keep last 90 data points
      if (existing.length > 90) existing.shift();
      ivHistoryCache = { values: existing, fetchedAt: Date.now() };
      ivRank = computeIvRank(existing, avgIv);
    }

    // 25-delta skew: find puts/calls closest to 0.25 abs delta in nearest expiry
    let skew25d = 0;
    const nearestExpiry = expiryDates[0];
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

      if (closest25Put && closest25Call) {
        skew25d = closest25Put.iv - closest25Call.iv;
      }
    }

    // GEX (Gamma Exposure)
    let totalGex = 0;
    for (const o of options) {
      const sign = o.isCall ? 1 : -1;
      totalGex += sign * o.gamma * o.oi * spotPrice * spotPrice * 0.01;
    }
    const gexM = totalGex / 1_000_000;
    let gexLevel: "dampening" | "amplifying" | "neutral" = "neutral";
    // Lower thresholds for HYPE (smaller market than BTC/ETH)
    if (gexM > 0.5) gexLevel = "dampening";
    else if (gexM < -0.5) gexLevel = "amplifying";

    // 24h volume
    let totalVolume24h = 0;
    for (const ticker of allTickers) {
      if (ticker.stats?.volume) {
        totalVolume24h += parseFloat(ticker.stats.volume);
      }
    }

    const snapshot: DeriveOptionsSnapshot = {
      currency: "HYPE",
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
      expiryDates: expiryDates.map(e => formatExpiryLabel(e)),
      totalVolume24h,
    };

    cache = snapshot;
    console.log(`[derive] HYPE options: ${options.length} instruments, IV=${avgIv.toFixed(1)}%, P/C=${putCallRatio.toFixed(2)}, MaxPain=$${maxPain}`);
    return snapshot;
  } catch (err) {
    console.error("[derive] Failed to fetch HYPE options:", (err as Error).message);
    return cache || null;
  }
}

/** Get HYPE options chain — full list of instruments with pricing for the options UI */
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

export async function getHypeOptionsChain(): Promise<{
  chain: DeriveOptionRow[];
  spotPrice: number;
  expiries: { label: string; timestamp: number }[];
} | null> {
  try {
    const instruments = await getHypeInstruments();
    if (instruments.length === 0) return null;

    // Group by expiry
    const expiryTimestamps = [...new Set(
      instruments
        .map(i => i.option_details?.expiry || 0)
        .filter(e => e * 1000 > Date.now())
    )].sort((a, b) => a - b);

    const chain: DeriveOptionRow[] = [];
    let spotPrice = 0;

    for (const expiryTs of expiryTimestamps) {
      const dateStr = formatExpiryDate(expiryTs);
      let tickers: Record<string, DeriveTicker> = {};
      try {
        tickers = await getTickersForExpiry(dateStr);
      } catch {
        // Fallback to individual
        const expiryInstruments = instruments
          .filter(i => i.option_details?.expiry === expiryTs)
          .slice(0, 40);
        const results = await Promise.all(
          expiryInstruments.map(i => getTickerForInstrument(i.instrument_name))
        );
        for (const t of results) {
          if (t) tickers[t.instrument_name] = t;
        }
      }

      for (const ticker of Object.values(tickers)) {
        const details = ticker.option_details;
        const pricing = ticker.option_pricing;
        if (!details || !pricing) continue;

        if (!spotPrice) spotPrice = parseFloat(ticker.index_price || "0");

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
    }

    // Sort by expiry then strike
    chain.sort((a, b) => a.expiryTimestamp - b.expiryTimestamp || a.strike - b.strike);

    return {
      chain,
      spotPrice,
      expiries: expiryTimestamps.map(ts => ({ label: formatExpiryLabel(ts), timestamp: ts })),
    };
  } catch (err) {
    console.error("[derive] Failed to fetch HYPE options chain:", (err as Error).message);
    return null;
  }
}
