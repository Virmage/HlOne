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
  getUserFillsByTime,
  discoverActiveTraders,
} from "../services/hyperliquid.js";
import { getTraderDisplayName } from "../services/name-generator.js";
import { isSharpAddress } from "../services/smart-money.js";

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
    if (traders.length === 0) {
      try {
        req.log.info("DB returned 0 traders, fetching from leaderboard...");
        const discovered = await discoverActiveTraders();
        req.log.info(`Leaderboard returned ${discovered.length} traders`);

        // Sort by requested field — use a generic key accessor
        const sortField = sortBy as string;
        const sortDir = order === "asc" ? 1 : -1;
        const fieldMap: Record<string, keyof typeof discovered[0]> = {
          winRate: "winRate",
          totalPnl: "totalPnl",
          roiPercent: "roiPercent",
          roi30d: "roi30d",
          roiWeekly: "roiWeekly",
          tradeCount: "tradeCount",
          maxDrawdown: "maxDrawdown",
          accountSize: "accountValue",
        };
        const key = fieldMap[sortField] || "roi30d";
        discovered.sort((a, b) => {
          return ((a[key] as number) - (b[key] as number)) * sortDir;
        });

        const liveTraders = discovered
          .slice(parseInt(offset), parseInt(offset) + parseInt(limit))
          .map((t, i) => ({
            id: t.address,
            address: t.address,
            displayName: getTraderDisplayName(t.address, t.displayName),
            isSharp: isSharpAddress(t.address),
            accountSize: t.accountValue.toFixed(2),
            totalPnl: t.totalPnl.toFixed(2),
            roiPercent: t.roiPercent,
            roi30d: t.roi30d,
            roiWeekly: t.roiWeekly,
            pnl30d: t.pnl30d.toFixed(2),
            winRate: t.winRate > 0 ? t.winRate : null,
            tradeCount: t.tradeCount > 0 ? t.tradeCount : null,
            maxLeverage: t.maxLeverage > 0 ? t.maxLeverage : null,
            maxDrawdown: t.maxDrawdown > 0 ? t.maxDrawdown : null,
            lastActiveAt: null,
            compositeScore: null,
            rank: parseInt(offset) + i + 1,
          }));
        return { traders: liveTraders, total: discovered.length, live: true };
      } catch (err) {
        req.log.error(err, "Live trader discovery failed — returning empty");
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

    // Get from DB first (may fail if DB is unavailable)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let profile: any = undefined;
    let positions: any[] = [];
    let snapshots: any[] = [];

    try {
      const [dbProfile] = await app.db
        .select()
        .from(traderProfiles)
        .where(eq(traderProfiles.address, address.toLowerCase()))
        .limit(1);
      profile = dbProfile;

      if (profile) {
        positions = await app.db
          .select()
          .from(sourcePositions)
          .where(eq(sourcePositions.traderProfileId, profile.id));

        snapshots = await app.db
          .select()
          .from(traderSnapshots)
          .where(eq(traderSnapshots.traderProfileId, profile.id))
          .orderBy(traderSnapshots.snapshotAt);
      }
    } catch {
      // DB unavailable — continue with live data only
      req.log.warn("DB unavailable for trader detail, using live data only");
    }

    // Fetch live data from Hyperliquid
    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const [clearinghouse, portfolio, fills] = await Promise.all([
      getClearinghouseState(address).catch(() => null),
      getPortfolio(address).catch(() => null),
      getUserFillsByTime(address, ninetyDaysAgo).catch(() =>
        getUserFills(address).catch(() => [])
      ),
    ]);

    // Extract portfolio equity curve from allTime window + compute 90d ROI
    // Portfolio response is [[window, {accountValueHistory, pnlHistory, vlm}], ...]
    let portfolioEquityCurve: { time: string; value: string; pnl: string; drawdown: string | null }[] = [];
    let roi90d: number | null = null;
    if (portfolio && Array.isArray(portfolio)) {
      for (const [window, data] of portfolio as [string, { accountValueHistory?: [number, string][]; pnlHistory?: [number, string][] }][]) {
        if (window === "allTime" && data.accountValueHistory && data.accountValueHistory.length > 0) {
          let peak = 0;
          const pnlMap = new Map<number, string>();
          if (data.pnlHistory) {
            for (const [ts, pnl] of data.pnlHistory) pnlMap.set(ts, pnl);
          }
          for (const [ts, val] of data.accountValueHistory) {
            const value = parseFloat(val || "0");
            if (value > peak) peak = value;
            const dd = peak > 0 ? ((peak - value) / peak) * 100 : 0;
            portfolioEquityCurve.push({
              time: new Date(ts).toISOString(),
              value: value.toFixed(2),
              pnl: pnlMap.get(ts) || "0",
              drawdown: dd.toFixed(2),
            });
          }

          // Compute 90d ROI from account value history
          const history = data.accountValueHistory;
          const currentValue = parseFloat(history[history.length - 1][1] || "0");
          const ninetyDaysAgoTs = Date.now() - 90 * 24 * 60 * 60 * 1000;
          // Find closest point to 90 days ago
          let closestPoint = history[0];
          let closestDiff = Math.abs(history[0][0] - ninetyDaysAgoTs);
          for (const point of history) {
            const diff = Math.abs(point[0] - ninetyDaysAgoTs);
            if (diff < closestDiff) {
              closestDiff = diff;
              closestPoint = point;
            }
          }
          const pastValue = parseFloat(closestPoint[1] || "0");
          if (pastValue > 0) {
            roi90d = ((currentValue - pastValue) / pastValue) * 100;
          }

          break;
        }
      }
    }

    // Also look up this trader in the leaderboard cache for accurate ROI
    let leaderboardData: Awaited<ReturnType<typeof discoverActiveTraders>>[0] | undefined;
    try {
      const allTraders = await discoverActiveTraders();
      leaderboardData = allTraders.find(t => t.address.toLowerCase() === address.toLowerCase());
    } catch { /* ignore */ }

    // Build synthetic profile from live data when DB profile is missing
    let effectiveProfile = profile || null;
    if (!profile) {
      const accountValue = clearinghouse
        ? parseFloat(
            (clearinghouse as Record<string, Record<string, string>>)
              ?.crossMarginSummary?.accountValue || "0"
          )
        : leaderboardData?.accountValue ?? 0;

      let totalPnl = 0;
      let pnl30d = 0;
      let wins = 0;
      let trades = 0;
      let maxLeverage = 0;
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
        }
      }

      // Compute 30D drawdown from portfolio equity curve (last 30 days only)
      let maxDrawdown = 0;
      if (portfolioEquityCurve.length > 0) {
        const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
        const recentCurve = portfolioEquityCurve.filter(
          (point) => new Date(point.time).getTime() >= thirtyDaysAgo
        );
        if (recentCurve.length > 0) {
          let eqPeak = 0;
          for (const point of recentCurve) {
            const val = parseFloat(point.value);
            if (val > eqPeak) eqPeak = val;
            if (eqPeak > 0) {
              const dd = ((eqPeak - val) / eqPeak) * 100;
              if (dd > maxDrawdown) maxDrawdown = dd;
            }
          }
        }
      }

      if (clearinghouse) {
        const ch = clearinghouse as Record<string, { position: Record<string, { value: number }> }[]>;
        if (ch?.assetPositions) {
          for (const pos of ch.assetPositions) {
            const lev = pos.position?.leverage?.value || 0;
            if (lev > maxLeverage) maxLeverage = lev;
          }
        }
      }

      // Use leaderboard data for ROI when available (avoids division by current account value which may be 0)
      const roiPercent = leaderboardData?.roiAllTime ?? (accountValue > 0 ? (totalPnl / accountValue) * 100 : 0);
      const roi30dVal = leaderboardData?.roi30d ?? (accountValue > 0 ? (pnl30d / accountValue) * 100 : 0);
      const effectivePnl = leaderboardData?.totalPnl ?? totalPnl;
      const effectivePnl30d = leaderboardData?.pnl30d ?? pnl30d;
      const effectiveAccountValue = accountValue > 0 ? accountValue : (leaderboardData?.accountValue ?? 0);

      effectiveProfile = {
        id: address,
        address,
        displayName: leaderboardData?.displayName ?? null,
        accountSize: effectiveAccountValue.toFixed(2),
        totalPnl: effectivePnl.toFixed(2),
        roiPercent,
        roi30d: roi30dVal,
        roi90d,
        pnl30d: effectivePnl30d.toFixed(2),
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
      equityCurve: snapshots.length > 0
        ? snapshots.map((s: any) => ({
            time: s.snapshotAt,
            value: s.accountValue,
            pnl: s.totalPnl,
            drawdown: s.drawdownPercent,
          }))
        : portfolioEquityCurve,
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
