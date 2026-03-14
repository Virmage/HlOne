import type { FastifyPluginAsync } from "fastify";
import { eq, desc, gte, lte, and, sql } from "drizzle-orm";
import {
  traderProfiles,
  traderScores,
  traderSnapshots,
  sourcePositions,
} from "@hl-copy/db";
import {
  getClearinghouseState,
  getPortfolio,
  getUserFills,
} from "../services/hyperliquid.js";

export const traderRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /api/traders
   * Leaderboard — returns ranked traders with filters
   */
  app.get<{
    Querystring: {
      minAccountSize?: string;
      minRoi?: string;
      minPnl?: string;
      minTrades?: string;
      maxLeverage?: string;
      sortBy?: string;
      order?: "asc" | "desc";
      limit?: string;
      offset?: string;
    };
  }>("/", async (req, reply) => {
    const {
      minAccountSize,
      minRoi,
      minPnl,
      minTrades,
      maxLeverage,
      sortBy = "compositeScore",
      order = "desc",
      limit = "50",
      offset = "0",
    } = req.query;

    const conditions = [];

    if (minAccountSize) {
      conditions.push(gte(traderProfiles.accountSize, minAccountSize));
    }
    if (minRoi) {
      conditions.push(gte(traderProfiles.roiPercent, parseFloat(minRoi)));
    }
    if (minPnl) {
      conditions.push(gte(traderProfiles.totalPnl, minPnl));
    }
    if (minTrades) {
      conditions.push(gte(traderProfiles.tradeCount, parseInt(minTrades)));
    }
    if (maxLeverage) {
      conditions.push(lte(traderProfiles.maxLeverage, parseFloat(maxLeverage)));
    }

    const whereClause =
      conditions.length > 0 ? and(...conditions) : undefined;

    const traders = await app.db
      .select({
        id: traderProfiles.id,
        address: traderProfiles.address,
        accountSize: traderProfiles.accountSize,
        totalPnl: traderProfiles.totalPnl,
        roiPercent: traderProfiles.roiPercent,
        winRate: traderProfiles.winRate,
        tradeCount: traderProfiles.tradeCount,
        maxLeverage: traderProfiles.maxLeverage,
        lastActiveAt: traderProfiles.lastActiveAt,
        compositeScore: traderScores.compositeScore,
        rank: traderScores.rank,
      })
      .from(traderProfiles)
      .leftJoin(
        traderScores,
        eq(traderProfiles.id, traderScores.traderProfileId)
      )
      .where(whereClause)
      .orderBy(
        order === "desc"
          ? desc(traderScores.compositeScore)
          : traderScores.compositeScore
      )
      .limit(parseInt(limit))
      .offset(parseInt(offset));

    return { traders, total: traders.length };
  });

  /**
   * GET /api/traders/:address
   * Trader detail — full stats + positions
   */
  app.get<{ Params: { address: string } }>("/:address", async (req, reply) => {
    const { address } = req.params;

    // Get from DB first
    const [profile] = await app.db
      .select()
      .from(traderProfiles)
      .where(eq(traderProfiles.address, address.toLowerCase()))
      .limit(1);

    // Fetch live data from Hyperliquid
    const [clearinghouse, portfolio, fills] = await Promise.all([
      getClearinghouseState(address).catch(() => null),
      getPortfolio(address).catch(() => null),
      getUserFills(address).catch(() => []),
    ]);

    // Get positions from DB
    const positions = profile
      ? await app.db
          .select()
          .from(sourcePositions)
          .where(eq(sourcePositions.traderProfileId, profile.id))
      : [];

    // Get equity curve data (snapshots)
    const snapshots = profile
      ? await app.db
          .select()
          .from(traderSnapshots)
          .where(eq(traderSnapshots.traderProfileId, profile.id))
          .orderBy(traderSnapshots.snapshotAt)
      : [];

    return {
      profile: profile || null,
      live: {
        clearinghouse,
        portfolio,
        recentFills: Array.isArray(fills) ? fills.slice(0, 50) : [],
      },
      positions,
      equityCurve: snapshots.map((s) => ({
        time: s.snapshotAt,
        value: s.accountValue,
        pnl: s.totalPnl,
        drawdown: s.drawdownPercent,
      })),
    };
  });

  /**
   * GET /api/traders/:address/positions
   * Current positions for a trader (live from HL)
   */
  app.get<{ Params: { address: string } }>(
    "/:address/positions",
    async (req) => {
      const state = await getClearinghouseState(req.params.address);
      if (!state?.assetPositions) return { positions: [] };

      return {
        positions: state.assetPositions
          .filter(
            (p: { position: { szi: string } }) =>
              parseFloat(p.position.szi) !== 0
          )
          .map((p: { position: Record<string, unknown> }) => p.position),
      };
    }
  );

  /**
   * GET /api/traders/:address/fills
   * Recent fills for a trader
   */
  app.get<{
    Params: { address: string };
    Querystring: { limit?: string };
  }>("/:address/fills", async (req) => {
    const fills = await getUserFills(
      req.params.address,
      parseInt(req.query.limit || "100")
    );
    return { fills: Array.isArray(fills) ? fills : [] };
  });
};
