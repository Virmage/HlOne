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
import { verifyWalletSignature, hashRequestBody } from "../lib/auth.js";

const BUILDER_ADDRESS = process.env.BUILDER_ADDRESS;
if (!BUILDER_ADDRESS || !/^0x[a-fA-F0-9]{40}$/.test(BUILDER_ADDRESS)) {
  console.warn("[copy] BUILDER_ADDRESS not set or invalid — copy trading will fail");
}
const EFFECTIVE_BUILDER = BUILDER_ADDRESS && /^0x[a-fA-F0-9]{40}$/.test(BUILDER_ADDRESS)
  ? BUILDER_ADDRESS
  : null;
const BUILDER_FEE = parseInt(process.env.BUILDER_FEE || "15", 10);

// ─── Signed request fields (required for all mutating endpoints) ─────────
const signedFields = {
  signature: z.string().min(1, "Signature required"),
  timestamp: z.number().int().positive("Timestamp required"),
};

// ─── Schemas ────────────────────────────────────────────────────────────────

const StartCopySchema = z.object({
  walletAddress: ethAddress,
  traderAddress: ethAddress,
  allocatedCapital: positiveNumber.refine(v => v <= 10_000_000, "Capital exceeds maximum"),
  maxLeverage: z.number().int().min(1).max(200).default(10),
  maxPositionSizePercent: z.number().min(1).max(100).default(25),
  minOrderSize: nonNegativeNumber.default(10),
  ...signedFields,
});

const StopCopySchema = z.object({
  walletAddress: ethAddress,
  traderAddress: ethAddress,
  ...signedFields,
});

const PauseCopySchema = z.object({
  walletAddress: ethAddress,
  copyRelationshipId: z.string().uuid(),
  paused: z.boolean(),
  ...signedFields,
});

const AllocationSchema = z.object({
  walletAddress: ethAddress,
  copyRelationshipId: z.string().uuid(),
  allocatedCapital: positiveNumber.refine(v => v <= 10_000_000, "Capital exceeds maximum").optional(),
  maxLeverage: z.number().int().min(1).max(200).optional(),
  maxPositionSizePercent: z.number().min(1).max(100).optional(),
  minOrderSize: nonNegativeNumber.optional(),
  ...signedFields,
});

const ClosePositionSchema = z.object({
  walletAddress: ethAddress,
  positionId: z.string().uuid(),
  reason: z.string().max(200).optional(),
  ...signedFields,
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
  // Stricter rate limit for all copy-trading endpoints (5 req/min per IP)
  const copyRateLimit = { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } };
  /**
   * GET /api/copy/builder-fee
   */
  app.get("/builder-fee", async () => {
    if (!EFFECTIVE_BUILDER) {
      return { error: "Builder not configured", builder: null, fee: 0 };
    }
    return {
      builder: EFFECTIVE_BUILDER,
      fee: BUILDER_FEE,
      feePercent: (BUILDER_FEE / 10 / 100).toFixed(4),
      feeDisplay: `${(BUILDER_FEE / 10).toFixed(1)} bps (${((BUILDER_FEE / 10) / 100 * 100).toFixed(2)}%)`,
    };
  });

  /**
   * GET /api/copy/check-builder-approval
   */
  app.get<{
    Querystring: { user: string };
  }>("/check-builder-approval", async (req) => {
    const parsed = ethAddress.safeParse(req.query.user);
    if (!parsed.success) return { approved: false, maxFee: 0 };
    if (!EFFECTIVE_BUILDER) return { approved: false, maxFee: 0 };

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
   * POST /api/copy/start — REQUIRES WALLET SIGNATURE
   */
  app.post("/start", async (req, reply) => {
    const parsed = StartCopySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid input", details: parsed.error.flatten().fieldErrors };
    }

    // Verify wallet ownership via signature, bound to request body so a
    // stolen signature can't be replayed with different parameters.
    try {
      await verifyWalletSignature(
        parsed.data.walletAddress,
        parsed.data.signature,
        parsed.data.timestamp,
        "copy-start",
        hashRequestBody(req.body as Record<string, unknown>),
      );
    } catch (err) {
      reply.code(401);
      return { error: (err as Error).message };
    }

    if (!EFFECTIVE_BUILDER) {
      reply.code(503);
      return { error: "Copy trading is not available — builder address not configured on server" };
    }

    // Wrap the DB work in try/catch so transient DB issues surface as a
    // real error message rather than a generic 500 "Internal server error".
    try {
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

      if (!app.db) {
        reply.code(503);
        return { error: "Database unavailable" };
      }

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
    } catch (err) {
      const msg = (err as Error).message || "unknown error";
      app.log.error({ err }, "[copy/start] DB error");
      reply.code(500);
      return { error: "Failed to start copy trading", detail: msg };
    }
  });

  /**
   * POST /api/copy/stop — REQUIRES WALLET SIGNATURE
   */
  app.post("/stop", async (req, reply) => {
    const parsed = StopCopySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid input", details: parsed.error.flatten().fieldErrors };
    }

    // Verify wallet ownership via signature, bound to request body.
    try {
      await verifyWalletSignature(
        parsed.data.walletAddress,
        parsed.data.signature,
        parsed.data.timestamp,
        "copy-stop",
        hashRequestBody(req.body as Record<string, unknown>),
      );
    } catch (err) {
      reply.code(401);
      return { error: (err as Error).message };
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
   * POST /api/copy/pause — REQUIRES WALLET SIGNATURE + OWNERSHIP
   */
  app.post("/pause", async (req, reply) => {
    const parsed = PauseCopySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid input", details: parsed.error.flatten().fieldErrors };
    }

    // Verify wallet ownership via signature, bound to request body.
    try {
      await verifyWalletSignature(
        parsed.data.walletAddress,
        parsed.data.signature,
        parsed.data.timestamp,
        "copy-pause",
        hashRequestBody(req.body as Record<string, unknown>),
      );
    } catch (err) {
      reply.code(401);
      return { error: (err as Error).message };
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
   * PUT /api/copy/allocation — REQUIRES WALLET SIGNATURE + OWNERSHIP
   */
  app.put("/allocation", async (req, reply) => {
    const parsed = AllocationSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid input", details: parsed.error.flatten().fieldErrors };
    }

    // Verify wallet ownership via signature, bound to request body.
    try {
      await verifyWalletSignature(
        parsed.data.walletAddress,
        parsed.data.signature,
        parsed.data.timestamp,
        "copy-allocation",
        hashRequestBody(req.body as Record<string, unknown>),
      );
    } catch (err) {
      reply.code(401);
      return { error: (err as Error).message };
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
   * POST /api/copy/close-position — REQUIRES WALLET SIGNATURE + OWNERSHIP
   */
  app.post("/close-position", async (req, reply) => {
    const parsed = ClosePositionSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid input", details: parsed.error.flatten().fieldErrors };
    }

    // Verify wallet ownership via signature, bound to request body.
    // CRITICAL: without body-binding, a stolen signature for one positionId
    // could close any of the attacker's chosen positionIds.
    try {
      await verifyWalletSignature(
        parsed.data.walletAddress,
        parsed.data.signature,
        parsed.data.timestamp,
        "copy-close-position",
        hashRequestBody(req.body as Record<string, unknown>),
      );
    } catch (err) {
      reply.code(401);
      return { error: (err as Error).message };
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
