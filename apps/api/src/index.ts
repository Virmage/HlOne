import Fastify from "fastify";
import cors from "@fastify/cors";
import { createDb } from "@hl-copy/db";
import { traderRoutes } from "./routes/traders.js";
import { portfolioRoutes } from "./routes/portfolio.js";
import { copyRoutes } from "./routes/copy.js";
import { userRoutes } from "./routes/users.js";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://localhost:5432/hl_copy";
const PORT = parseInt(process.env.PORT || "3001");

async function main() {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: process.env.FRONTEND_URL
      ? [process.env.FRONTEND_URL, "http://localhost:3000"]
      : "http://localhost:3000",
    credentials: true,
  });

  // Share db instance across routes
  const db = createDb(DATABASE_URL);
  app.decorate("db", db);

  // Register routes
  await app.register(traderRoutes, { prefix: "/api/traders" });
  await app.register(portfolioRoutes, { prefix: "/api/portfolio" });
  await app.register(copyRoutes, { prefix: "/api/copy" });
  await app.register(userRoutes, { prefix: "/api/users" });

  // Health check
  app.get("/api/health", async () => ({ status: "ok", version: "1.3.0", timestamp: Date.now() }));

  // Debug: test leaderboard fetch directly
  app.get("/api/debug/leaderboard", async (req, reply) => {
    try {
      const { discoverActiveTraders } = await import("./services/hyperliquid.js");
      const start = Date.now();
      const traders = await discoverActiveTraders();
      return {
        count: traders.length,
        fetchMs: Date.now() - start,
        sample: traders.slice(0, 3).map(t => ({
          address: t.address.slice(0, 10),
          roi30d: t.roi30d,
          roiAllTime: t.roiAllTime,
          displayName: t.displayName,
        })),
      };
    } catch (err) {
      reply.code(500);
      return { error: String(err) };
    }
  });

  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`API server running on port ${PORT}`);
}

main().catch(console.error);
