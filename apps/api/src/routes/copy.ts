import type { FastifyPluginAsync } from "fastify";
import { eq, and } from "drizzle-orm";
import {
  users,
  traderProfiles,
  copyRelationships,
  copyAllocations,
  copiedPositions,
} from "@hl-copy/db";

const BUILDER_ADDRESS = process.env.BUILDER_ADDRESS || "0xB4a59142607C744CCF6C4828f01A6ab79c1f2520";
const BUILDER_FEE = parseInt(process.env.BUILDER_FEE || "20", 10); // tenths of bps: 20 = 2 bps = 0.02%

export const copyRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /api/copy/builder-fee
   * Returns builder fee config so frontend can prompt user approval
   */
  app.get("/builder-fee", async () => {
    return {
      builder: BUILDER_ADDRESS,
      fee: BUILDER_FEE,
      feePercent: (BUILDER_FEE / 10 / 100).toFixed(4), // e.g. "0.0005" = 0.05%
      feeDisplay: `${(BUILDER_FEE / 10).toFixed(1)} bps (${((BUILDER_FEE / 10) / 100 * 100).toFixed(2)}%)`,
    };
  });

  /**
   * GET /api/copy/check-builder-approval
   * Check if user has approved the builder fee
   */
  app.get<{
    Querystring: { user: string };
  }>("/check-builder-approval", async (req) => {
    if (!BUILDER_ADDRESS || !req.query.user) {
      return { approved: false, maxFee: 0 };
    }
    try {
      const res = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "maxBuilderFee",
          user: req.query.user,
          builder: BUILDER_ADDRESS,
        }),
      });
      const maxFee = await res.json();
      return { approved: Number(maxFee) >= BUILDER_FEE, maxFee: Number(maxFee) };
    } catch {
      return { approved: false, maxFee: 0 };
    }
  });
  /**
   * POST /api/copy/start
   * Start copying a trader
   */
  app.post<{
    Body: {
      walletAddress: string;
      traderAddress: string;
      allocatedCapital: number;
      maxLeverage?: number;
      maxPositionSizePercent?: number;
      minOrderSize?: number;
    };
  }>("/start", async (req, reply) => {
    const {
      walletAddress,
      traderAddress,
      allocatedCapital,
      maxLeverage = 10,
      maxPositionSizePercent = 25,
      minOrderSize = 10,
    } = req.body;

    const addr = walletAddress.toLowerCase();
    const traderAddr = traderAddress.toLowerCase();

    // Get or create user
    let [user] = await app.db
      .select()
      .from(users)
      .where(eq(users.walletAddress, addr))
      .limit(1);

    if (!user) {
      [user] = await app.db
        .insert(users)
        .values({ walletAddress: addr })
        .returning();
    }

    // Get or create trader profile
    let [trader] = await app.db
      .select()
      .from(traderProfiles)
      .where(eq(traderProfiles.address, traderAddr))
      .limit(1);

    if (!trader) {
      [trader] = await app.db
        .insert(traderProfiles)
        .values({ address: traderAddr })
        .returning();
    }

    // Check for existing relationship
    const [existing] = await app.db
      .select()
      .from(copyRelationships)
      .where(
        and(
          eq(copyRelationships.userId, user.id),
          eq(copyRelationships.traderProfileId, trader.id)
        )
      )
      .limit(1);

    if (existing) {
      // Reactivate if inactive
      if (!existing.isActive) {
        await app.db
          .update(copyRelationships)
          .set({ isActive: true, isPaused: false, updatedAt: new Date() })
          .where(eq(copyRelationships.id, existing.id));
      }

      // Update allocation
      await app.db
        .insert(copyAllocations)
        .values({
          copyRelationshipId: existing.id,
          allocatedCapital: allocatedCapital.toString(),
          maxLeverage,
          maxPositionSizePercent,
          minOrderSize: minOrderSize.toString(),
        })
        .onConflictDoUpdate({
          target: copyAllocations.copyRelationshipId,
          set: {
            allocatedCapital: allocatedCapital.toString(),
            maxLeverage,
            maxPositionSizePercent,
            minOrderSize: minOrderSize.toString(),
            updatedAt: new Date(),
          },
        });

      return { id: existing.id, status: "reactivated" };
    }

    // Create new relationship + allocation
    const [rel] = await app.db
      .insert(copyRelationships)
      .values({
        userId: user.id,
        traderProfileId: trader.id,
      })
      .returning();

    await app.db.insert(copyAllocations).values({
      copyRelationshipId: rel.id,
      allocatedCapital: allocatedCapital.toString(),
      maxLeverage,
      maxPositionSizePercent,
      minOrderSize: minOrderSize.toString(),
    });

    return { id: rel.id, status: "created" };
  });

  /**
   * POST /api/copy/stop
   * Stop copying a trader
   */
  app.post<{
    Body: { walletAddress: string; traderAddress: string };
  }>("/stop", async (req) => {
    const addr = req.body.walletAddress.toLowerCase();
    const traderAddr = req.body.traderAddress.toLowerCase();

    const [user] = await app.db
      .select()
      .from(users)
      .where(eq(users.walletAddress, addr))
      .limit(1);

    if (!user) return { status: "not_found" };

    const [trader] = await app.db
      .select()
      .from(traderProfiles)
      .where(eq(traderProfiles.address, traderAddr))
      .limit(1);

    if (!trader) return { status: "not_found" };

    await app.db
      .update(copyRelationships)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(
          eq(copyRelationships.userId, user.id),
          eq(copyRelationships.traderProfileId, trader.id)
        )
      );

    return { status: "stopped" };
  });

  /**
   * POST /api/copy/pause
   * Pause/unpause copying
   */
  app.post<{
    Body: { copyRelationshipId: string; paused: boolean };
  }>("/pause", async (req) => {
    await app.db
      .update(copyRelationships)
      .set({ isPaused: req.body.paused, updatedAt: new Date() })
      .where(eq(copyRelationships.id, req.body.copyRelationshipId));

    return { status: req.body.paused ? "paused" : "resumed" };
  });

  /**
   * PUT /api/copy/allocation
   * Update copy allocation settings
   */
  app.put<{
    Body: {
      copyRelationshipId: string;
      allocatedCapital?: number;
      maxLeverage?: number;
      maxPositionSizePercent?: number;
      minOrderSize?: number;
    };
  }>("/allocation", async (req) => {
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (req.body.allocatedCapital !== undefined) {
      updates.allocatedCapital = req.body.allocatedCapital.toString();
    }
    if (req.body.maxLeverage !== undefined) {
      updates.maxLeverage = req.body.maxLeverage;
    }
    if (req.body.maxPositionSizePercent !== undefined) {
      updates.maxPositionSizePercent = req.body.maxPositionSizePercent;
    }
    if (req.body.minOrderSize !== undefined) {
      updates.minOrderSize = req.body.minOrderSize.toString();
    }

    await app.db
      .update(copyAllocations)
      .set(updates)
      .where(
        eq(copyAllocations.copyRelationshipId, req.body.copyRelationshipId)
      );

    return { status: "updated" };
  });

  /**
   * POST /api/copy/close-position
   * Manually close a copied position
   */
  app.post<{
    Body: { positionId: string; reason?: string };
  }>("/close-position", async (req) => {
    const [position] = await app.db
      .select()
      .from(copiedPositions)
      .where(eq(copiedPositions.id, req.body.positionId))
      .limit(1);

    if (!position || !position.isOpen) {
      return { status: "not_found" };
    }

    // Mark as closed in DB — actual order submission happens in the worker
    await app.db
      .update(copiedPositions)
      .set({ isOpen: false, closedAt: new Date() })
      .where(eq(copiedPositions.id, req.body.positionId));

    // TODO: In Phase 3, enqueue a BullMQ job to submit close order to Hyperliquid

    return { status: "closed", positionId: req.body.positionId };
  });
};
