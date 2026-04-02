/**
 * Crypto news feed from CoinTelegraph + CoinDesk RSS feeds.
 * Free, no API key needed. Parses RSS XML into structured posts.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface NewsPost {
  id: number;
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  currencies: string[]; // extracted from title/description
  sentiment: "positive" | "negative" | "neutral";
  votes: { positive: number; negative: number; important: number; liked: number; toxic: number };
}

export interface NewsFeed {
  posts: NewsPost[];
  fetchedAt: number;
}

// ─── Cache ───────────────────────────────────────────────────────────────────

let cache: NewsFeed | null = null;
const CACHE_TTL = 3 * 60_000; // 3 minutes

const coinCache = new Map<string, { posts: NewsPost[]; fetchedAt: number }>();
const COIN_CACHE_TTL = 5 * 60_000;

// ─── Coin detection ─────────────────────────────────────────────────────────

const KNOWN_COINS = new Set([
  "BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "AVAX", "LINK", "DOT",
  "MATIC", "UNI", "NEAR", "APT", "ARB", "OP", "SUI", "SEI", "TIA",
  "JUP", "WIF", "PEPE", "BONK", "INJ", "FET", "RNDR", "STX", "TRX",
  "FIL", "ATOM", "LTC", "HYPE", "AAVE", "MKR", "CRV", "COMP",
]);

const COIN_NAMES: Record<string, string> = {
  bitcoin: "BTC", ethereum: "ETH", solana: "SOL", ripple: "XRP",
  dogecoin: "DOGE", cardano: "ADA", avalanche: "AVAX", chainlink: "LINK",
  polkadot: "DOT", polygon: "MATIC", uniswap: "UNI", near: "NEAR",
  aptos: "APT", arbitrum: "ARB", optimism: "OP", sui: "SUI",
  celestia: "TIA", jupiter: "JUP", pepe: "PEPE", injective: "INJ",
  litecoin: "LTC", aave: "AAVE", maker: "MKR", hyperliquid: "HYPE",
};

function extractCoins(text: string): string[] {
  const coins = new Set<string>();
  const upper = text.toUpperCase();
  const lower = text.toLowerCase();

  for (const coin of KNOWN_COINS) {
    // Match as whole word (e.g., "BTC" not inside "OBTC")
    const regex = new RegExp(`\\b${coin}\\b`);
    if (regex.test(upper)) coins.add(coin);
  }
  for (const [name, symbol] of Object.entries(COIN_NAMES)) {
    if (lower.includes(name)) coins.add(symbol);
  }
  return [...coins];
}

function guessSentiment(title: string): "positive" | "negative" | "neutral" {
  const t = title.toLowerCase();
  const bullish = ["surge", "soar", "rally", "bullish", "record", "ath", "pump", "boom", "breakout", "gains", "growth", "adoption"];
  const bearish = ["crash", "drop", "plunge", "bearish", "hack", "exploit", "dump", "liquidat", "ban", "fraud", "scam", "sec sues", "collapse"];

  const bullCount = bullish.filter(w => t.includes(w)).length;
  const bearCount = bearish.filter(w => t.includes(w)).length;

  if (bullCount > bearCount) return "positive";
  if (bearCount > bullCount) return "negative";
  return "neutral";
}

// ─── RSS Parser ─────────────────────────────────────────────────────────────

interface RSSSource {
  url: string;
  name: string;
}

const RSS_SOURCES: RSSSource[] = [
  { url: "https://cointelegraph.com/rss", name: "CoinTelegraph" },
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", name: "CoinDesk" },
];

async function fetchRSS(source: RSSSource): Promise<NewsPost[]> {
  try {
    const res = await fetch(source.url, {
      headers: { "Accept": "application/xml, text/xml, application/rss+xml" },
    });
    if (!res.ok) {
      console.error(`[news] RSS fetch failed for ${source.name}: ${res.status}`);
      return [];
    }

    const xml = await res.text();
    const posts: NewsPost[] = [];

    // Simple XML parsing for RSS items
    const items = xml.split("<item>").slice(1);
    for (let i = 0; i < Math.min(items.length, 25); i++) {
      const item = items[i];
      const title = extractTag(item, "title");
      const link = extractTag(item, "link");
      const pubDate = extractTag(item, "pubDate");
      const description = extractTag(item, "description");

      if (!title || !link) continue;

      const fullText = `${title} ${description || ""}`;
      const currencies = extractCoins(fullText);
      const sentiment = guessSentiment(title);

      posts.push({
        id: hashCode(link),
        title: cleanCDATA(title),
        url: link.trim(),
        source: source.name,
        publishedAt: pubDate || new Date().toISOString(),
        currencies,
        sentiment,
        votes: { positive: 0, negative: 0, important: 0, liked: 0, toxic: 0 },
      });
    }

    return posts;
  } catch (err) {
    console.error(`[news] RSS fetch error for ${source.name}:`, (err as Error).message);
    return [];
  }
}

function extractTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return match ? cleanCDATA(match[1].trim()) : "";
}

function cleanCDATA(s: string): string {
  return s.replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").replace(/<[^>]+>/g, "").trim();
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Get latest crypto news feed (all coins) */
export async function getNewsFeed(): Promise<NewsFeed> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL) return cache;

  const allPosts = await Promise.all(RSS_SOURCES.map(s => fetchRSS(s)));
  const posts = allPosts.flat()
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  cache = { posts, fetchedAt: Date.now() };
  console.log(`[news] Fetched ${posts.length} articles from ${RSS_SOURCES.length} sources`);
  return cache;
}

/** Get news for a specific coin */
export async function getCoinNews(coin: string): Promise<NewsPost[]> {
  const cached = coinCache.get(coin);
  if (cached && Date.now() - cached.fetchedAt < COIN_CACHE_TTL) return cached.posts;

  // Filter from the main feed
  const feed = await getNewsFeed();
  const posts = feed.posts.filter(p => p.currencies.includes(coin));
  coinCache.set(coin, { posts, fetchedAt: Date.now() });
  return posts;
}

/** Get cached feed (never blocks) */
export function getNewsFeedCached(): NewsFeed | null {
  return cache;
}
