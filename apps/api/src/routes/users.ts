import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { users, apiWallets } from "@hl-copy/db";
import { ethAddress } from "../lib/validation.js";
import { verifyWalletSignature } from "../lib/auth.js";
import { z } from "zod";

const ConnectSchema = z.object({
  walletAddress: ethAddress,
  signature: z.string().min(1, "Signature required"),
  timestamp: z.number().int().positive("Timestamp required"),
});

export const userRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /api/users/connect — REQUIRES WALLET SIGNATURE
   * Create or fetch user by wallet address
   */
  app.post("/connect", async (req, reply) => {
    const parsed = ConnectSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid input", details: parsed.error.flatten().fieldErrors };
    }

    // Verify wallet ownership via signature
    try {
      await verifyWalletSignature(
        parsed.data.walletAddress,
        parsed.data.signature,
        parsed.data.timestamp,
        "connect",
      );
    } catch (err) {
      reply.code(401);
      return { error: (err as Error).message };
    }

    const addr = parsed.data.walletAddress.toLowerCase();

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

    // Check for existing API wallet
    const [apiWallet] = await app.db
      .select({
        agentAddress: apiWallets.agentAddress,
        isActive: apiWallets.isActive,
        expiresAt: apiWallets.expiresAt,
      })
      .from(apiWallets)
      .where(eq(apiWallets.userId, user.id))
      .limit(1);

    return {
      user: {
        id: user.id,
        walletAddress: user.walletAddress,
        createdAt: user.createdAt,
      },
      hasApiWallet: !!apiWallet?.isActive,
      apiWalletExpiry: apiWallet?.expiresAt || null,
    };
  });

  /**
   * GET /api/users/:walletAddress
   * Get user profile (read-only, no auth needed)
   */
  app.get<{ Params: { walletAddress: string } }>(
    "/:walletAddress",
    async (req, reply) => {
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

      if (!user) return { user: null };

      return { user };
    },
  );
};
