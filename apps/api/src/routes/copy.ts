import type { FastifyPluginAsync } from "fastify";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import {
  users,
  traderProfiles,
  copyRelationships,
  copyAllocations,
  copiedPositions,
} from "@hl-copy/db";
import { ethAddress, positiveNumber, nonNegativeNumber } from "../lib/validation.js";

const BUILDER_ADDRESS = process.env.BUILDER_ADDRESS;
if (!BUILDER_ADDRESS || !/^0x[a-fA-F0-9]{40}$/.test(BUILDER_ADDRESS)) {
  console.warn("[copy] BUILDER_ADDRESS not set or invalid — using default");
}
const EFFECTIVE_BUILDER = BUILDER_ADDRESS || "0xB4a59142607C744CCF6C4828f01A6ab79c1f2520";
const BUILDER_FEE = parseInt(process.env.BUILDER_FEE || "20", 10);

// ─── Schemas ────────────────────────────────────────────────────────────────

const StartCopySchema = z.object({
  walletAddress: ethAddress,
  traderAddress: ethAddress,
  allocatedCapital: positiveNumber,
  maxLeverage: z.number().int().min(1).max(200).default(10),
  maxPositionSizePercent: z.number().min(1).max(100).default(25),
  minOrderSize: nonNegativeNumber.default(10),
});

const StopCopySchema = z.object({
  walletAddress: ethAddress,
  traderAddress: ethAddress,
});

const PauseCopySchema = z.object({
  walletAddress: ethAddress, // caller must prove ownership
  copyRelationshipId: z.string().uuid(),
  paused: z.boolean(),
});

const AllocationSchema = z.object({
  walletAddress: ethAddress, // caller must prove ownership
  copyRelationshipId: z.string().uuid(),
  allocatedCapital: positiveNumber.optional(),
  maxLeverage: z.number().int().min(1).max(200).optional(),
  maxPositionSizePercent: z.number().min(1).max(100).optional(),
  minOrderSize: nonNegativeNumber.optional(),
});

const ClosePositionSchema = z.object({
  walletAddress: ethAddress, // caller must prove ownership
  positionId: z.string().uuid(),
  reason: z.string().max(200).optional(),
});

// ─── Helper: verify caller owns the copy relationship ───────────────────────

async function verifyOwnership(
  db: typeof import("@hl-copy/db").createDb extends (...args: any[]) => infer R ? R : never,
  walletAddress: string,
  copyRelationshipId: string,
): Promise<{ userId: string } | null> {
  const addr = walletAddress.toLowerCase();

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.walletAddress, addr))
    .limit(1);

  if (!user) return null;

  const [rel] = await db
    .select({ id: copyRelationships.id })
    .from(copyRelationships)
    .where(
      and(
        eq(copyRelationships.id, copyRelationshipId),
        eq(copyRelationships.userId, user.id),
      ),
    )
    .limit(1);

  if (!rel) return null;
  return { userId: user.id };
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export const copyRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /api/copy/builder-fee
   */
  app.get("/builder-fee", async () => ({
    builder: EFFECTIVE_BUILDER,
    fee: BUILDER_FEE,
    feePercent: (BUILDER_FEE / 10 / 100).toFixed(4),
    feeDisplay: `${(BUILDER_FEE / 10).toFixed(1)} bps (${((BUILDER_FEE / 10) / 100 * 100).toFixed(2)}%)`,
  }));

  /**
   * GET /api/copy/check-builder-approval
   */
  app.get<{
    Querystring: { user: string };
  }>("/check-builder-approval", async (req) => {
    const parsed = ethAddress.safeParse(req.query.user);
    if (!parsed.success) return { approved: false, maxFee: 0 };

    try {
      const res = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "maxBuilderFee",
          user: parsed.data,
          builder: EFFECTIVE_BUILDER,
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
   */
  app.post("/start", async (req, reply) => {
    const parsed = StartCopySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid input", details: parsed.error.flatten().fieldErrors };
    }

    const {
      walletAddress,
      traderAddress,
      allocatedCapital,
      maxLeverage,
      maxPositionSizePercent,
      minOrderSize,
    } = parsed.data;

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
          eq(copyRelationships.traderProfileId, trader.id),
        ),
      )
      .limit(1);

    if (existing) {
      if (!existing.isActive) {
        await app.db
          .update(copyRelationships)
          .set({ isActive: true, isPaused: false, updatedAt: new Date() })
          .where(eq(copyRelationships.id, existing.id));
      }

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
   */
  app.post("/stop", async (req, reply) => {
    const parsed = StopCopySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid input", details: parsed.error.flatten().fieldErrors };
    }

    const addr = parsed.data.walletAddress.toLowerCase();
    const traderAddr = parsed.data.traderAddress.toLowerCase();

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
          eq(copyRelationships.traderProfileId, trader.id),
        ),
      );

    return { status: "stopped" };
  });

  /**
   * POST /api/copy/pause — REQUIRES OWNERSHIP
   */
  app.post("/pause", async (req, reply) => {
    const parsed = PauseCopySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid input", details: parsed.error.flatten().fieldErrors };
    }

    const owner = await verifyOwnership(app.db, parsed.data.walletAddress, parsed.data.copyRelationshipId);
    if (!owner) {
      reply.code(403);
      return { error: "Forbidden: you do not own this copy relationship" };
    }

    await app.db
      .update(copyRelationships)
      .set({ isPaused: parsed.data.paused, updatedAt: new Date() })
      .where(eq(copyRelationships.id, parsed.data.copyRelationshipId));

    return { status: parsed.data.paused ? "paused" : "resumed" };
  });

  /**
   * PUT /api/copy/allocation — REQUIRES OWNERSHIP
   */
  app.put("/allocation", async (req, reply) => {
    const parsed = AllocationSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid input", details: parsed.error.flatten().fieldErrors };
    }

    const owner = await verifyOwnership(app.db, parsed.data.walletAddress, parsed.data.copyRelationshipId);
    if (!owner) {
      reply.code(403);
      return { error: "Forbidden: you do not own this copy relationship" };
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.allocatedCapital !== undefined) {
      updates.allocatedCapital = parsed.data.allocatedCapital.toString();
    }
    if (parsed.data.maxLeverage !== undefined) {
      updates.maxLeverage = parsed.data.maxLeverage;
    }
    if (parsed.data.maxPositionSizePercent !== undefined) {
      updates.maxPositionSizePercent = parsed.data.maxPositionSizePercent;
    }
    if (parsed.data.minOrderSize !== undefined) {
      updates.minOrderSize = parsed.data.minOrderSize.toString();
    }

    await app.db
      .update(copyAllocations)
      .set(updates)
      .where(eq(copyAllocations.copyRelationshipId, parsed.data.copyRelationshipId));

    return { status: "updated" };
  });

  /**
   * POST /api/copy/close-position — REQUIRES OWNERSHIP
   */
  app.post("/close-position", async (req, reply) => {
    const parsed = ClosePositionSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid input", details: parsed.error.flatten().fieldErrors };
    }

    const [position] = await app.db
      .select()
      .from(copiedPositions)
      .where(eq(copiedPositions.id, parsed.data.positionId))
      .limit(1);

    if (!position || !position.isOpen) {
      return { status: "not_found" };
    }

    // Verify caller owns the relationship this position belongs to
    const owner = await verifyOwnership(app.db, parsed.data.walletAddress, position.copyRelationshipId);
    if (!owner) {
      reply.code(403);
      return { error: "Forbidden: you do not own this position" };
    }

    await app.db
      .update(copiedPositions)
      .set({ isOpen: false, closedAt: new Date() })
      .where(eq(copiedPositions.id, parsed.data.positionId));

    return { status: "closed", positionId: parsed.data.positionId };
  });
};
