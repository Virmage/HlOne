/**
 * Market intelligence API routes — powers the HLOne terminal.
 */

import type { FastifyPluginAsync } from "fastify";
import { getTokenOverviews, analyzeBook, getCachedAssetCtxs, resolveSpotName } from "../services/market-data.js";
import { getSmartMoneyCached } from "../services/smart-money.js";
import { getWhaleAlerts, getHotTokens, getWhaleAlertsForCoin, getHistoricalWhaleEvents } from "../services/whale-tracker.js";
import { getTokenScoresCached } from "../services/scoring.js";
import { getTraderDisplayName } from "../services/name-generator.js";
import { discoverActiveTraders, getCandleSnapshot, getFundingHistory, getL2Book, getRecentTrades, getClearinghouseState, getOpenOrders } from "../services/hyperliquid.js";
import { getOptionsData, getAllOptionsData, getOptionsDataCached, type OptionsSnapshot } from "../services/options-data.js";
import { getDeriveOptionsData, getAllDeriveOptionsData, getDeriveOptionsChain, getDeriveSupportedCoins, getDeriveOptionsCached } from "../services/derive-options.js";
import { getSignals, getSignalsCached } from "../services/signals.js";
import { getOICandlesForInterval, getExternalOICandles } from "../services/oi-tracker.js";
import { cacheGet, cacheSet, isRedisConnected } from "../services/cache.js";
import { getNewsFeedCached, getCoinNews, type NewsPost } from "../services/crypto-panic.js";
import { getAllSocialMetricsCached, getSocialMetricsCached, type SocialMetrics } from "../services/lunar-crush.js";
import { getLargeTradesCached } from "../services/trade-tape.js";
import { getMacroDataCached } from "../services/macro-data.js";
import { getTopTraderFills } from "../services/top-trader-fills.js";
import { getLiquidationHeatmap } from "../services/liquidation-heatmap.js";
import { getCorrelationMatrixCached } from "../services/correlation-matrix.js";
import { getOrderFlow } from "../services/order-flow.js";
import { getPositionConcentration } from "../services/position-concentration.js";
import { getWhaleAccumulation } from "../services/whale-accumulation.js";
import { getDeribitFlowCached } from "../services/deribit-flow.js";
import { getKoreanPremiumCached } from "../services/korean-premium.js";
import { getEcosystemCached, fetchEcosystemData } from "../services/hyperliquid-ecosystem.js";
import { logTrade, getTradeLog, getTradeStats } from "../services/trade-log.js";
import { z } from "zod";
import { ethAddress, positiveNumber, nonNegativeNumber, coinName } from "../lib/validation.js";

const TradeLogSchema = z.object({
  userAddress: ethAddress,
  asset: coinName,
  side: z.enum(["buy", "sell"]),
  orderType: z.enum(["market", "limit"]),
  size: positiveNumber,
  price: positiveNumber,
  success: z.boolean(),
  orderId: z.string().max(100).optional(),
  filledSize: z.string().max(50).optional(),
  avgPrice: z.string().max(50).optional(),
  error: z.string().max(500).optional(),
  latencyMs: nonNegativeNumber,
});

// ─── Helpers ──────────────────────────────────────────────────────────────

async function buildFundingLeaderboard() {
  const ctxs = await getCachedAssetCtxs();
  const entries: { coin: string; fundingRate: number; annualized: number; openInterest: number }[] = [];

  for (const [coin, ctx] of ctxs) {
    const rate = parseFloat(ctx.funding || "0");
    const price = parseFloat(ctx.markPx || ctx.midPx || "0");
    const oiCoins = parseFloat(ctx.openInterest || "0");
    entries.push({
      coin,
      fundingRate: rate,
      annualized: Math.round(rate * 24 * 365 * 100 * 10) / 10, // 1 decimal
      openInterest: Math.round(oiCoins * price),
    });
  }

  const sorted = entries.filter(e => e.fundingRate !== 0);
  const topPositive = sorted
    .filter(e => e.fundingRate > 0)
    .sort((a, b) => b.fundingRate - a.fundingRate)
    .slice(0, 10);
  const topNegative = sorted
    .filter(e => e.fundingRate < 0)
    .sort((a, b) => a.fundingRate - b.fundingRate)
    .slice(0, 10);

  return { topPositive, topNegative };
}

// ─── Pre-warm top coin token details (called by background jobs) ────────────
// Fetches token detail for top coins so user requests always hit cache.
const TOP_COINS_TO_PREWARM = ["BTC", "ETH", "SOL", "HYPE", "XRP", "DOGE", "AVAX", "SUI", "LINK", "ADA"];
let prewarmPort = 0;

export function setPrewarmPort(port: number) { prewarmPort = port; }

export async function prewarmTokenDetails(): Promise<void> {
  if (!prewarmPort) return;
  const interval = "1h"; // default chart interval
  for (const coin of TOP_COINS_TO_PREWARM) {
    try {
      await fetch(`http://127.0.0.1:${prewarmPort}/api/market/token/${coin}?interval=${interval}`, {
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      // Non-critical — just warming cache
    }
  }
  console.log(`[prewarm] Warmed token detail cache for ${TOP_COINS_TO_PREWARM.length} coins`);
}

// ─── Terminal response cache ────────────────────────────────────────────────
// Cache the full /terminal response for 10s so N concurrent users = 1 computation.
let terminalCache: { data: unknown; fetchedAt: number } | null = null;
let terminalInFlight: Promise<unknown> | null = null;
const TERMINAL_CACHE_TTL = 10_000; // 10 seconds

// ─── Token detail response cache ────────────────────────────────────────────
// Cache per coin+interval so N users viewing BTC-1h = 1 computation.
const tokenDetailCache = new Map<string, { data: unknown; fetchedAt: number }>();
const tokenDetailInFlight = new Map<string, Promise<unknown>>();
const TOKEN_DETAIL_CACHE_TTL = 10_000; // 10 seconds

// ─── Sub-query caches (avoid redundant fetches per terminal request) ────────
let fundingCache: { data: { topPositive: unknown[]; topNegative: unknown[] }; fetchedAt: number } | null = null;
const FUNDING_CACHE_TTL = 30_000; // 30 seconds

let tradersCache: { data: unknown[]; fetchedAt: number } | null = null;
const TRADERS_CACHE_TTL = 60_000; // 60 seconds

export const marketRoutes: FastifyPluginAsync = async (app) => {
  // Cache-Control headers for browser/CDN caching
  app.addHook("onSend", async (req, reply) => {
    if (req.url === "/api/market/terminal") {
      reply.header("Cache-Control", "public, max-age=10, stale-while-revalidate=30");
    } else if (req.url.startsWith("/api/market/token/")) {
      reply.header("Cache-Control", "public, max-age=5, stale-while-revalidate=15");
    }
  });

  /**
   * GET /api/market/terminal
   * Returns everything the main dashboard needs in one call.
   */
  app.get("/terminal", async (req) => {
    // 1. Local memory cache (fastest)
    if (terminalCache && Date.now() - terminalCache.fetchedAt < TERMINAL_CACHE_TTL) {
      return terminalCache.data;
    }
    // 2. Redis cache (shared across instances)
    const redisCached = await cacheGet<unknown>("terminal");
    if (redisCached) {
      terminalCache = { data: redisCached, fetchedAt: Date.now() };
      return redisCached;
    }
    // 3. Deduplicate in-flight requests
    if (terminalInFlight) return terminalInFlight;

    terminalInFlight = (async () => {
    // Use cached smart money + scores (instant). Background jobs populate these.
    // Only getTokenOverviews() makes a live API call (fast — just allMids + assetCtxs).
    const overviews = await getTokenOverviews();
    const smartMoney = getSmartMoneyCached();
    const scores = getTokenScoresCached();

    const whaleAlerts = getWhaleAlerts(20);
    const hotTokens = getHotTokens(10);

    // All tokens with scores (perps + spot + HIP-3 tradfi)
    const tokenData = overviews.map(t => ({
      ...t,
      score: scores.get(t.coin) || null,
    }));

    // Build overview lookup map (O(1) instead of O(n) per flow entry)
    const overviewMap = new Map(overviews.map(o => [o.coin, o]));

    // Sharp flow — top tokens by smart money interest, min 5 rows
    const rawFlow = smartMoney?.flow.slice(0, 30).map(f => {
      const ov = overviewMap.get(f.coin);
      return {
        ...f,
        score: scores.get(f.coin)?.score ?? null,
        signal: scores.get(f.coin)?.signal ?? "neutral",
        price: ov?.price ?? 0,
        change24h: ov?.change24h ?? 0,
        volume24h: ov?.volume24h ?? 0,
        fundingRate: ov?.fundingRate ?? 0,
      };
    }) || [];

    // Pad with top coins by volume if fewer than 5 sharp flow entries
    const MIN_SHARP_ROWS = 5;
    const sharpFlow = [...rawFlow];
    if (sharpFlow.length < MIN_SHARP_ROWS) {
      const existingCoins = new Set(sharpFlow.map(f => f.coin));
      for (const t of overviews) {
        if (sharpFlow.length >= MIN_SHARP_ROWS) break;
        if (existingCoins.has(t.coin)) continue;
        sharpFlow.push({
          coin: t.coin,
          sharpDirection: "neutral" as const,
          sharpStrength: 0,
          sharpLongCount: 0,
          sharpShortCount: 0,
          sharpNetSize: 0,
          sharpAvgEntry: 0,
          squareDirection: "neutral" as const,
          squareStrength: 0,
          squareLongCount: 0,
          squareShortCount: 0,
          squareNetSize: 0,
          consensus: "neutral" as const,
          divergence: false,
          divergenceScore: 0,
          score: scores.get(t.coin)?.score ?? null,
          signal: scores.get(t.coin)?.signal ?? "neutral",
          price: t.price,
          change24h: t.change24h,
          volume24h: t.volume24h,
          fundingRate: t.fundingRate,
        });
      }
    }

    // Divergences
    const divergences = smartMoney?.divergences.slice(0, 10).map(d => {
      const ov = overviewMap.get(d.coin);
      return {
        ...d,
        score: scores.get(d.coin)?.score ?? null,
        price: ov?.price ?? 0,
        change24h: ov?.change24h ?? 0,
      };
    }) || [];

    // Top traders (mini leaderboard) — cached 60s to avoid fetching 32K traders per request
    let topTraders: {
      address: string;
      displayName: string;
      accountValue: number;
      roi30d: number;
      roiAllTime: number;
      totalPnl: number;
      isSharp: boolean;
    }[] = [];
    try {
      const now = Date.now();
      if (tradersCache && now - tradersCache.fetchedAt < TRADERS_CACHE_TTL) {
        topTraders = tradersCache.data as typeof topTraders;
      } else {
        const allTraders = await discoverActiveTraders();
        // Only show sharp traders in top traders, sorted by trader score
        const scores = smartMoney?.traderScores;
        topTraders = allTraders
          .filter(t => smartMoney?.sharpAddresses.has(t.address.toLowerCase()))
          .sort((a, b) => {
            const scoreA = scores?.get(a.address.toLowerCase()) || 0;
            const scoreB = scores?.get(b.address.toLowerCase()) || 0;
            return scoreB - scoreA;
          })
          .slice(0, 20)
          .map(t => ({
            address: t.address,
            displayName: getTraderDisplayName(t.address, t.displayName),
            accountValue: t.accountValue,
            roi30d: t.roi30d,
            roiAllTime: t.roiAllTime,
            totalPnl: t.totalPnl,
            isSharp: true,
          }));
        tradersCache = { data: topTraders, fetchedAt: now };
      }
    } catch { /* ignore */ }

    // Options data: BTC/ETH/SOL/HYPE from Derive, XRP/AVAX/TRX from Deribit
    let optionsData: Record<string, OptionsSnapshot> = {};
    try {
      const deriveSupportedCoins = new Set(getDeriveSupportedCoins());
      // Use cached data (populated by background jobs) — never block terminal
      const deriveOpts = getDeriveOptionsCached();
      const deribitOpts = getOptionsDataCached();
      // Derive is primary for BTC/ETH/SOL/HYPE
      for (const [k, v] of deriveOpts) {
        optionsData[k] = {
          currency: v.currency,
          maxPain: v.maxPain,
          maxPainExpiry: v.maxPainExpiry,
          maxPainDistance: v.maxPainDistance,
          putCallRatio: v.putCallRatio,
          totalCallOI: v.totalCallOI,
          totalPutOI: v.totalPutOI,
          dvol: v.dvol,
          ivRank: v.ivRank,
          skew25d: v.skew25d,
          gex: v.gex,
          gexLevel: v.gexLevel,
          topStrikes: v.topStrikes,
          fetchedAt: v.fetchedAt,
        };
      }
      // Deribit fills in coins Derive doesn't have (XRP, AVAX, TRX)
      for (const [k, v] of deribitOpts) {
        if (!deriveSupportedCoins.has(k)) optionsData[k] = v;
      }
    } catch { /* ignore */ }

    // Signals: unusual volume, funding arb, position crowding, market regime
    const signalsData = getSignalsCached();

    // News (CryptoPanic) + Social (LunarCrush) — cached, never blocks
    const newsFeed = getNewsFeedCached();
    const socialMetrics = getAllSocialMetricsCached();

    // Funding leaderboard — cached 30s
    let funding: { topPositive: unknown[]; topNegative: unknown[] };
    const fnow = Date.now();
    if (fundingCache && fnow - fundingCache.fetchedAt < FUNDING_CACHE_TTL) {
      funding = fundingCache.data;
    } else {
      funding = await buildFundingLeaderboard().catch(() => ({ topPositive: [], topNegative: [] }));
      fundingCache = { data: funding, fetchedAt: fnow };
    }

    // Large trades (cached, never blocks)
    const largeTrades = getLargeTradesCached().slice(0, 10);

    // Macro data (cached, never blocks)
    const macro = getMacroDataCached();

    // New data panels (all cached/computed, never block)
    const liquidationHeatmap = getLiquidationHeatmap();
    const correlationMatrix = getCorrelationMatrixCached();
    const orderFlow = getOrderFlow();
    const positionConcentration = await getPositionConcentration().catch(() => []);
    const whaleAccumulation = getWhaleAccumulation();
    const deribitFlow = getDeribitFlowCached();
    const koreanPremium = getKoreanPremiumCached();
    const ecosystem = getEcosystemCached();

    const result = {
      tokens: tokenData,
      sharpFlow,
      divergences,
      whaleAlerts,
      hotTokens,
      topTraders,
      options: optionsData,
      signals: signalsData?.signals || [],
      fundingOpps: signalsData?.fundingOpps.slice(0, 5) || [],
      regime: signalsData?.regime || null,
      callout: signalsData?.callout || null,
      news: newsFeed?.posts.slice(0, 10) || [],
      social: socialMetrics.slice(0, 20),
      funding,
      largeTrades,
      macro,
      liquidationHeatmap,
      correlationMatrix,
      orderFlow,
      positionConcentration,
      whaleAccumulation,
      deribitFlow,
      koreanPremium,
      ecosystem,
      timestamp: Date.now(),
    };
    terminalCache = { data: result, fetchedAt: Date.now() };
    cacheSet("terminal", result, TERMINAL_CACHE_TTL).catch(() => {});
    return result;
    })().finally(() => { terminalInFlight = null; });

    return terminalInFlight;
  });

  /**
   * GET /api/market/token/:coin
   * Token deep dive — everything about a specific token.
   */
  app.get<{ Params: { coin: string }; Querystring: { interval?: string } }>(
    "/token/:coin",
    async (req) => {
      const rawCoin = decodeURIComponent(req.params.coin);
      // Resolve display names (e.g. "WATER") to Hyperliquid pair identifiers (e.g. "@155")
      const coin = resolveSpotName(rawCoin);
      const interval = (req.query.interval as string) || "1h";
      const cacheKey = `${coin}_${interval}`;

      // 1. Local memory cache
      const cached = tokenDetailCache.get(cacheKey);
      if (cached && Date.now() - cached.fetchedAt < TOKEN_DETAIL_CACHE_TTL) {
        return cached.data;
      }
      // 2. Redis cache (shared across instances)
      const redisCached = await cacheGet<unknown>(`token:${cacheKey}`);
      if (redisCached) {
        tokenDetailCache.set(cacheKey, { data: redisCached, fetchedAt: Date.now() });
        return redisCached;
      }
      // 3. Dedup in-flight requests
      if (tokenDetailInFlight.has(cacheKey)) return tokenDetailInFlight.get(cacheKey);

      const flight = (async () => {
      const now = Date.now();

      // Fetch everything in parallel
      // Use cached smart money data (instant) — never block on position scan
      const smartMoney = getSmartMoneyCached();
      const sharpPositions = (smartMoney?.sharpPositions.get(coin)) || [];
      const score = getTokenScoresCached().get(coin) || null;

      // Adjust lookback based on interval
      const lookbackMs: Record<string, number> = {
        "5m": 2 * 24 * 3600_000,   // 2 days
        "15m": 5 * 24 * 3600_000,  // 5 days
        "1h": 14 * 24 * 3600_000,  // 14 days
        "4h": 30 * 24 * 3600_000,  // 30 days
        "12h": 60 * 24 * 3600_000, // 60 days
        "1d": 365 * 24 * 3600_000, // 1 year
        "1w": 3 * 365 * 24 * 3600_000, // 3 years
        "1M": 5 * 365 * 24 * 3600_000, // 5 years
      };
      const candleSince = now - (lookbackMs[interval] || 7 * 24 * 3600_000);

      // Critical path: candles first (needed for chart render).
      // Non-critical data loaded in parallel but doesn't block candles.
      const deriveSupportedCoins = new Set(getDeriveSupportedCoins());
      const useDerive = deriveSupportedCoins.has(coin);

      const [
        candles,
        bookAnalysis,
        funding,
        whaleAlerts,
        deriveOptions,
        deribitOptions,
        overviews,
      ] = await Promise.all([
        getCandleSnapshot(coin, interval, candleSince, now).catch(() => []),
        analyzeBook(coin).catch(() => null),
        getFundingHistory(coin, now - 3 * 24 * 60 * 60 * 1000).catch(() => []),
        getHistoricalWhaleEvents(coin, interval, candleSince),
        useDerive ? getDeriveOptionsData(coin).catch(() => null) : Promise.resolve(null),
        !useDerive ? getOptionsData(coin).catch(() => null) : Promise.resolve(null),
        getTokenOverviews().catch(() => []),
      ]);

      // Derive for BTC/ETH/SOL/HYPE, Deribit for others
      const options: OptionsSnapshot | null = deriveOptions ? {
        currency: deriveOptions.currency,
        maxPain: deriveOptions.maxPain,
        maxPainExpiry: deriveOptions.maxPainExpiry,
        maxPainDistance: deriveOptions.maxPainDistance,
        putCallRatio: deriveOptions.putCallRatio,
        totalCallOI: deriveOptions.totalCallOI,
        totalPutOI: deriveOptions.totalPutOI,
        dvol: deriveOptions.dvol,
        ivRank: deriveOptions.ivRank,
        skew25d: deriveOptions.skew25d,
        gex: deriveOptions.gex,
        gexLevel: deriveOptions.gexLevel,
        topStrikes: deriveOptions.topStrikes,
        fetchedAt: deriveOptions.fetchedAt,
      } : deribitOptions;

      const overview = overviews.find(o => o.coin === coin) || null;

      // Compute funding regime description
      let fundingRegime = "";
      if (funding.length > 0) {
        const recent = funding.slice(-24); // last 24 hours
        const avgRate = recent.reduce((sum, f) => sum + parseFloat(f.fundingRate), 0) / recent.length;
        const annualized = avgRate * 24 * 365 * 100;
        if (annualized > 10) fundingRegime = `Positive ${annualized.toFixed(1)}% annualized — longs paying, crowded long`;
        else if (annualized > 2) fundingRegime = `Slightly positive ${annualized.toFixed(1)}% — mild long bias`;
        else if (annualized < -10) fundingRegime = `Negative ${annualized.toFixed(1)}% — shorts paying, contrarian long signal`;
        else if (annualized < -2) fundingRegime = `Slightly negative ${annualized.toFixed(1)}% — mild short bias`;
        else fundingRegime = `Neutral ${annualized.toFixed(1)}% — balanced market`;

        // Check for streaks
        let streak = 0;
        const isPositive = parseFloat(funding[funding.length - 1].fundingRate) > 0;
        for (let i = funding.length - 1; i >= 0; i--) {
          if ((parseFloat(funding[i].fundingRate) > 0) === isPositive) streak++;
          else break;
        }
        if (streak > 24) {
          fundingRegime += ` (${Math.floor(streak / 24)}d streak of ${isPositive ? "positive" : "negative"} funding)`;
        }
      }

      // Liquidation clusters from sharp positions
      const liquidationClusters: { price: number; side: string; totalValue: number; traderCount: number }[] = [];
      const liqMap = new Map<string, { side: string; totalValue: number; count: number }>();
      for (const pos of sharpPositions) {
        if (pos.liquidationPx) {
          // Round to nearest significant level
          const rounded = Math.round(pos.liquidationPx / (pos.liquidationPx * 0.005)) * (pos.liquidationPx * 0.005);
          const key = `${rounded.toFixed(2)}_${pos.side}`;
          const existing = liqMap.get(key) || { side: pos.side, totalValue: 0, count: 0 };
          existing.totalValue += pos.positionValue;
          existing.count++;
          liqMap.set(key, existing);
        }
      }
      for (const [key, val] of liqMap) {
        const price = parseFloat(key.split("_")[0]);
        if (val.count >= 2) { // Only show clusters of 2+ traders
          liquidationClusters.push({ price, side: val.side, totalValue: val.totalValue, traderCount: val.count });
        }
      }
      liquidationClusters.sort((a, b) => a.price - b.price);

      // OI candles from in-memory tracker
      // Match OI candle count to price candle lookback
      const oiCountMap: Record<string, number> = {
        "5m": 576,   // 2 days of 5m
        "15m": 480,  // 5 days of 15m
        "1h": 336,   // 14 days of 1h
        "4h": 180,   // 30 days of 4h
        "12h": 120,  // 60 days of 12h
        "1d": 365,
        "1w": 156,
        "1M": 60,
      };
      let oiCandles = getOICandlesForInterval(coin, interval, oiCountMap[interval] || 200);
      // Try external sources (Binance free, Coinalyze if key set) and use whichever has more data
      try {
        const externalOI = await getExternalOICandles(coin, interval, candleSince, now);
        if (externalOI.length > oiCandles.length) {
          oiCandles = externalOI;
        }
      } catch { /* ignore — local data is still usable */ }

      // Top trader fills for chart markers
      const topTraderFillsRaw = getTopTraderFills(coin, candleSince);
      // Aggregate fills by trader+candle to avoid clutter — keep top fills per candle period
      const topTraderFillsData = topTraderFillsRaw.map(f => ({
        time: f.time,
        side: f.side,
        price: f.price,
        sizeUsd: f.sizeUsd,
        trader: f.trader,
        address: f.address,
        accountValue: f.accountValue,
      }));

      // Coin-specific news + social
      const coinNews = await getCoinNews(coin).catch(() => [] as NewsPost[]);
      const coinSocial = getSocialMetricsCached(coin);

      // Coin-specific sharp/square flow
      const flow = smartMoney?.flow.find(f => f.coin === coin);
      const coinFlow = flow ? {
        sharpLongCount: flow.sharpLongCount,
        sharpShortCount: flow.sharpShortCount,
        sharpStrength: flow.sharpStrength,
        sharpDirection: flow.sharpDirection,
        squareLongCount: flow.squareLongCount,
        squareShortCount: flow.squareShortCount,
        squareStrength: flow.squareStrength,
        squareDirection: flow.squareDirection,
        consensus: flow.consensus,
        divergence: flow.divergence,
      } : null;

      // Coin-specific whale accumulation
      const allAccum = getWhaleAccumulation();
      const coinAccum = allAccum.find(a => a.coin === coin) || null;

      return {
        coin,
        overview,
        score,
        sharpPositions: sharpPositions.sort((a, b) => b.positionValue - a.positionValue),
        bookAnalysis,
        oiCandles,
        candles: candles.map(c => ({
          time: c.t,
          open: parseFloat(c.o),
          high: parseFloat(c.h),
          low: parseFloat(c.l),
          close: parseFloat(c.c),
          volume: parseFloat(c.v),
        })),
        funding: funding.map(f => ({
          time: f.time,
          rate: parseFloat(f.fundingRate),
          annualized: parseFloat(f.fundingRate) * 24 * 365 * 100,
        })),
        fundingRegime,
        liquidationClusters,
        whaleAlerts,
        topTraderFills: topTraderFillsData,
        options, // null for non-supported coins
        news: coinNews.slice(0, 10),
        social: coinSocial,
        coinFlow,
        coinAccumulation: coinAccum,
        timestamp: Date.now(),
      };
      })();

      tokenDetailInFlight.set(cacheKey, flight);
      const result = await flight.finally(() => tokenDetailInFlight.delete(cacheKey));
      tokenDetailCache.set(cacheKey, { data: result, fetchedAt: Date.now() });
      cacheSet(`token:${cacheKey}`, result, TOKEN_DETAIL_CACHE_TTL).catch(() => {});
      // Evict stale entries (keep cache bounded)
      if (tokenDetailCache.size > 100) {
        const cutoff = Date.now() - TOKEN_DETAIL_CACHE_TTL * 3;
        for (const [k, v] of tokenDetailCache) { if (v.fetchedAt < cutoff) tokenDetailCache.delete(k); }
      }
      return result;
    },
  );

  /**
   * GET /api/market/oi/:coin
   * Lightweight OI-only endpoint — loads in ~200ms instead of waiting for full token detail.
   */
  app.get<{ Params: { coin: string }; Querystring: { interval?: string } }>(
    "/oi/:coin",
    async (req) => {
      const coin = resolveSpotName(decodeURIComponent(req.params.coin));
      const interval = req.query.interval || "1h";
      const oiCountMap: Record<string, number> = {
        "5m": 576, "15m": 480, "1h": 336, "4h": 180,
        "12h": 120, "1d": 365, "1w": 156, "1M": 60,
      };
      let oiCandles = getOICandlesForInterval(coin, interval, oiCountMap[interval] || 200);
      try {
        const intervalMs = { "5m": 5*60e3, "15m": 15*60e3, "1h": 60*60e3, "4h": 4*60*60e3, "12h": 12*60*60e3, "1d": 86400e3, "1w": 7*86400e3, "1M": 30*86400e3 }[interval] || 60*60e3;
        const count = oiCountMap[interval] || 200;
        const now = Date.now();
        const from = now - intervalMs * count;
        const externalOI = await getExternalOICandles(coin, interval, from, now);
        if (externalOI.length > oiCandles.length) oiCandles = externalOI;
      } catch { /* local data is still usable */ }
      return { coin, interval, oiCandles, timestamp: Date.now() };
    },
  );

  /**
   * GET /api/market/candles/:coin
   * Lightweight candles-only endpoint — ~200ms, used for fast timeframe switching.
   */
  app.get<{ Params: { coin: string }; Querystring: { interval?: string } }>(
    "/candles/:coin",
    async (req) => {
      const rawCoin = decodeURIComponent(req.params.coin);
      const coin = resolveSpotName(rawCoin);
      const interval = req.query.interval || "1h";
      const lookbackMs: Record<string, number> = {
        "5m": 2 * 86400_000, "15m": 5 * 86400_000, "1h": 14 * 86400_000,
        "4h": 30 * 86400_000, "12h": 60 * 86400_000, "1d": 365 * 86400_000,
        "1w": 3 * 365 * 86400_000, "1M": 5 * 365 * 86400_000,
      };
      const now = Date.now();
      const startTime = now - (lookbackMs[interval] || 7 * 86400_000);
      const raw = await getCandleSnapshot(coin, interval, startTime, now);
      return {
        coin, interval,
        candles: raw.map(c => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v })),
        timestamp: now,
      };
    },
  );

  /**
   * GET /api/market/whale-alerts
   * Standalone whale alerts endpoint for polling.
   */
  app.get<{ Querystring: { limit?: string; coin?: string } }>(
    "/whale-alerts",
    async (req) => {
      const limit = Math.min(Math.max(1, parseInt(req.query.limit || "50") || 50), 200);
      const coin = req.query.coin;
      return {
        alerts: getWhaleAlerts(limit, coin),
        hotTokens: getHotTokens(10),
        timestamp: Date.now(),
      };
    },
  );

  /**
   * GET /api/market/book/:coin
   * L2 order book + recent trades for a coin.
   */
  app.get<{ Params: { coin: string } }>(
    "/book/:coin",
    async (req) => {
      const { coin } = req.params;
      const [book, trades] = await Promise.all([
        getL2Book(coin).catch(() => ({ levels: [[], []] })),
        getRecentTrades(coin).catch(() => []),
      ]);
      return {
        bids: (book.levels[0] || []).slice(0, 15),
        asks: (book.levels[1] || []).slice(0, 15),
        trades: (trades as { px: string; sz: string; side: string; time: number }[]).slice(0, 30),
      };
    },
  );

  /**
   * GET /api/market/scores
   * All HLOne scores.
   */
  app.get("/scores", async () => {
    const scores = getTokenScoresCached();
    return {
      scores: [...scores.values()].sort((a, b) => b.score - a.score),
      timestamp: Date.now(),
    };
  });

  /**
   * GET /api/market/funding
   * Top positive and negative funding rates.
   */
  app.get("/funding", async () => {
    const { topPositive, topNegative } = await buildFundingLeaderboard();
    return {
      topPositive,
      topNegative,
      timestamp: Date.now(),
    };
  });

  /**
   * GET /api/market/trades
   * Recent large trades across top coins.
   */
  app.get<{ Querystring: { limit?: string } }>(
    "/trades",
    async (req) => {
      const limit = Math.min(Math.max(1, parseInt(req.query.limit || "50") || 50), 200);
      return {
        trades: getLargeTradesCached().slice(0, limit),
        timestamp: Date.now(),
      };
    },
  );

  /**
   * POST /api/market/trade-log
   * Log a trade executed from the frontend (for auditing + fee tracking).
   * Called by the trading panel after every order attempt.
   */
  app.post("/trade-log", async (req, reply) => {
    const parsed = TradeLogSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid input", details: parsed.error.flatten().fieldErrors };
    }

    const b = parsed.data;
    const notionalUsd = b.size * b.price;
    const feeEstimatedUsd = notionalUsd * 0.0002; // 0.02% builder fee

    logTrade({
      userAddress: b.userAddress,
      asset: b.asset,
      side: b.side,
      orderType: b.orderType,
      size: b.size,
      price: b.price,
      notionalUsd,
      feeEstimatedUsd,
      success: b.success,
      orderId: b.orderId,
      filledSize: b.filledSize,
      avgPrice: b.avgPrice,
      error: b.error,
      latencyMs: b.latencyMs,
    });

    return { ok: true };
  });

  /**
   * GET /api/market/trade-stats
   * Dashboard for trade volume, fees, success rates.
   */
  app.get("/trade-stats", async () => {
    return {
      stats: getTradeStats(),
      recentTrades: getTradeLog(20),
      timestamp: Date.now(),
    };
  });

  /**
   * GET /api/market/positions/:address
   * User's open Hyperliquid positions + account overview.
   */
  app.get<{ Params: { address: string } }>(
    "/positions/:address",
    async (req, reply) => {
      const { address } = req.params;
      if (!ethAddress.safeParse(address).success) {
        reply.code(400);
        return { error: "Invalid address format" };
      }
      const [state, orders, midsRaw, frontendOrders] = await Promise.all([
        getClearinghouseState(address).catch(() => null),
        getOpenOrders(address).catch(() => []),
        fetch("https://api.hyperliquid.xyz/info", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "allMids" }),
        }).then(r => r.json()).catch(() => ({} as Record<string, string>)),
        // Fetch trigger orders (TP/SL) via frontendOpenOrders
        fetch("https://api.hyperliquid.xyz/info", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "frontendOpenOrders", user: address }),
        }).then(r => r.json()).catch(() => []),
      ]);
      const mids = midsRaw as Record<string, string>;

      // Build TP/SL map from trigger orders
      const tpSlMap: Record<string, { tp?: string; sl?: string }> = {};
      if (Array.isArray(frontendOrders)) {
        for (const o of frontendOrders as { coin: string; orderType: string; triggerPx?: string; isTrigger?: boolean; order?: { triggerCondition?: string } }[]) {
          if (!o.orderType?.startsWith("Stop") && !o.orderType?.startsWith("Take")) continue;
          const coin = o.coin;
          if (!tpSlMap[coin]) tpSlMap[coin] = {};
          if (o.orderType.startsWith("Take")) {
            tpSlMap[coin].tp = o.triggerPx || "";
          } else if (o.orderType.startsWith("Stop")) {
            tpSlMap[coin].sl = o.triggerPx || "";
          }
        }
      }

      if (!state) {
        return { positions: [], account: null, openOrders: [], triggerOrders: tpSlMap, timestamp: Date.now() };
      }

      const s = state as {
        assetPositions: {
          position: {
            coin: string;
            szi: string;
            entryPx: string;
            positionValue: string;
            unrealizedPnl: string;
            leverage: { type: string; value: number };
            liquidationPx: string | null;
            marginUsed: string;
            returnOnEquity: string;
          };
        }[];
        crossMarginSummary: {
          accountValue: string;
          totalMarginUsed: string;
          totalNtlPos: string;
          totalRawUsd: string;
          withdrawable: string;
        };
        marginSummary: {
          accountValue: string;
          totalMarginUsed: string;
          totalNtlPos: string;
          totalRawUsd: string;
        };
      };

      const positions = s.assetPositions
        .filter(ap => parseFloat(ap.position.szi) !== 0)
        .map(ap => {
          const p = ap.position;
          const size = parseFloat(p.szi);
          const midCoin = p.coin.includes(":") ? p.coin.split(":")[1] : p.coin;
          return {
            coin: p.coin,
            side: size > 0 ? "long" as const : "short" as const,
            size: Math.abs(size),
            entryPx: parseFloat(p.entryPx),
            markPx: parseFloat(mids[midCoin] || mids[p.coin] || "0"),
            positionValue: parseFloat(p.positionValue),
            unrealizedPnl: parseFloat(p.unrealizedPnl),
            leverage: p.leverage?.value ?? 0,
            leverageType: (p.leverage?.type || "cross") as "cross" | "isolated",
            liquidationPx: p.liquidationPx ? parseFloat(p.liquidationPx) : null,
            marginUsed: parseFloat(p.marginUsed),
            returnOnEquity: parseFloat(p.returnOnEquity || "0"),
            cumFunding: parseFloat((p as unknown as { cumFunding?: { allTime?: string } }).cumFunding?.allTime || "0"),
          };
        })
        .sort((a, b) => Math.abs(b.positionValue) - Math.abs(a.positionValue));

      const cs = s.crossMarginSummary || s.marginSummary;
      const account = cs ? {
        accountValue: parseFloat(cs.accountValue),
        totalMarginUsed: parseFloat(cs.totalMarginUsed),
        totalNotional: parseFloat(cs.totalNtlPos),
        withdrawable: parseFloat((cs as typeof s.crossMarginSummary).withdrawable || "0"),
      } : null;

      return {
        positions,
        account,
        openOrders: (orders as { coin: string; side: string; sz: string; limitPx: string; orderType: string }[]).slice(0, 50),
        triggerOrders: tpSlMap,
        timestamp: Date.now(),
      };
    },
  );

  /**
   * GET /api/market/options/:coin
   * Options chain from Derive — full chain with pricing, Greeks, OI.
   * Supports: BTC, ETH, SOL, HYPE
   */
  app.get<{ Params: { coin: string } }>("/options/:coin", async (req, reply) => {
    const coin = req.params.coin.toUpperCase();
    const supported = getDeriveSupportedCoins();
    if (!supported.includes(coin)) {
      reply.code(400);
      return { error: `Options not available for ${coin}. Supported: ${supported.join(", ")}` };
    }

    const [chain, snapshot] = await Promise.all([
      getDeriveOptionsChain(coin).catch(() => null),
      getDeriveOptionsData(coin).catch(() => null),
    ]);

    return {
      coin,
      chain: chain?.chain || [],
      spotPrice: chain?.spotPrice || 0,
      expiries: chain?.expiries || [],
      summary: snapshot ? {
        maxPain: snapshot.maxPain,
        maxPainExpiry: snapshot.maxPainExpiry,
        maxPainDistance: snapshot.maxPainDistance,
        putCallRatio: snapshot.putCallRatio,
        totalCallOI: snapshot.totalCallOI,
        totalPutOI: snapshot.totalPutOI,
        iv: snapshot.dvol,
        ivRank: snapshot.ivRank,
        skew25d: snapshot.skew25d,
        gex: snapshot.gex,
        gexLevel: snapshot.gexLevel,
        totalVolume24h: snapshot.totalVolume24h,
      } : null,
      source: "derive",
      timestamp: Date.now(),
    };
  });

  /**
   * POST /api/market/client-error
   * Frontend error reports — shows in Railway logs so we can debug remotely.
   */
  app.post("/client-error", async (req) => {
    const body = req.body as { message?: string; stack?: string; component?: string; url?: string; userAgent?: string };
    const msg = String(body.message || "unknown").slice(0, 500);
    const stack = String(body.stack || "").slice(0, 1000);
    const component = String(body.component || "unknown").slice(0, 100);
    const url = String(body.url || "").slice(0, 200);
    console.error(`[CLIENT ERROR] ${component}: ${msg}\n  URL: ${url}\n  Stack: ${stack}`);
    return { ok: true };
  });

  /**
   * GET /api/market/system-health
   * Comprehensive health check — cache states, background jobs, trade stats.
   * Protected: only accessible in dev or with ADMIN_SECRET header.
   */
  app.get("/system-health", async (req, reply) => {
    const IS_PRODUCTION = process.env.NODE_ENV === "production";
    const adminSecret = process.env.ADMIN_SECRET;
    if (IS_PRODUCTION && (!adminSecret || req.headers["x-admin-secret"] !== adminSecret)) {
      reply.code(403);
      return { error: "Forbidden" };
    }
    const tradeStats = getTradeStats();

    // Check cache freshness
    const now = Date.now();
    const cacheChecks = {
      terminalCache: terminalCache
        ? { fresh: now - terminalCache.fetchedAt < TERMINAL_CACHE_TTL, ageMs: now - terminalCache.fetchedAt }
        : { fresh: false, ageMs: -1 },
    };

    // Check if background data is populated
    const smartMoney = getSmartMoneyCached();
    const scores = getTokenScoresCached();
    const signals = getSignalsCached();
    const whaleAlerts = getWhaleAlerts(1);

    const dataHealth = {
      smartMoney: !!smartMoney,
      smartMoneyAge: smartMoney ? Math.round((now - smartMoney.fetchedAt) / 1000) + "s" : "not loaded",
      sharpCount: smartMoney?.flow.length ?? 0,
      tokenScores: scores.size,
      signals: signals?.signals.length ?? 0,
      whaleEvents: whaleAlerts.length > 0,
    };

    let overviewCount = 0;
    try {
      const overviews = await getTokenOverviews();
      overviewCount = overviews.length;
    } catch { /* ignore */ }

    return {
      status: dataHealth.smartMoney && overviewCount > 0 ? "healthy" : "degraded",
      uptime: tradeStats.uptimeHours + "h",
      tokens: overviewCount,
      coinalyzeKey: process.env.COINALYZE_API_KEY ? "set" : "NOT SET",
      redis: isRedisConnected() ? "connected" : "not connected (using in-memory)",
      caches: cacheChecks,
      data: dataHealth,
      trades: {
        total: tradeStats.total,
        successRate: tradeStats.successRate + "%",
        volumeUsd: tradeStats.totalVolumeUsd,
        feesUsd: tradeStats.totalFeesEstimatedUsd,
        last1h: tradeStats.last1h,
      },
      timestamp: now,
    };
  });

  /**
   * GET /api/market/portfolio/:address
   * Full portfolio page data: PNL history, equity curve, volume, fees, trade history, funding, orders.
   */
  app.get<{ Params: { address: string }; Querystring: { window?: string } }>(
    "/portfolio/:address",
    async (req, reply) => {
      const { address } = req.params;
      if (!ethAddress.safeParse(address).success) {
        reply.code(400);
        return { error: "Invalid address format" };
      }
      const window = req.query.window || "allTime";
      const HL = "https://api.hyperliquid.xyz/info";
      const post = (body: Record<string, unknown>) =>
        fetch(HL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

      const [
        stateRes, portfolioRes, feesRes, fillsRes, fundingRes, openOrdersRes, frontendOrdersRes,
      ] = await Promise.all([
        post({ type: "clearinghouseState", user: address }).catch(() => null),
        post({ type: "portfolio", user: address }).catch(() => null),
        post({ type: "userFees", user: address }).catch(() => null),
        post({ type: "userFillsByTime", user: address, startTime: Date.now() - 30 * 86400_000, endTime: Date.now() }).catch(() => null),
        post({ type: "userFunding", user: address, startTime: Date.now() - 30 * 86400_000, endTime: Date.now() }).catch(() => null),
        post({ type: "openOrders", user: address }).catch(() => null),
        post({ type: "frontendOpenOrders", user: address }).catch(() => null),
      ]);

      const [state, portfolio, fees, fills, funding, openOrders, frontendOrders] = await Promise.all([
        stateRes?.ok ? stateRes.json() : null,
        portfolioRes?.ok ? portfolioRes.json() : null,
        feesRes?.ok ? feesRes.json() : null,
        fillsRes?.ok ? fillsRes.json() : null,
        fundingRes?.ok ? fundingRes.json() : null,
        openOrdersRes?.ok ? openOrdersRes.json() : null,
        frontendOrdersRes?.ok ? frontendOrdersRes.json() : null,
      ]);

      // Parse equity curve from portfolio response
      let equityCurve: { time: number; accountValue: number; pnl: number }[] = [];
      let pnlByWindow: Record<string, number> = {};
      let volumeByWindow: Record<string, number> = {};
      if (portfolio && Array.isArray(portfolio)) {
        for (const [win, data] of portfolio as [string, { accountValueHistory?: [number, string][]; pnlHistory?: [number, string][]; vlm?: string }][]) {
          if (data.pnlHistory?.length) {
            const lastPnl = data.pnlHistory[data.pnlHistory.length - 1];
            pnlByWindow[win] = parseFloat(lastPnl[1]);
          }
          if (data.vlm) volumeByWindow[win] = parseFloat(data.vlm);
          if (win === window && data.accountValueHistory) {
            equityCurve = data.accountValueHistory.map(([t, v]: [number, string]) => {
              const pnlEntry = data.pnlHistory?.find(([pt]: [number, string]) => pt === t);
              return { time: t, accountValue: parseFloat(v), pnl: pnlEntry ? parseFloat(pnlEntry[1]) : 0 };
            });
          }
        }
      }

      // Parse crossMarginSummary
      const s = state as { crossMarginSummary?: Record<string, string>; marginSummary?: Record<string, string> } | null;
      const cs = s?.crossMarginSummary || s?.marginSummary;
      const accountValue = cs ? parseFloat(cs.accountValue || "0") : 0;
      const withdrawable = cs ? parseFloat((cs as Record<string, string>).withdrawable || "0") : 0;
      const totalMarginUsed = cs ? parseFloat(cs.totalMarginUsed || "0") : 0;

      // Parse fees
      const feeData = fees as { activeReferralDiscount?: string; dailyUserVlm?: [{ date: string; exchange: string; userCross: string; userAdd: string }]; userCrossRate?: string; userAddRate?: string } | null;

      // Compute 14d volume from fills
      let volume14d = 0;
      if (Array.isArray(fills)) {
        const cutoff14d = Date.now() - 14 * 86400_000;
        for (const f of fills as { time: number; px: string; sz: string }[]) {
          if (f.time >= cutoff14d) {
            volume14d += parseFloat(f.px) * parseFloat(f.sz);
          }
        }
      }

      // Max drawdown from equity curve
      let maxDrawdown = 0;
      let peak = 0;
      for (const pt of equityCurve) {
        if (pt.accountValue > peak) peak = pt.accountValue;
        if (peak > 0) {
          const dd = (peak - pt.accountValue) / peak;
          if (dd > maxDrawdown) maxDrawdown = dd;
        }
      }

      return {
        account: {
          accountValue,
          withdrawable,
          totalMarginUsed,
          perpAccountEquity: accountValue, // HL perp account = cross margin account value
          spotAccountEquity: 0, // Would need spot clearinghouse for real value
        },
        pnl: pnlByWindow,
        volume: { ...volumeByWindow, "14d": volume14d },
        maxDrawdown: maxDrawdown * 100,
        fees: {
          takerRate: feeData?.userCrossRate || "0.035%",
          makerRate: feeData?.userAddRate || "0.01%",
          referralDiscount: feeData?.activeReferralDiscount || "0",
        },
        equityCurve,
        trades: Array.isArray(fills) ? (fills as { time: number; coin: string; side: string; px: string; sz: string; dir: string; hash: string; closedPnl: string; fee: string; crossed: boolean }[])
          .slice(0, 200).map(f => ({
            time: f.time,
            coin: f.coin,
            side: f.side,
            dir: f.dir || f.side,
            price: parseFloat(f.px),
            size: parseFloat(f.sz),
            closedPnl: parseFloat(f.closedPnl || "0"),
            fee: parseFloat(f.fee || "0"),
            hash: f.hash,
          })) : [],
        funding: Array.isArray(funding) ? (funding as { time: number; hash: string; delta: { type: string; coin: string; usdc: string; szi: string; fundingRate: string } }[])
          .filter(f => f.delta?.type === "funding")
          .slice(0, 200).map(f => ({
            time: f.time,
            coin: f.delta.coin,
            payment: parseFloat(f.delta.usdc || "0"),
            size: parseFloat(f.delta.szi || "0"),
            rate: parseFloat(f.delta.fundingRate || "0"),
          })) : [],
        openOrders: Array.isArray(openOrders) ? (openOrders as { coin: string; side: string; sz: string; limitPx: string; orderType: string; oid: number }[]).slice(0, 100) : [],
        triggerOrders: Array.isArray(frontendOrders) ? (frontendOrders as { coin: string; side: string; sz: string; triggerPx: string; orderType: string; oid: number }[])
          .filter((o: { orderType: string }) => o.orderType?.startsWith("Stop") || o.orderType?.startsWith("Take"))
          .slice(0, 100) : [],
        timestamp: Date.now(),
      };
    },
  );
};
