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
import { verifyReadSignature, verifyWalletSignature, hashRequestBody } from "../lib/auth.js";
import { sharpFlowSnapshots } from "@hl-copy/db";
import { and, gte, lte as le, eq as eqDrizzle } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ethAddress, positiveNumber, nonNegativeNumber, coinName } from "../lib/validation.js";

// Cap size * price at $10M per log — no human trades 10M on a single order
// through HLOne, so anything larger is rejected. trade-log is a telemetry
// endpoint, NOT a source of truth — fee accounting should come from HL
// onchain fills. We keep it unauthenticated so trading UX has zero extra
// friction, but guard against abuse with rate limits + size caps + dedupe.
const MAX_NOTIONAL_USD = 10_000_000;

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

// In-memory dedupe for trade-log entries (orderId based). Prevents simple
// replay-spam from inflating /trade-stats. 10-min TTL.
const recentTradeLogIds = new Map<string, number>();
function wasTradeLogged(orderId: string): boolean {
  const now = Date.now();
  // Opportunistic eviction
  if (recentTradeLogIds.size > 5000) {
    for (const [k, v] of recentTradeLogIds) {
      if (now - v > 10 * 60 * 1000) recentTradeLogIds.delete(k);
      if (recentTradeLogIds.size < 2500) break;
    }
  }
  if (recentTradeLogIds.has(orderId)) return true;
  recentTradeLogIds.set(orderId, now);
  return false;
}

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
    // 500 recent fills — previously sliced to 10, which meant the tape
    // only ever showed ~6 minutes before scrolling off. 500 covers roughly
    // a full session of activity without bloating the /terminal payload.
    const largeTrades = getLargeTradesCached().slice(0, 500);

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
      const limit = Math.min(Math.max(1, parseInt(req.query.limit || "200") || 200), 2000);
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
  app.post("/trade-log", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = TradeLogSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid input", details: parsed.error.flatten().fieldErrors };
    }

    const b = parsed.data;

    const notionalUsd = b.size * b.price;
    if (notionalUsd > MAX_NOTIONAL_USD) {
      reply.code(400);
      return { error: "Notional exceeds per-log cap" };
    }

    // Dedupe by orderId — ignores repeat POSTs of the same trade.
    if (b.orderId && wasTradeLogged(`${b.userAddress.toLowerCase()}:${b.orderId}`)) {
      return { ok: true, deduped: true };
    }

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
   * GET /api/market/sharp-flow/backtest
   *
   * Backtest the edge of sharp-flow signals. For every past snapshot where
   * sharps were directionally confident (strength ≥ threshold), we look up
   * the price N hours later (from a later snapshot of the same coin) and
   * record whether the sharp direction was right.
   *
   * Query params:
   *   horizon     - hours forward to measure return (default 24, options: 1, 4, 24, 72)
   *   minStrength - minimum sharp strength to include (default 60)
   *   divergenceOnly - if "1", only include rows where sharps disagreed with squares
   *   since       - unix ms cutoff (default: oldest row)
   *   coin        - optional filter to a single asset
   *
   * Returns:
   *   { horizonHours, trades, wins, winRate, avgReturnPct, medianReturnPct,
   *     perCoin: { [coin]: { trades, wins, winRate, avgReturn } } }
   */
  /**
   * GET /api/market/sharp-flow/status
   * Quick diagnostic — confirms snapshot logging is actually running.
   * Returns total snapshot count, first/last snapshot timestamps, and a
   * per-coin count for the last 24h. Public because it's aggregate-only.
   */
  app.get("/sharp-flow/status", async (_req, reply) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (app as any).db;
    if (!db) {
      reply.code(503);
      return { error: "DATABASE_URL not configured" };
    }
    try {
      const all = await db.select({
        snapshotAt: sharpFlowSnapshots.snapshotAt,
        coin: sharpFlowSnapshots.coin,
      }).from(sharpFlowSnapshots);
      if (all.length === 0) {
        return {
          total: 0,
          note: "Table exists but is empty — next 5-min smart-money refresh will write the first rows.",
        };
      }
      const times = (all as { snapshotAt: Date }[]).map(r => r.snapshotAt.getTime());
      const first = new Date(Math.min(...times));
      const last = new Date(Math.max(...times));
      const hoursCovered = (Math.max(...times) - Math.min(...times)) / 3600_000;
      const perCoin: Record<string, number> = {};
      const oneDayAgo = Date.now() - 86400_000;
      for (const r of all as { coin: string; snapshotAt: Date }[]) {
        if (r.snapshotAt.getTime() < oneDayAgo) continue;
        perCoin[r.coin] = (perCoin[r.coin] || 0) + 1;
      }
      return {
        total: all.length,
        firstSnapshot: first.toISOString(),
        lastSnapshot: last.toISOString(),
        hoursCovered: +hoursCovered.toFixed(2),
        coinsSeenLast24h: Object.keys(perCoin).length,
        topCoinsLast24h: Object.entries(perCoin).sort((a, b) => b[1] - a[1]).slice(0, 10),
      };
    } catch (err) {
      reply.code(500);
      return { error: "status query failed", detail: (err as Error).message };
    }
  });

  app.get<{
    Querystring: { horizon?: string; minStrength?: string; divergenceOnly?: string; since?: string; coin?: string };
  }>("/sharp-flow/backtest", async (req, reply) => {
    const horizon = Math.max(1, Math.min(168, parseInt(req.query.horizon || "24", 10) || 24));
    const minStrength = Math.max(0, Math.min(100, parseInt(req.query.minStrength || "60", 10) || 60));
    const divergenceOnly = req.query.divergenceOnly === "1";
    const coinFilter = req.query.coin;
    const sinceMs = req.query.since ? parseInt(req.query.since, 10) : Date.now() - 90 * 86400_000;
    const since = new Date(sinceMs);
    // Don't include snapshots so recent we haven't yet had time to measure
    // the horizon return.
    const maxSnapshotAt = new Date(Date.now() - horizon * 3600_000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (app as any).db;
    if (!db) {
      reply.code(503);
      return { error: "Backtest unavailable — DATABASE_URL not configured" };
    }

    try {
      const whereClauses = [
        gte(sharpFlowSnapshots.snapshotAt, since),
        le(sharpFlowSnapshots.snapshotAt, maxSnapshotAt),
        gte(sharpFlowSnapshots.sharpStrength, minStrength),
      ];
      if (coinFilter) whereClauses.push(eqDrizzle(sharpFlowSnapshots.coin, coinFilter));
      if (divergenceOnly) whereClauses.push(eqDrizzle(sharpFlowSnapshots.divergence, true));

      const rows: Array<{
        coin: string; sharpDirection: string; sharpStrength: number;
        price: string; divergence: boolean; divergenceScore: number; snapshotAt: Date;
      }> = await db.select({
        coin: sharpFlowSnapshots.coin,
        sharpDirection: sharpFlowSnapshots.sharpDirection,
        sharpStrength: sharpFlowSnapshots.sharpStrength,
        price: sharpFlowSnapshots.price,
        divergence: sharpFlowSnapshots.divergence,
        divergenceScore: sharpFlowSnapshots.divergenceScore,
        snapshotAt: sharpFlowSnapshots.snapshotAt,
      }).from(sharpFlowSnapshots).where(and(...whereClauses));

    if (rows.length === 0) {
      return {
        horizonHours: horizon,
        minStrength,
        divergenceOnly,
        trades: 0,
        wins: 0,
        winRate: null,
        avgReturnPct: null,
        medianReturnPct: null,
        perCoin: {},
        note: "No snapshots yet — signals start logging after the next 5-min smart-money refresh.",
      };
    }

    // Index all rows by coin for fast horizon lookup.
    const byCoin = new Map<string, typeof rows>();
    for (const r of rows) {
      const arr = byCoin.get(r.coin) || [];
      arr.push(r);
      byCoin.set(r.coin, arr);
    }
    for (const arr of byCoin.values()) arr.sort((a, b) => a.snapshotAt.getTime() - b.snapshotAt.getTime());

    // Skip neutral signals (can't win or lose — direction is flat).
    const directional = rows.filter(r => r.sharpDirection !== "neutral");
    const trades: Array<{ coin: string; dir: string; returnPct: number; win: boolean }> = [];

    for (const r of directional) {
      const target = r.snapshotAt.getTime() + horizon * 3600_000;
      const seriesForCoin = byCoin.get(r.coin) || [];
      // Find the first snapshot at-or-after target (binary search would be
      // nicer; linear is fine for the scale we deal with).
      const future = seriesForCoin.find(s => s.snapshotAt.getTime() >= target);
      if (!future) continue;
      const entry = parseFloat(r.price);
      const exit = parseFloat(future.price);
      if (!(entry > 0) || !(exit > 0)) continue;

      // If sharps were long, positive price move = win. If short, negative = win.
      const rawReturn = (exit - entry) / entry;
      const dirMult = r.sharpDirection === "long" ? 1 : -1;
      const returnPct = rawReturn * dirMult * 100;
      trades.push({ coin: r.coin, dir: r.sharpDirection, returnPct, win: returnPct > 0 });
    }

    if (trades.length === 0) {
      return {
        horizonHours: horizon,
        minStrength,
        divergenceOnly,
        trades: 0,
        wins: 0,
        winRate: null,
        avgReturnPct: null,
        medianReturnPct: null,
        perCoin: {},
        note: "Snapshots exist but none have enough future data to measure return yet.",
      };
    }

    const wins = trades.filter(t => t.win).length;
    const avg = trades.reduce((s, t) => s + t.returnPct, 0) / trades.length;
    const sortedReturns = [...trades].map(t => t.returnPct).sort((a, b) => a - b);
    const median = sortedReturns[Math.floor(sortedReturns.length / 2)];

    const perCoin: Record<string, { trades: number; wins: number; winRate: number; avgReturn: number }> = {};
    for (const t of trades) {
      if (!perCoin[t.coin]) perCoin[t.coin] = { trades: 0, wins: 0, winRate: 0, avgReturn: 0 };
      perCoin[t.coin].trades++;
      if (t.win) perCoin[t.coin].wins++;
      perCoin[t.coin].avgReturn += t.returnPct;
    }
    for (const c of Object.keys(perCoin)) {
      perCoin[c].avgReturn = perCoin[c].avgReturn / perCoin[c].trades;
      perCoin[c].winRate = perCoin[c].wins / perCoin[c].trades;
    }

      return {
        horizonHours: horizon,
        minStrength,
        divergenceOnly,
        coinFilter: coinFilter ?? null,
        trades: trades.length,
        wins,
        winRate: wins / trades.length,
        avgReturnPct: avg,
        medianReturnPct: median,
        perCoin,
      };
    } catch (err) {
      console.error("[sharp-flow/backtest] query failed:", err);
      reply.code(500);
      return { error: "backtest query failed", detail: (err as Error).message };
    }
  });

  /**
   * POST /api/market/sharp-flow/init
   *
   * One-shot recovery for when the automatic drizzle migration didn't apply
   * the sharp_flow_snapshots table (happens occasionally on Railway if the
   * migration race with startup). Runs CREATE TABLE IF NOT EXISTS.
   *
   * Protected by ADMIN_SECRET header — hit from the browser with
   * `x-admin-secret: <secret>` to re-create the table on demand.
   */
  app.post("/sharp-flow/init", async (req, reply) => {
    const adminSecret = process.env.ADMIN_SECRET;
    const provided = req.headers["x-admin-secret"];
    if (!adminSecret || adminSecret.length < 16) {
      reply.code(403);
      return { error: "ADMIN_SECRET not configured" };
    }
    if (typeof provided !== "string" || provided !== adminSecret) {
      reply.code(403);
      return { error: "Forbidden" };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (app as any).db;
    if (!db) {
      reply.code(503);
      return { error: "DB not configured" };
    }
    try {
      // Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
      // This duplicates the drizzle migration 0003 so we can run it directly.
      const { sql } = await import("drizzle-orm");
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "sharp_flow_snapshots" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
          "coin" text NOT NULL,
          "sharp_long_count" integer DEFAULT 0 NOT NULL,
          "sharp_short_count" integer DEFAULT 0 NOT NULL,
          "sharp_net_size" numeric(20, 2),
          "sharp_direction" text NOT NULL,
          "sharp_strength" integer NOT NULL,
          "square_long_count" integer DEFAULT 0 NOT NULL,
          "square_short_count" integer DEFAULT 0 NOT NULL,
          "square_net_size" numeric(20, 2),
          "square_direction" text NOT NULL,
          "square_strength" integer NOT NULL,
          "consensus" text NOT NULL,
          "divergence" boolean DEFAULT false NOT NULL,
          "divergence_score" integer DEFAULT 0 NOT NULL,
          "hlone_score" integer,
          "signal" text,
          "price" numeric(20, 8) NOT NULL,
          "change_24h" real,
          "volume_24h" numeric(20, 2),
          "funding_rate" real,
          "snapshot_at" timestamp DEFAULT now() NOT NULL
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_sharp_flow_snapshots_coin_time" ON "sharp_flow_snapshots" ("coin", "snapshot_at")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_sharp_flow_snapshots_time" ON "sharp_flow_snapshots" ("snapshot_at")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_sharp_flow_snapshots_divergence" ON "sharp_flow_snapshots" ("divergence", "snapshot_at")`);
      return { ok: true, message: "sharp_flow_snapshots table ready. Next 5-min smart-money refresh will start writing." };
    } catch (err) {
      reply.code(500);
      return { error: "init failed", detail: (err as Error).message };
    }
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
   *
   * Rate-limited per-IP (5/min) so a buggy page can't DDoS our log ingestion.
   * Input is aggressively sanitized:
   *   - Control chars / ANSI escapes stripped (prevents log-injection / terminal escapes)
   *   - Hex blobs ≥64 chars redacted (prevents accidental key / signature leaks)
   *   - URL query strings stripped (prevents session tokens leaking via logs)
   */
  const HEX_BLOB_RE = /0x[0-9a-fA-F]{64,}/g;
  const CTRL_RE = /[\x00-\x1f\x7f-\x9f]/g;
  function redactSensitive(input: string): string {
    return input.replace(HEX_BLOB_RE, "[redacted-hex]").replace(CTRL_RE, " ").trim();
  }
  function stripQuery(input: string): string {
    try {
      const u = new URL(input);
      u.search = "";
      u.hash = "";
      return u.toString();
    } catch {
      return input.split("?")[0];
    }
  }
  app.post("/client-error", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req) => {
    const body = req.body as { message?: string; stack?: string; component?: string; url?: string; userAgent?: string };
    const msg = redactSensitive(String(body.message || "unknown")).slice(0, 300);
    const stack = redactSensitive(String(body.stack || "")).slice(0, 500);
    const component = String(body.component || "unknown").replace(/[^\w-]/g, "").slice(0, 60);
    const url = stripQuery(String(body.url || "")).slice(0, 200);
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
    const provided = req.headers["x-admin-secret"] as string | undefined;
    // Use constant-time comparison to prevent timing attacks
    const secretMatch = adminSecret && provided
      && adminSecret.length === provided.length
      && timingSafeEqual(Buffer.from(adminSecret), Buffer.from(provided));
    if (IS_PRODUCTION && (!adminSecret || !secretMatch)) {
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

  // ─── Derive API proxy ─────────────────────────────────────────────────────
  // Proxies requests to Derive's private API to avoid CORS issues.
  //
  // Security model:
  //   - Only a narrow whitelist of endpoints is allowed.
  //   - Account-lifecycle + balance-moving endpoints (create_subaccount,
  //     deposit) are NOT proxied — those should be called directly from the
  //     user's browser so the session-key signature chain is validated by
  //     Derive against the true origin wallet, not via our IP.
  //   - Caller must include an HLOne wallet signature (`x-hlone-*` headers)
  //     proving ownership of the wallet whose Derive account is being
  //     accessed. This stops anonymous credential-forwarding where an
  //     attacker supplies their own Derive authSignature with someone
  //     else's wallet address.
  //   - Per-IP rate limit via @fastify/rate-limit.

  const DERIVE_ALLOWED_ENDPOINTS = new Set([
    "/private/get_subaccounts",
    "/private/get_subaccount",
    "/private/get_collaterals",
    "/private/order",
    "/private/cancel",
  ]);

  app.post<{
    Body: {
      endpoint: string;
      body: Record<string, unknown>;
      wallet?: string;
      authTimestamp?: string;
      authSignature?: string;
    };
  }>(
    "/derive-proxy",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { endpoint, body, wallet, authTimestamp, authSignature } = request.body || {};
      if (!endpoint || !DERIVE_ALLOWED_ENDPOINTS.has(endpoint)) {
        return reply.status(400).send({ error: "Invalid endpoint" });
      }
      if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
        return reply.status(400).send({ error: "wallet required" });
      }

      // Require HLOne wallet signature — the caller must prove they own the
      // wallet whose Derive account is being accessed.
      try {
        await verifyReadSignature(
          request.headers as Record<string, string | string[] | undefined>,
          wallet,
          "derive-proxy",
        );
      } catch (err) {
        return reply.status(401).send({ error: (err as Error).message });
      }

      // Derive requires lowercase wallet address
      const walletLower = wallet.toLowerCase();

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      headers["X-LyraWallet"] = walletLower;
      // Derive private endpoints require timestamp + signature auth headers
      if (authTimestamp) {
        headers["X-LyraTimestamp"] = authTimestamp;
      }
      if (authSignature) {
        headers["X-LyraSignature"] = authSignature;
      }

      const DERIVE_URL = "https://api.lyra.finance";
      try {
        const res = await fetch(`${DERIVE_URL}${endpoint}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        // Handle non-JSON responses (e.g. 401 HTML from nginx)
        const contentType = res.headers.get("content-type") || "";
        if (!contentType.includes("json")) {
          const text = await res.text();
          console.error(`[derive-proxy] ${endpoint} returned non-JSON (${res.status}):`, text.slice(0, 200));
          if (res.status === 401) {
            console.error(`[derive-proxy] 401 — headers sent: wallet=${!!walletLower} timestamp=${!!authTimestamp} signature=${!!authSignature}`);
          }
          return reply.status(res.status).send({
            error: `Derive API returned ${res.status}`,
            needsAuth: res.status === 401,
          });
        }
        const data = await res.json();
        return reply.status(res.status).send(data);
      } catch (err) {
        console.error(`[derive-proxy] ${endpoint} failed:`, (err as Error).message);
        return reply.status(502).send({ error: "Derive API unreachable" });
      }
    },
  );
};
