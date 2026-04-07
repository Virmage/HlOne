import type { FastifyPluginAsync } from "fastify";
import { eq, and, desc } from "drizzle-orm";
import {
  users,
  copyRelationships,
  copyAllocations,
  copiedPositions,
  traderProfiles,
  portfolioSnapshots,
  executions,
} from "@hl-copy/db";
import { getClearinghouseState } from "../services/hyperliquid.js";
import { ethAddress } from "../lib/validation.js";

export const portfolioRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /api/portfolio/:walletAddress
   * Full portfolio overview for a user
   */
  app.get<{ Params: { walletAddress: string } }>(
    "/:walletAddress",
    async (req, reply) => {
      const { walletAddress } = req.params;
      if (!ethAddress.safeParse(walletAddress).success) {
        reply.code(400);
        return { error: "Invalid wallet address" };
      }
      const addr = walletAddress.toLowerCase();

      // Get user
      const [user] = await app.db
        .select()
        .from(users)
        .where(eq(users.walletAddress, addr))
        .limit(1);

      if (!user) {
        return {
          overview: null,
          copiedTraders: [],
          openPositions: [],
          suggestions: [],
        };
      }

      // Get live wallet state from Hyperliquid
      const liveState = await getClearinghouseState(walletAddress).catch(
        () => null
      );

      // Get all copy relationships with allocations and trader info
      const relationships = await app.db
        .select({
          id: copyRelationships.id,
          isActive: copyRelationships.isActive,
          isPaused: copyRelationships.isPaused,
          createdAt: copyRelationships.createdAt,
          traderAddress: traderProfiles.address,
          traderPnl: traderProfiles.totalPnl,
          traderRoi: traderProfiles.roiPercent,
          allocatedCapital: copyAllocations.allocatedCapital,
          maxLeverage: copyAllocations.maxLeverage,
          maxPositionSizePercent: copyAllocations.maxPositionSizePercent,
        })
        .from(copyRelationships)
        .innerJoin(
          traderProfiles,
          eq(copyRelationships.traderProfileId, traderProfiles.id)
        )
        .leftJoin(
          copyAllocations,
          eq(copyRelationships.id, copyAllocations.copyRelationshipId)
        )
        .where(eq(copyRelationships.userId, user.id));

      // Get all open copied positions
      const openPositions = await app.db
        .select({
          id: copiedPositions.id,
          asset: copiedPositions.asset,
          side: copiedPositions.side,
          size: copiedPositions.size,
          entryPrice: copiedPositions.entryPrice,
          currentPrice: copiedPositions.currentPrice,
          unrealizedPnl: copiedPositions.unrealizedPnl,
          realizedPnl: copiedPositions.realizedPnl,
          openedAt: copiedPositions.openedAt,
          traderAddress: traderProfiles.address,
          copyRelationshipId: copiedPositions.copyRelationshipId,
        })
        .from(copiedPositions)
        .innerJoin(
          copyRelationships,
          eq(copiedPositions.copyRelationshipId, copyRelationships.id)
        )
        .innerJoin(
          traderProfiles,
          eq(copyRelationships.traderProfileId, traderProfiles.id)
        )
        .where(
          and(
            eq(copyRelationships.userId, user.id),
            eq(copiedPositions.isOpen, true)
          )
        );

      // Compute suggestions
      const suggestions = generateSuggestions(
        relationships,
        openPositions,
        liveState
      );

      // Compute overview
      const totalAllocated = relationships.reduce(
        (sum, r) => sum + parseFloat(r.allocatedCapital || "0"),
        0
      );
      const totalUnrealizedPnl = openPositions.reduce(
        (sum, p) => sum + parseFloat(p.unrealizedPnl || "0"),
        0
      );
      const totalRealizedPnl = openPositions.reduce(
        (sum, p) => sum + parseFloat(p.realizedPnl || "0"),
        0
      );

      const accountValue = liveState?.crossMarginSummary?.accountValue
        ? parseFloat(liveState.crossMarginSummary.accountValue)
        : 0;

      return {
        overview: {
          walletBalance: accountValue,
          availableMargin: liveState?.withdrawable
            ? parseFloat(liveState.withdrawable)
            : 0,
          allocatedCapital: totalAllocated,
          unrealizedPnl: totalUnrealizedPnl,
          realizedPnl: totalRealizedPnl,
          idleCapital: accountValue - totalAllocated,
        },
        copiedTraders: relationships.map((r) => {
          // Sum PnL from positions for this relationship
          const relPositions = openPositions.filter(
            (p) => p.copyRelationshipId === r.id
          );
          const exposure = relPositions.reduce(
            (sum, p) => sum + Math.abs(parseFloat(p.size || "0")) * parseFloat(p.currentPrice || p.entryPrice || "0"),
            0
          );
          const pnlContribution = relPositions.reduce(
            (sum, p) => sum + parseFloat(p.unrealizedPnl || "0"),
            0
          );

          return {
            ...r,
            currentExposure: exposure,
            pnlContribution,
            positionCount: relPositions.length,
          };
        }),
        openPositions,
        suggestions,
      };
    }
  );

  /**
   * GET /api/portfolio/:walletAddress/history
   * Portfolio value over time
   */
  app.get<{
    Params: { walletAddress: string };
    Querystring: { days?: string };
  }>("/:walletAddress/history", async (req, reply) => {
    if (!ethAddress.safeParse(req.params.walletAddress).success) {
      reply.code(400);
      return { error: "Invalid wallet address" };
    }
    const addr = req.params.walletAddress.toLowerCase();
    const [user] = await app.db
      .select()
      .from(users)
      .where(eq(users.walletAddress, addr))
      .limit(1);

    if (!user) return { snapshots: [] };

    const days = Math.min(Math.max(1, parseInt(req.query.days || "30") || 30), 365);
    const snapshots = await app.db
      .select()
      .from(portfolioSnapshots)
      .where(eq(portfolioSnapshots.userId, user.id))
      .orderBy(desc(portfolioSnapshots.snapshotAt))
      .limit(days);

    return { snapshots: snapshots.reverse() };
  });

  /**
   * GET /api/portfolio/:walletAddress/executions
   * Recent trade executions
   */
  app.get<{
    Params: { walletAddress: string };
    Querystring: { limit?: string };
  }>("/:walletAddress/executions", async (req, reply) => {
    if (!ethAddress.safeParse(req.params.walletAddress).success) {
      reply.code(400);
      return { error: "Invalid wallet address" };
    }
    const addr = req.params.walletAddress.toLowerCase();
    const [user] = await app.db
      .select()
      .from(users)
      .where(eq(users.walletAddress, addr))
      .limit(1);

    if (!user) return { executions: [] };

    const rels = await app.db
      .select({ id: copyRelationships.id })
      .from(copyRelationships)
      .where(eq(copyRelationships.userId, user.id));

    if (rels.length === 0) return { executions: [] };

    const recentExecs = await app.db
      .select()
      .from(executions)
      .where(
        eq(executions.copyRelationshipId, rels[0].id) // simplified — in prod would use IN clause
      )
      .orderBy(desc(executions.createdAt))
      .limit(Math.min(Math.max(1, parseInt(req.query.limit || "50") || 50), 200));

    return { executions: recentExecs };
  });
};

// ─── Suggestions Engine ──────────────────────────────────────────────────────

function generateSuggestions(
  relationships: {
    traderAddress: string | null;
    allocatedCapital: string | null;
    isPaused: boolean;
  }[],
  openPositions: { asset: string; size: string | null; traderAddress: string | null }[],
  liveState: { crossMarginSummary?: { accountValue: string }; withdrawable?: string } | null
): string[] {
  const suggestions: string[] = [];

  // Check for concentration risk
  const assetExposure = new Map<string, number>();
  for (const pos of openPositions) {
    const current = assetExposure.get(pos.asset) || 0;
    assetExposure.set(pos.asset, current + Math.abs(parseFloat(pos.size || "0")));
  }
  const totalExposure = [...assetExposure.values()].reduce((a, b) => a + b, 0);
  for (const [asset, exposure] of assetExposure) {
    const pct = totalExposure > 0 ? (exposure / totalExposure) * 100 : 0;
    if (pct > 50) {
      suggestions.push(
        `${Math.round(pct)}% of exposure is ${asset} — consider diversifying`
      );
    }
  }

  // Check for idle capital
  if (liveState?.crossMarginSummary) {
    const accountValue = parseFloat(liveState.crossMarginSummary.accountValue);
    const totalAllocated = relationships.reduce(
      (sum, r) => sum + parseFloat(r.allocatedCapital || "0"),
      0
    );
    const idle = accountValue - totalAllocated;
    if (idle > 100) {
      suggestions.push(
        `You have $${idle.toFixed(0)} idle capital not allocated to any trader`
      );
    }
  }

  // Check for trader overlap
  const traderAssets = new Map<string, Set<string>>();
  for (const pos of openPositions) {
    if (!pos.traderAddress) continue;
    if (!traderAssets.has(pos.traderAddress)) {
      traderAssets.set(pos.traderAddress, new Set());
    }
    traderAssets.get(pos.traderAddress)!.add(pos.asset);
  }
  const traderAddresses = [...traderAssets.keys()];
  for (let i = 0; i < traderAddresses.length; i++) {
    for (let j = i + 1; j < traderAddresses.length; j++) {
      const a = traderAssets.get(traderAddresses[i])!;
      const b = traderAssets.get(traderAddresses[j])!;
      const overlap = [...a].filter((x) => b.has(x));
      if (overlap.length >= 2) {
        const addrA = traderAddresses[i].slice(0, 8);
        const addrB = traderAddresses[j].slice(0, 8);
        suggestions.push(
          `Traders ${addrA}… and ${addrB}… overlap on ${overlap.join(", ")}`
        );
      }
    }
  }

  // Check for paused traders
  const pausedCount = relationships.filter((r) => r.isPaused).length;
  if (pausedCount > 0) {
    suggestions.push(
      `${pausedCount} trader${pausedCount > 1 ? "s" : ""} paused — review if still intended`
    );
  }

  return suggestions;
}
