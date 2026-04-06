import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../.env") }); // apps/api/.env
import Fastify from "fastify";
import cors from "@fastify/cors";
import { createDb } from "@hl-copy/db";
import { traderRoutes } from "./routes/traders.js";
import { portfolioRoutes } from "./routes/portfolio.js";
import { copyRoutes } from "./routes/copy.js";
import { userRoutes } from "./routes/users.js";
import { marketRoutes } from "./routes/market.js";
import { startBackgroundJobs } from "./services/background-jobs.js";
import { initWhaleTrackerDb } from "./services/whale-tracker.js";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://localhost:5432/hl_copy";
const PORT = parseInt(process.env.PORT || "3001");

async function main() {
  console.log(`[startup] Starting API server (PORT=${PORT}, NODE_ENV=${process.env.NODE_ENV || "development"})...`);
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

  // Initialize whale tracker with DB for persistence
  initWhaleTrackerDb(db);

  // Register routes
  await app.register(traderRoutes, { prefix: "/api/traders" });
  await app.register(portfolioRoutes, { prefix: "/api/portfolio" });
  await app.register(copyRoutes, { prefix: "/api/copy" });
  await app.register(userRoutes, { prefix: "/api/users" });
  await app.register(marketRoutes, { prefix: "/api/market" });

  // Health check
  app.get("/api/health", async () => ({ status: "ok", version: "2.2.0", timestamp: Date.now() }));

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
      const e = err as Error;
      return { error: e.message, stack: e.stack, cause: e.cause ? String(e.cause) : undefined };
    }
  });

  console.log(`[startup] Routes registered, binding to port ${PORT}...`);
  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`[startup] API server running on port ${PORT}`);

  // Start background jobs after server is listening
  startBackgroundJobs();
}

main().catch(err => {
  console.error("[startup] FATAL: Server failed to start:");
  console.error(err);
  // Keep process alive for 30s so Railway logs can capture the error
  setTimeout(() => process.exit(1), 30_000);
});
