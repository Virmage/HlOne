import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env") }); // apps/api/.env
import Fastify from "fastify";
import cors from "@fastify/cors";
import compress from "@fastify/compress";
import rateLimit from "@fastify/rate-limit";
import { createDb, runMigrations } from "@hl-copy/db";
import { traderRoutes } from "./routes/traders.js";
import { portfolioRoutes } from "./routes/portfolio.js";
import { copyRoutes } from "./routes/copy.js";
import { userRoutes } from "./routes/users.js";
import { marketRoutes, setPrewarmPort } from "./routes/market.js";
import { startBackgroundJobs } from "./services/background-jobs.js";
import { initWhaleTrackerDb } from "./services/whale-tracker.js";
import { initOITrackerDb } from "./services/oi-tracker.js";
import { initTopTraderFillsDb, loadFillsFromDb } from "./services/top-trader-fills.js";
import { initRedis } from "./services/cache.js";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://localhost:5432/hl_copy";
const PORT = parseInt(process.env.PORT || "3001");
const IS_PRODUCTION = process.env.NODE_ENV === "production";

async function main() {
  console.log(`[startup] Starting API server (PORT=${PORT}, NODE_ENV=${process.env.NODE_ENV || "development"})...`);
  console.log(`[startup] COINALYZE_API_KEY: ${process.env.COINALYZE_API_KEY ? "set (" + process.env.COINALYZE_API_KEY.slice(0, 8) + "...)" : "NOT SET"}`);

  // ─── Redis (optional — enables multi-instance caching) ──────────────────────
  initRedis();

  // ─── Auto-run DB migrations (non-blocking — don't delay server start) ───────
  runMigrations(DATABASE_URL)
    .then(() => console.log("[startup] Migrations OK"))
    .catch(err => console.error("[startup] Migration failed (non-fatal):", (err as Error).message));

  console.log("[startup] Creating Fastify instance...");
  const app = Fastify({ logger: true });

  // ─── Gzip/Brotli compression — massive payload reduction ─────────────────
  await app.register(compress, { threshold: 1024 });

  // ─── Rate limiting ──────────────────────────────────────────────────────────
  console.log("[startup] Registering rate-limit...");
  await app.register(rateLimit, {
    max: 100,               // 100 requests per window per IP
    timeWindow: "1 minute",
    allowList: ["127.0.0.1", "::1"], // exempt localhost in dev
  });

  // ─── CORS — no localhost in production ──────────────────────────────────────
  const allowedOrigins: string[] = [];
  if (process.env.FRONTEND_URL) {
    allowedOrigins.push(process.env.FRONTEND_URL);
  }
  if (!IS_PRODUCTION) {
    allowedOrigins.push("http://localhost:3000");
  }
  // In production with no FRONTEND_URL, allow all origins as fallback (better than blocking everything)
  const corsOrigin = allowedOrigins.length > 0 ? allowedOrigins : true;
  console.log("[startup] Registering CORS (origins:", allowedOrigins.length > 0 ? allowedOrigins : "all", ")...");
  await app.register(cors, {
    origin: corsOrigin,
    credentials: true,
  });

  // ─── Global error handler — never leak stack traces ─────────────────────────
  app.setErrorHandler((err: Error & { statusCode?: number }, request, reply) => {
    request.log.error(err);
    const statusCode = err.statusCode || 500;
    reply.code(statusCode).send({
      error: statusCode === 429 ? "Too many requests" : "Internal server error",
      ...(statusCode === 429 && { retryAfter: err.message }),
      ...(!IS_PRODUCTION && { message: err.message }), // only show message in dev
    });
  });

  // Share db instance across routes
  const db = createDb(DATABASE_URL);
  app.decorate("db", db);

  // Initialize DB-backed services
  initWhaleTrackerDb(db);
  initOITrackerDb(db);
  initTopTraderFillsDb(db);

  // Register routes
  await app.register(traderRoutes, { prefix: "/api/traders" });
  await app.register(portfolioRoutes, { prefix: "/api/portfolio" });
  await app.register(copyRoutes, { prefix: "/api/copy" });
  await app.register(userRoutes, { prefix: "/api/users" });
  await app.register(marketRoutes, { prefix: "/api/market" });

  // Health check — only returns 200 once critical data (prices) is warm.
  // Railway keeps the old instance serving traffic until this passes.
  app.get("/api/health", async (_req, reply) => {
    const mids = await import("./services/market-data.js").then(m => m.getCachedMids()).catch(() => ({}));
    const hasPrices = Object.keys(mids).length > 10;
    if (!hasPrices) {
      reply.status(503);
      return { status: "warming", version: "2.4.0", timestamp: Date.now() };
    }
    return { status: "ok", version: "2.4.0", timestamp: Date.now() };
  });

  console.log(`[startup] Routes registered, binding to port ${PORT}...`);
  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`[startup] API server running on port ${PORT}`);

  // Start background jobs after server is listening
  setPrewarmPort(PORT);
  startBackgroundJobs();
}

main().catch(err => {
  console.error("[startup] FATAL: Server failed to start:");
  console.error(err);
  // Keep process alive for 30s so Railway logs can capture the error
  setTimeout(() => process.exit(1), 30_000);
});
