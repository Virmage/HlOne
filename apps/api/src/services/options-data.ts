/**
 * Options data from Deribit — max pain, put/call ratio, implied volatility.
 * Free public API, no auth needed. Only for majors (BTC, ETH).
 */

const DERIBIT_API = "https://www.deribit.com/api/v2/public";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OptionsSnapshot {
  currency: string;
  maxPain: number;
  maxPainExpiry: string;
  putCallRatio: number;
  totalCallOI: number;
  totalPutOI: number;
  dvol: number; // 30-day implied volatility index
  topStrikes: { strike: number; callOI: number; putOI: number }[];
  fetchedAt: number;
}

interface BookSummary {
  instrument_name: string;
  open_interest: number;
  volume_usd: number;
  mark_price: number;
}

// ─── Cache ───────────────────────────────────────────────────────────────────

const cache = new Map<string, OptionsSnapshot>();
const CACHE_TTL = 5 * 60_000; // 5 minutes

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

async function getDvol(currency: string): Promise<number> {
  const now = Date.now();
  const data = await deribitGet("get_volatility_index_data", {
    currency,
    resolution: "3600",
    start_timestamp: String(now - 2 * 3600_000),
    end_timestamp: String(now),
  }) as { data: [number, number][] };

  if (data.data && data.data.length > 0) {
    return data.data[data.data.length - 1][1]; // Latest DVOL value
  }
  return 0;
}

// ─── Max Pain Calculation ────────────────────────────────────────────────────

function computeMaxPain(options: BookSummary[]): { maxPain: number; expiry: string; topStrikes: { strike: number; callOI: number; putOI: number }[] } {
  // Group by expiry
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

  // Find nearest expiry with meaningful OI
  const sorted = [...expiries.entries()]
    .map(([exp, opts]) => ({ exp, opts, totalOI: opts.reduce((s, o) => s + o.oi, 0) }))
    .filter(e => e.totalOI > 100)
    .sort((a, b) => a.exp.localeCompare(b.exp));

  if (sorted.length === 0) return { maxPain: 0, expiry: "", topStrikes: [] };

  const nearest = sorted[0];
  const strikes = [...new Set(nearest.opts.map(o => o.strike))].sort((a, b) => a - b);

  // Max pain: strike where total intrinsic value is minimized
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

const SUPPORTED = ["BTC", "ETH"];

export async function getOptionsData(currency: string): Promise<OptionsSnapshot | null> {
  if (!SUPPORTED.includes(currency)) return null;

  const cached = cache.get(currency);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached;

  try {
    const [bookSummary, dvol] = await Promise.all([
      getBookSummary(currency),
      getDvol(currency),
    ]);

    const totalCallOI = bookSummary
      .filter(b => b.instrument_name.endsWith("-C"))
      .reduce((s, b) => s + b.open_interest, 0);
    const totalPutOI = bookSummary
      .filter(b => b.instrument_name.endsWith("-P"))
      .reduce((s, b) => s + b.open_interest, 0);

    const { maxPain, expiry, topStrikes } = computeMaxPain(bookSummary);

    const snapshot: OptionsSnapshot = {
      currency,
      maxPain,
      maxPainExpiry: expiry,
      putCallRatio: totalCallOI > 0 ? totalPutOI / totalCallOI : 0,
      totalCallOI,
      totalPutOI,
      dvol,
      topStrikes,
      fetchedAt: Date.now(),
    };

    cache.set(currency, snapshot);
    return snapshot;
  } catch (err) {
    console.error(`[options] Failed to fetch ${currency} options:`, (err as Error).message);
    return cached || null; // Return stale cache on error
  }
}

/** Get options data for all supported currencies */
export async function getAllOptionsData(): Promise<Map<string, OptionsSnapshot>> {
  const results = new Map<string, OptionsSnapshot>();
  const promises = SUPPORTED.map(async (currency) => {
    const data = await getOptionsData(currency);
    if (data) results.set(currency, data);
  });
  await Promise.all(promises);
  return results;
}
