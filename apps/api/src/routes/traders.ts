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
  discoverActiveTraders,
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

    let traders: {
      id: string;
      address: string;
      accountSize: string | null;
      totalPnl: string | null;
      roiPercent: number | null;
      winRate: number | null;
      tradeCount: number | null;
      maxLeverage: number | null;
      lastActiveAt: Date | null;
      compositeScore: number | null;
      rank: number | null;
    }[] = [];
    try {
      traders = await app.db
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
    } catch {
      // DB may not be available — fall through to live discovery
      traders = [];
    }

    // Fallback: if DB has no traders, discover them live from Hyperliquid
    if (traders.length === 0 && parseInt(offset) === 0) {
      try {
        const discovered = await discoverActiveTraders();

        // Sort by requested field
        const sortField = sortBy as string;
        const sortDir = order === "asc" ? 1 : -1;
        discovered.sort((a, b) => {
          let aVal = 0, bVal = 0;
          if (sortField === "winRate") { aVal = a.winRate; bVal = b.winRate; }
          else if (sortField === "totalPnl") { aVal = a.totalPnl; bVal = b.totalPnl; }
          else if (sortField === "roiPercent") { aVal = a.roiPercent; bVal = b.roiPercent; }
          else if (sortField === "roi30d") { aVal = a.roi30d; bVal = b.roi30d; }
          else if (sortField === "tradeCount") { aVal = a.tradeCount; bVal = b.tradeCount; }
          else if (sortField === "maxDrawdown") { aVal = a.maxDrawdown; bVal = b.maxDrawdown; }
          else { aVal = a.accountValue; bVal = b.accountValue; }
          return (aVal - bVal) * sortDir;
        });

        const liveTraders = discovered
          .slice(0, parseInt(limit))
          .map((t, i) => ({
            id: t.address,
            address: t.address,
            accountSize: t.accountValue.toFixed(2),
            totalPnl: t.totalPnl.toFixed(2),
            roiPercent: t.roiPercent,
            roi30d: t.roi30d,
            pnl30d: t.pnl30d.toFixed(2),
            winRate: t.winRate,
            tradeCount: t.tradeCount,
            maxLeverage: t.maxLeverage,
            maxDrawdown: t.maxDrawdown,
            lastActiveAt: null,
            compositeScore: null,
            rank: i + 1,
          }));
        return { traders: liveTraders, total: liveTraders.length, live: true };
      } catch (err) {
        req.log.error(err, "Live trader discovery failed");
      }
    }

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

    // Build synthetic profile from live data when DB profile is missing
    let effectiveProfile = profile || null;
    if (!profile && clearinghouse) {
      const accountValue = parseFloat(
        (clearinghouse as Record<string, Record<string, string>>)
          ?.crossMarginSummary?.accountValue || "0"
      );

      let totalPnl = 0;
      let pnl30d = 0;
      let wins = 0;
      let trades = 0;
      let maxLeverage = 0;
      let cumPnl = 0;
      let peak = 0;
      let maxDrawdown = 0;
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

      const allFills = Array.isArray(fills) ? fills : [];
      const sorted = [...allFills].sort(
        (a: Record<string, number>, b: Record<string, number>) =>
          (a.time || 0) - (b.time || 0)
      );
      for (const fill of sorted) {
        const closedPnl = parseFloat((fill as Record<string, string>).closedPnl || "0");
        if (closedPnl !== 0) {
          totalPnl += closedPnl;
          trades++;
          if (closedPnl > 0) wins++;
          if ((fill as Record<string, number>).time > thirtyDaysAgo) {
            pnl30d += closedPnl;
          }
          cumPnl += closedPnl;
          if (cumPnl > peak) peak = cumPnl;
          const dd = peak > 0 ? ((peak - cumPnl) / peak) * 100 : 0;
          if (dd > maxDrawdown) maxDrawdown = dd;
        }
      }

      const ch = clearinghouse as Record<string, { position: Record<string, { value: number }> }[]>;
      if (ch?.assetPositions) {
        for (const pos of ch.assetPositions) {
          const lev = pos.position?.leverage?.value || 0;
          if (lev > maxLeverage) maxLeverage = lev;
        }
      }

      effectiveProfile = {
        id: address,
        address,
        accountSize: accountValue.toFixed(2),
        totalPnl: totalPnl.toFixed(2),
        roiPercent: accountValue > 0 ? (totalPnl / accountValue) * 100 : 0,
        roi30d: accountValue > 0 ? (pnl30d / accountValue) * 100 : 0,
        pnl30d: pnl30d.toFixed(2),
        winRate: trades > 0 ? wins / trades : null,
        tradeCount: trades,
        maxLeverage,
        maxDrawdown,
        lastActiveAt: null,
        compositeScore: null,
        rank: null,
      } as unknown as typeof profile;
    }

    // Build live positions from clearinghouse when DB has none
    let effectivePositions = positions;
    if (positions.length === 0 && clearinghouse) {
      const chAny = clearinghouse as Record<string, unknown[]>;
      if (chAny?.assetPositions) {
        effectivePositions = (chAny.assetPositions as { position: Record<string, unknown> }[])
          .filter((p) => parseFloat(String(p.position?.szi || "0")) !== 0)
          .map((p) => ({
            id: String(p.position?.coin || ""),
            asset: String(p.position?.coin || ""),
            side: parseFloat(String(p.position?.szi || "0")) > 0 ? "long" : "short",
            size: Math.abs(parseFloat(String(p.position?.szi || "0"))).toString(),
            entryPrice: String(p.position?.entryPx || "0"),
            leverage: parseFloat(String((p.position?.leverage as Record<string, unknown>)?.value || "0")),
            unrealizedPnl: String(p.position?.unrealizedPnl || "0"),
          })) as typeof positions;
      }
    }

    return {
      profile: effectiveProfile,
      live: {
        clearinghouse,
        portfolio,
        recentFills: Array.isArray(fills) ? fills.slice(0, 50) : [],
      },
      positions: effectivePositions,
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
