/**
 * Market intelligence API routes — powers the CPYCAT terminal.
 */

import type { FastifyPluginAsync } from "fastify";
import { getTokenOverviews, analyzeBook, getCachedAssetCtxs } from "../services/market-data.js";
import { getSmartMoneyCached } from "../services/smart-money.js";
import { getWhaleAlerts, getHotTokens, getWhaleAlertsForCoin, getHistoricalWhaleEvents } from "../services/whale-tracker.js";
import { getTokenScoresCached } from "../services/scoring.js";
import { getTraderDisplayName } from "../services/name-generator.js";
import { discoverActiveTraders, getCandleSnapshot, getFundingHistory, getL2Book, getRecentTrades } from "../services/hyperliquid.js";
import { getOptionsData, getAllOptionsData, type OptionsSnapshot } from "../services/options-data.js";
import { getSignals, getSignalsCached } from "../services/signals.js";
import { getOICandlesForInterval } from "../services/oi-tracker.js";
import { getNewsFeedCached, getCoinNews, type NewsPost } from "../services/crypto-panic.js";
import { getAllSocialMetricsCached, getSocialMetricsCached, type SocialMetrics } from "../services/lunar-crush.js";
import { getLargeTradesCached } from "../services/trade-tape.js";
import { getMacroDataCached } from "../services/macro-data.js";
import { getTopTraderFills } from "../services/top-trader-fills.js";

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

export const marketRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /api/market/terminal
   * Returns everything the main dashboard needs in one call.
   */
  app.get("/terminal", async (req) => {
    // Use cached smart money + scores (instant). Background jobs populate these.
    // Only getTokenOverviews() makes a live API call (fast — just allMids + assetCtxs).
    const overviews = await getTokenOverviews();
    const smartMoney = getSmartMoneyCached();
    const scores = getTokenScoresCached();

    const whaleAlerts = getWhaleAlerts(30);
    const hotTokens = getHotTokens(10);

    // Top 30 tokens with scores
    const tokenData = overviews.slice(0, 30).map(t => ({
      ...t,
      score: scores.get(t.coin) || null,
    }));

    // Sharp flow — top tokens by smart money interest
    const sharpFlow = smartMoney?.flow.slice(0, 20).map(f => ({
      ...f,
      score: scores.get(f.coin)?.score ?? null,
      signal: scores.get(f.coin)?.signal ?? "neutral",
      price: overviews.find(o => o.coin === f.coin)?.price ?? 0,
      change24h: overviews.find(o => o.coin === f.coin)?.change24h ?? 0,
      volume24h: overviews.find(o => o.coin === f.coin)?.volume24h ?? 0,
      fundingRate: overviews.find(o => o.coin === f.coin)?.fundingRate ?? 0,
    })) || [];

    // Divergences
    const divergences = smartMoney?.divergences.slice(0, 10).map(d => ({
      ...d,
      score: scores.get(d.coin)?.score ?? null,
      price: overviews.find(o => o.coin === d.coin)?.price ?? 0,
      change24h: overviews.find(o => o.coin === d.coin)?.change24h ?? 0,
    })) || [];

    // Top traders (mini leaderboard)
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

    // Funding leaderboard
    const funding = await buildFundingLeaderboard().catch(() => ({ topPositive: [], topNegative: [] }));

    // Large trades (cached, never blocks)
    const largeTrades = getLargeTradesCached().slice(0, 10);

    // Macro data (cached, never blocks)
    const macro = getMacroDataCached();

    return {
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
      timestamp: Date.now(),
    };
  });

  /**
   * GET /api/market/token/:coin
   * Token deep dive — everything about a specific token.
   */
  app.get<{ Params: { coin: string }; Querystring: { interval?: string } }>(
    "/token/:coin",
    async (req) => {
      const { coin } = req.params;
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

      const [
        bookAnalysis,
        overviews,
        candles,
        funding,
        whaleAlerts,
        options,
      ] = await Promise.all([
        analyzeBook(coin).catch(() => null),
        getTokenOverviews().catch(() => []),
        getCandleSnapshot(coin, interval, candleSince, now).catch(() => []),
        getFundingHistory(coin, now - 3 * 24 * 60 * 60 * 1000).catch(() => []),
        getHistoricalWhaleEvents(coin, interval, candleSince),
        getOptionsData(coin).catch(() => null),
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
};
