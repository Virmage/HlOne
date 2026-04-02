/**
 * Social / trending metrics using CoinGecko (free, no key).
 * Combines trending data with on-chain metrics we already have.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SocialMetrics {
  coin: string;
  galaxyScore: number;       // 0-100 composite trending + market score
  altRank: number;            // rank among trending coins (1 = best)
  socialVolume: number;       // approximated from trending score
  socialDominance: number;    // % of trending mindshare
  sentiment: number;          // 0-100 derived from price change
  socialEngagement: number;   // approximated
  socialContributors: number; // approximated
  trendingScore: number;      // raw trending position score
  fetchedAt: number;
}

// ─── Cache ───────────────────────────────────────────────────────────────────

const cache = new Map<string, SocialMetrics>();
const CACHE_TTL = 5 * 60_000;

let batchCache: { data: SocialMetrics[]; fetchedAt: number } | null = null;
const BATCH_TTL = 5 * 60_000;

// ─── CoinGecko Fetcher ─────────────────────────────────────────────────────

interface GeckoTrendingCoin {
  item: {
    id: string;
    coin_id: number;
    name: string;
    symbol: string;
    market_cap_rank: number;
    price_btc: number;
    score: number; // trending rank (0 = top)
    data?: {
      price: number;
      price_change_percentage_24h?: Record<string, number>;
      market_cap?: string;
      total_volume?: string;
    };
  };
}

// Map CoinGecko symbols to Hyperliquid symbols
const SYMBOL_MAP: Record<string, string> = {
  WBTC: "BTC", WETH: "ETH", STETH: "ETH",
};

function normalizeSymbol(symbol: string): string {
  const upper = symbol.toUpperCase();
  return SYMBOL_MAP[upper] || upper;
}

async function fetchGeckoTrending(): Promise<GeckoTrendingCoin[]> {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/search/trending");
    if (!res.ok) {
      console.error(`[social] CoinGecko trending error: ${res.status}`);
      return [];
    }
    const data = await res.json() as { coins: GeckoTrendingCoin[] };
    return data.coins || [];
  } catch (err) {
    console.error("[social] CoinGecko fetch failed:", (err as Error).message);
    return [];
  }
}

async function fetchGeckoMarketData(): Promise<Map<string, { market_cap_rank: number; price_change_24h: number; total_volume: number }>> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false"
    );
    if (!res.ok) return new Map();
    const data = await res.json() as {
      symbol: string;
      market_cap_rank: number;
      price_change_percentage_24h: number;
      total_volume: number;
    }[];
    const map = new Map<string, { market_cap_rank: number; price_change_24h: number; total_volume: number }>();
    for (const coin of data) {
      const sym = normalizeSymbol(coin.symbol);
      map.set(sym, {
        market_cap_rank: coin.market_cap_rank || 999,
        price_change_24h: coin.price_change_percentage_24h || 0,
        total_volume: coin.total_volume || 0,
      });
    }
    return map;
  } catch (err) {
    console.error("[social] CoinGecko markets failed:", (err as Error).message);
    return new Map();
  }
}

function priceChangeToSentiment(change24h: number): number {
  // Map price change to 0-100 sentiment
  // -10% or worse = 10, 0% = 50, +10% or better = 90
  const clamped = Math.max(-10, Math.min(10, change24h));
  return Math.round(50 + clamped * 4);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Get social metrics for a specific coin */
export async function getSocialMetrics(coin: string): Promise<SocialMetrics | null> {
  const cached = cache.get(coin);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached;

  // Trigger batch fetch if stale
  await getBatchSocialMetrics();
  return cache.get(coin) || null;
}

/** Batch fetch trending + market social data */
export async function getBatchSocialMetrics(): Promise<SocialMetrics[]> {
  if (batchCache && Date.now() - batchCache.fetchedAt < BATCH_TTL) return batchCache.data;

  try {
    const [trending, markets] = await Promise.all([
      fetchGeckoTrending(),
      fetchGeckoMarketData(),
    ]);

    const results: SocialMetrics[] = [];
    const seen = new Set<string>();

    // First: trending coins get high galaxy scores
    for (let i = 0; i < trending.length; i++) {
      const coin = trending[i].item;
      const sym = normalizeSymbol(coin.symbol);
      if (seen.has(sym)) continue;
      seen.add(sym);

      const market = markets.get(sym);
      const change24h = market?.price_change_24h ?? (coin.data?.price_change_percentage_24h?.usd ?? 0);
      const volume = market?.total_volume ?? 0;

      // Trending coins: galaxy score 60-100 based on position
      const trendingBonus = Math.max(0, 100 - i * 3);
      const galaxyScore = Math.min(100, Math.round(trendingBonus * 0.7 + priceChangeToSentiment(change24h) * 0.3));

      const metrics: SocialMetrics = {
        coin: sym,
        galaxyScore,
        altRank: i + 1,
        socialVolume: Math.round(1000 - i * 60), // approximate
        socialDominance: Math.round((100 / trending.length) * (trending.length - i) * 10) / 10,
        sentiment: priceChangeToSentiment(change24h),
        socialEngagement: Math.round(10000 - i * 500),
        socialContributors: Math.round(500 - i * 30),
        trendingScore: 100 - i * (100 / trending.length),
        fetchedAt: Date.now(),
      };

      cache.set(sym, metrics);
      results.push(metrics);
    }

    // Then: top market-cap coins not in trending get moderate scores
    for (const [sym, market] of markets) {
      if (seen.has(sym)) continue;
      seen.add(sym);

      const rank = market.market_cap_rank;
      // Non-trending coins: galaxy score based on market cap rank + sentiment
      const rankScore = Math.max(0, 60 - rank * 0.5);
      const galaxyScore = Math.round(rankScore * 0.6 + priceChangeToSentiment(market.price_change_24h) * 0.4);

      const metrics: SocialMetrics = {
        coin: sym,
        galaxyScore: Math.min(100, Math.max(0, galaxyScore)),
        altRank: rank,
        socialVolume: Math.round(Math.max(0, 500 - rank * 5)),
        socialDominance: 0,
        sentiment: priceChangeToSentiment(market.price_change_24h),
        socialEngagement: Math.round(Math.max(0, 5000 - rank * 50)),
        socialContributors: Math.round(Math.max(0, 200 - rank * 2)),
        trendingScore: 0,
        fetchedAt: Date.now(),
      };

      cache.set(sym, metrics);
      results.push(metrics);
    }

    results.sort((a, b) => b.galaxyScore - a.galaxyScore);
    batchCache = { data: results, fetchedAt: Date.now() };
    console.log(`[social] Fetched ${trending.length} trending + ${markets.size} market coins`);
    return results;
  } catch (err) {
    console.error("[social] Batch fetch failed:", (err as Error).message);
    return batchCache?.data || [];
  }
}

/** Get cached social metrics (never blocks) */
export function getSocialMetricsCached(coin: string): SocialMetrics | null {
  const cached = cache.get(coin);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached;
  return null;
}

/** Get all cached metrics */
export function getAllSocialMetricsCached(): SocialMetrics[] {
  return batchCache?.data || [];
}
