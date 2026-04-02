/**
 * Macro / TradFi data service — fetches key market indices from Yahoo Finance.
 * Cached for 5 minutes to stay within rate limits.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MacroAsset {
  symbol: string;
  name: string;
  price: number;
  change24h: number; // percentage
  prevClose: number;
}

// ─── Config ─────────────────────────────────────────────────────────────────

const SYMBOLS: { symbol: string; name: string }[] = [
  // US Indices
  { symbol: "^GSPC", name: "S&P 500" },
  { symbol: "^IXIC", name: "Nasdaq" },
  { symbol: "^DJI", name: "Dow Jones" },
  { symbol: "^RUT", name: "Russell 2000" },
  { symbol: "^VIX", name: "VIX" },
  // Global Indices
  { symbol: "^FTSE", name: "FTSE 100" },
  { symbol: "^N225", name: "Nikkei 225" },
  { symbol: "^HSI", name: "Hang Seng" },
  // Commodities
  { symbol: "GC=F", name: "Gold" },
  { symbol: "SI=F", name: "Silver" },
  { symbol: "CL=F", name: "Oil (WTI)" },
  { symbol: "NG=F", name: "Nat Gas" },
  { symbol: "HG=F", name: "Copper" },
  // Currencies
  { symbol: "DX-Y.NYB", name: "DXY" },
  { symbol: "EURUSD=X", name: "EUR/USD" },
  { symbol: "GBPUSD=X", name: "GBP/USD" },
  { symbol: "JPY=X", name: "USD/JPY" },
  // Bonds
  { symbol: "^TNX", name: "10Y Yield" },
  { symbol: "^TYX", name: "30Y Yield" },
  { symbol: "^IRX", name: "3M T-Bill" },
];

const CACHE_TTL = 5 * 60_000; // 5 minutes
const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

// ─── Cache ──────────────────────────────────────────────────────────────────

let cache: { data: MacroAsset[]; fetchedAt: number } | null = null;

// ─── Fetching ───────────────────────────────────────────────────────────────

async function fetchSymbol(symbol: string, name: string): Promise<MacroAsset | null> {
  try {
    const url = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?range=2d&interval=1d`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.error(`[macro] Yahoo Finance ${symbol} returned ${res.status}`);
      return null;
    }

    const json = await res.json() as {
      chart?: {
        result?: [{
          meta?: {
            regularMarketPrice?: number;
            chartPreviousClose?: number;
            previousClose?: number;
          };
        }];
      };
    };

    const meta = json.chart?.result?.[0]?.meta;
    if (!meta) return null;

    const price = meta.regularMarketPrice ?? 0;
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? 0;
    const change24h = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;

    return {
      symbol,
      name,
      price,
      change24h: Math.round(change24h * 100) / 100,
      prevClose,
    };
  } catch (err) {
    console.error(`[macro] Failed to fetch ${symbol}:`, (err as Error).message);
    return null;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function getMacroData(): Promise<MacroAsset[]> {
  const results = await Promise.allSettled(
    SYMBOLS.map(s => fetchSymbol(s.symbol, s.name)),
  );

  const assets: MacroAsset[] = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      assets.push(r.value);
    }
  }

  cache = { data: assets, fetchedAt: Date.now() };
  console.log(`[macro] Fetched ${assets.length}/${SYMBOLS.length} macro assets`);
  return assets;
}

export function getMacroDataCached(): MacroAsset[] {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL) {
    return cache.data;
  }
  return cache?.data ?? [];
}
