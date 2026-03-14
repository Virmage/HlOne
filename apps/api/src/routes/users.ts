import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { users, apiWallets } from "@hl-copy/db";

export const userRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /api/users/connect
   * Create or fetch user by wallet address
   */
  app.post<{ Body: { walletAddress: string } }>("/connect", async (req) => {
    const addr = req.body.walletAddress.toLowerCase();

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
   * Get user profile
   */
  app.get<{ Params: { walletAddress: string } }>(
    "/:walletAddress",
    async (req) => {
      const addr = req.params.walletAddress.toLowerCase();

      const [user] = await app.db
        .select()
        .from(users)
        .where(eq(users.walletAddress, addr))
        .limit(1);

      if (!user) return { user: null };

      return { user };
    }
  );
};
