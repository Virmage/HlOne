/**
 * Market intelligence API routes — powers the CPYCAT terminal.
 */

import type { FastifyPluginAsync } from "fastify";
import { getTokenOverviews, analyzeBook, getCachedAssetCtxs } from "../services/market-data.js";
import { getSmartMoneyCached } from "../services/smart-money.js";
import { getWhaleAlerts, getHotTokens, getWhaleAlertsForCoin, getHistoricalWhaleEvents } from "../services/whale-tracker.js";
import { getTokenScoresCached } from "../services/scoring.js";
import { getTraderDisplayName } from "../services/name-generator.js";
import { discoverActiveTraders, getCandleSnapshot, getFundingHistory, getL2Book, getRecentTrades, getClearinghouseState, getOpenOrders } from "../services/hyperliquid.js";
import { getOptionsData, getAllOptionsData, type OptionsSnapshot } from "../services/options-data.js";
import { getSignals, getSignalsCached } from "../services/signals.js";
import { getOICandlesForInterval } from "../services/oi-tracker.js";
import { getNewsFeedCached, getCoinNews, type NewsPost } from "../services/crypto-panic.js";
import { getAllSocialMetricsCached, getSocialMetricsCached, type SocialMetrics } from "../services/lunar-crush.js";
import { getLargeTradesCached } from "../services/trade-tape.js";
import { getMacroDataCached } from "../services/macro-data.js";
import { getTopTraderFills } from "../services/top-trader-fills.js";
import { getLiquidationHeatmap } from "../services/liquidation-heatmap.js";
import { getCorrelationMatrixCached } from "../services/correlation-matrix.js";
import { getOrderFlow } from "../services/order-flow.js";
import { getPositionConcentration } from "../services/position-concentration.js";
import { logTrade, getTradeLog, getTradeStats } from "../services/trade-log.js";

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

// ─── Terminal response cache ────────────────────────────────────────────────
// Cache the full /terminal response for 10s so N concurrent users = 1 computation.
let terminalCache: { data: unknown; fetchedAt: number } | null = null;
let terminalInFlight: Promise<unknown> | null = null;
const TERMINAL_CACHE_TTL = 10_000; // 10 seconds

// ─── Sub-query caches (avoid redundant fetches per terminal request) ────────
let fundingCache: { data: { topPositive: unknown[]; topNegative: unknown[] }; fetchedAt: number } | null = null;
const FUNDING_CACHE_TTL = 30_000; // 30 seconds

let tradersCache: { data: unknown[]; fetchedAt: number } | null = null;
const TRADERS_CACHE_TTL = 60_000; // 60 seconds

export const marketRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /api/market/terminal
   * Returns everything the main dashboard needs in one call.
   */
  app.get("/terminal", async (req) => {
    // Serve cached terminal response if fresh (10s TTL).
    // This means 100 concurrent users = 1 computation, not 100.
    if (terminalCache && Date.now() - terminalCache.fetchedAt < TERMINAL_CACHE_TTL) {
      return terminalCache.data;
    }
    // Deduplicate: if already computing, wait for that result
    if (terminalInFlight) return terminalInFlight;

    terminalInFlight = (async () => {
    // Use cached smart money + scores (instant). Background jobs populate these.
    // Only getTokenOverviews() makes a live API call (fast — just allMids + assetCtxs).
    const overviews = await getTokenOverviews();
    const smartMoney = getSmartMoneyCached();
    const scores = getTokenScoresCached();

    const whaleAlerts = getWhaleAlerts(30);
    const hotTokens = getHotTokens(10);

    // All tokens with scores (perps + spot + HIP-3 tradfi)
    const tokenData = overviews.map(t => ({
      ...t,
      score: scores.get(t.coin) || null,
    }));

    // Sharp flow — top tokens by smart money interest, min 5 rows
    const rawFlow = smartMoney?.flow.slice(0, 20).map(f => ({
      ...f,
      score: scores.get(f.coin)?.score ?? null,
      signal: scores.get(f.coin)?.signal ?? "neutral",
      price: overviews.find(o => o.coin === f.coin)?.price ?? 0,
      change24h: overviews.find(o => o.coin === f.coin)?.change24h ?? 0,
      volume24h: overviews.find(o => o.coin === f.coin)?.volume24h ?? 0,
      fundingRate: overviews.find(o => o.coin === f.coin)?.fundingRate ?? 0,
    })) || [];

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
    const divergences = smartMoney?.divergences.slice(0, 10).map(d => ({
      ...d,
      score: scores.get(d.coin)?.score ?? null,
      price: overviews.find(o => o.coin === d.coin)?.price ?? 0,
      change24h: overviews.find(o => o.coin === d.coin)?.change24h ?? 0,
    })) || [];

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
        topTraders = allTraders
          .sort((a, b) => b.roi30d - a.roi30d)
          .slice(0, 20)
          .map(t => ({
            address: t.address,
            displayName: getTraderDisplayName(t.address, t.displayName),
            accountValue: t.accountValue,
            roi30d: t.roi30d,
            roiAllTime: t.roiAllTime,
            totalPnl: t.totalPnl,
            isSharp: smartMoney?.sharpAddresses.has(t.address.toLowerCase()) ?? false,
          }));
        tradersCache = { data: topTraders, fetchedAt: now };
      }
    } catch { /* ignore */ }

    // Options data for BTC/ETH (from Deribit)
    let optionsData: Record<string, OptionsSnapshot> = {};
    try {
      const opts = await getAllOptionsData();
      for (const [k, v] of opts) optionsData[k] = v;
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
      news: newsFeed?.posts.slice(0, 20) || [],
      social: socialMetrics.slice(0, 30),
      funding,
      largeTrades,
      macro,
      liquidationHeatmap,
      correlationMatrix,
      orderFlow,
      positionConcentration,
      timestamp: Date.now(),
    };
    terminalCache = { data: result, fetchedAt: Date.now() };
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
      const coin = decodeURIComponent(req.params.coin);
      const interval = (req.query.interval as string) || "1h";
      const now = Date.now();

      // Fetch everything in parallel
      // Use cached smart money data (instant) — never block on position scan
      const sharpPositions = (getSmartMoneyCached()?.sharpPositions.get(coin)) || [];
      const score = getTokenScoresCached().get(coin) || null;

      // Adjust lookback based on interval
      const lookbackMs: Record<string, number> = {
        "5m": 2 * 24 * 3600_000,   // 2 days
        "15m": 5 * 24 * 3600_000,  // 5 days
        "1h": 14 * 24 * 3600_000,  // 14 days
        "4h": 30 * 24 * 3600_000,  // 30 days
        "1d": 180 * 24 * 3600_000, // 6 months
        "1w": 3 * 365 * 24 * 3600_000, // 3 years
        "1M": 5 * 365 * 24 * 3600_000, // 5 years
      };
      const candleSince = now - (lookbackMs[interval] || 7 * 24 * 3600_000);

      // Critical path: candles first (needed for chart render).
      // Non-critical data loaded in parallel but doesn't block candles.
      const [
        candles,
        bookAnalysis,
        funding,
        whaleAlerts,
        options,
        overviews,
      ] = await Promise.all([
        getCandleSnapshot(coin, interval, candleSince, now).catch(() => []),
        analyzeBook(coin).catch(() => null),
        getFundingHistory(coin, now - 3 * 24 * 60 * 60 * 1000).catch(() => []),
        getHistoricalWhaleEvents(coin, interval, candleSince),
        getOptionsData(coin).catch(() => null),
        // Use cached overviews only (don't trigger fresh HIP-3 fetch)
        getTokenOverviews().catch(() => []),
      ]);

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
      const oiCandles = getOICandlesForInterval(coin, interval);

      // Top trader fills for chart markers
      const topTraderFillsRaw = getTopTraderFills(coin, candleSince);
      // Aggregate fills by trader+candle to avoid clutter — keep top fills per candle period
      const topTraderFillsData = topTraderFillsRaw.map(f => ({
        time: f.time,
        side: f.side,
        price: f.price,
        sizeUsd: f.sizeUsd,
        trader: f.trader,
      }));

      // Coin-specific news + social
      const coinNews = await getCoinNews(coin).catch(() => [] as NewsPost[]);
      const coinSocial = getSocialMetricsCached(coin);

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
        timestamp: Date.now(),
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
      const limit = parseInt(req.query.limit || "50");
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
   * All CPYCAT scores.
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
      const limit = parseInt(req.query.limit || "50");
      return {
        trades: getLargeTradesCached().slice(0, Math.min(limit, 200)),
        timestamp: Date.now(),
      };
    },
  );

  /**
   * POST /api/market/trade-log
   * Log a trade executed from the frontend (for auditing + fee tracking).
   * Called by the trading panel after every order attempt.
   */
  app.post<{
    Body: {
      userAddress: string;
      asset: string;
      side: "buy" | "sell";
      orderType: "market" | "limit";
      size: number;
      price: number;
      success: boolean;
      orderId?: string;
      filledSize?: string;
      avgPrice?: string;
      error?: string;
      latencyMs: number;
    };
  }>("/trade-log", async (req) => {
    const b = req.body;
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
    async (req) => {
      const { address } = req.params;
      const [state, orders] = await Promise.all([
        getClearinghouseState(address).catch(() => null),
        getOpenOrders(address).catch(() => []),
      ]);

      if (!state) {
        return { positions: [], account: null, openOrders: [], timestamp: Date.now() };
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
          return {
            coin: p.coin,
            side: size > 0 ? "long" as const : "short" as const,
            size: Math.abs(size),
            entryPx: parseFloat(p.entryPx),
            positionValue: parseFloat(p.positionValue),
            unrealizedPnl: parseFloat(p.unrealizedPnl),
            leverage: p.leverage?.value ?? 0,
            liquidationPx: p.liquidationPx ? parseFloat(p.liquidationPx) : null,
            marginUsed: parseFloat(p.marginUsed),
            returnOnEquity: parseFloat(p.returnOnEquity || "0"),
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
        timestamp: Date.now(),
      };
    },
  );

  /**
   * GET /api/market/system-health
   * Comprehensive health check — cache states, background jobs, trade stats.
   */
  app.get("/system-health", async () => {
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
};
