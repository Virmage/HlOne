/**
 * Copy Trading Worker
 *
 * Long-running process that:
 * 1. Connects to Hyperliquid WebSocket
 * 2. Subscribes to fills for all actively copied traders
 * 3. On fill event → enqueues trade execution job
 * 4. BullMQ workers process jobs: calculate size → submit order → update DB
 * 5. Periodic jobs: position sync (30s), trader refresh (15m)
 * 6. Health monitoring on :3002
 *
 * Deploy this to Fly.io Tokyo for lowest latency to Hyperliquid validators.
 */

import Redis from "ioredis";
import { eq, and } from "drizzle-orm";
import { createDb } from "@hl-copy/db";
import { copyRelationships, traderProfiles } from "@hl-copy/db";
import { WsManager } from "./services/ws-manager.js";
import {
  createTradeQueue,
  createTradeWorker,
  type TradeJobData,
} from "./jobs/trade-execution.js";
import {
  createPositionSyncQueue,
  createPositionSyncWorker,
} from "./jobs/position-sync.js";
import {
  createTraderRefreshQueue,
  createTraderRefreshWorker,
} from "./jobs/trader-refresh.js";
import { HealthMonitor } from "./monitoring/health.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://localhost:5432/hl_copy";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || "3002");
const POSITION_SYNC_INTERVAL = 30_000;
const TRADER_REFRESH_INTERVAL = 900_000;
const SUBSCRIPTION_REFRESH_INTERVAL = 60_000;

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("[WORKER] Starting copy trading worker...");

  const db = createDb(DATABASE_URL);

  // Use REDIS_URL string for BullMQ to avoid ioredis version mismatch
  const redisConnection = { url: REDIS_URL } as unknown as Redis;

  // Separate ioredis instance for non-BullMQ operations
  const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
  });
  redis.on("error", (err) => console.error("[REDIS] Error:", err.message));
  redis.on("connect", () => console.log("[REDIS] Connected"));

  const wsManager = new WsManager();

  // Initialize job queues (pass redis connection for BullMQ)
  const tradeQueue = createTradeQueue(redis as never);
  const positionSyncQueue = createPositionSyncQueue(redis as never);
  const traderRefreshQueue = createTraderRefreshQueue(redis as never);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const queueMap = new Map<string, any>([
    ["trade-execution", tradeQueue],
    ["position-sync", positionSyncQueue],
    ["trader-refresh", traderRefreshQueue],
  ]);

  const healthMonitor = new HealthMonitor(wsManager, queueMap);

  healthMonitor.onAlert((alert) => {
    console.warn(`[ALERT] ${alert}`);
  });

  // Initialize workers
  const tradeWorker = createTradeWorker(redis as never, db);
  const positionSyncWorker = createPositionSyncWorker(redis as never, db);
  const traderRefreshWorker = createTraderRefreshWorker(redis as never, db);

  // ─── WebSocket fill handler ──────────────────────────────────────────

  wsManager.on(
    "fill",
    async ({
      traderAddress,
      fill,
    }: {
      traderAddress: string;
      fill: TradeJobData["fill"];
    }) => {
      console.log(
        `[WS] Fill: ${fill.coin} ${fill.dir} ${fill.sz} @ ${fill.px} from ${traderAddress.slice(0, 10)}...`
      );
      healthMonitor.recordFill();

      const isClose = fill.dir.startsWith("Close");
      await tradeQueue.add(
        "copy-trade",
        { traderAddress, fill } satisfies TradeJobData,
        { priority: isClose ? 1 : 5 }
      );
    }
  );

  wsManager.on("error", (err: Error) => {
    healthMonitor.recordError(`WebSocket error: ${err.message}`);
  });

  // ─── Subscribe to all active traders ─────────────────────────────────

  async function refreshSubscriptions() {
    const activeRelationships = await db
      .select({ traderAddress: traderProfiles.address })
      .from(copyRelationships)
      .innerJoin(
        traderProfiles,
        eq(copyRelationships.traderProfileId, traderProfiles.id)
      )
      .where(
        and(
          eq(copyRelationships.isActive, true),
          eq(copyRelationships.isPaused, false)
        )
      );

    const activeAddresses = new Set(
      activeRelationships.map((r) => r.traderAddress)
    );
    const currentAddresses = new Set(wsManager.getSubscribedAddresses());

    for (const addr of activeAddresses) {
      if (!currentAddresses.has(addr)) wsManager.subscribe(addr);
    }
    for (const addr of currentAddresses) {
      if (!activeAddresses.has(addr)) wsManager.unsubscribe(addr);
    }

    console.log(
      `[SUB] Active subscriptions: ${wsManager.getSubscriptionCount()}`
    );
  }

  // ─── Periodic jobs ───────────────────────────────────────────────────

  async function schedulePositionSync() {
    const addresses = wsManager.getSubscribedAddresses();
    for (const addr of addresses) {
      await positionSyncQueue.add(
        "position-sync",
        { traderAddress: addr },
        { jobId: `sync-${addr}` }
      );
    }
  }

  async function scheduleTraderRefresh() {
    const addresses = wsManager.getSubscribedAddresses();
    for (const addr of addresses) {
      await traderRefreshQueue.add(
        "trader-refresh",
        { traderAddress: addr, fullRefresh: true },
        { jobId: `refresh-${addr}` }
      );
    }
  }

  // ─── Start everything ────────────────────────────────────────────────

  try {
    await wsManager.connect();
    await refreshSubscriptions();
    healthMonitor.startServer(HEALTH_PORT);

    const subInterval = setInterval(
      refreshSubscriptions,
      SUBSCRIPTION_REFRESH_INTERVAL
    );
    const syncInterval = setInterval(
      schedulePositionSync,
      POSITION_SYNC_INTERVAL
    );
    const refreshInterval = setInterval(
      scheduleTraderRefresh,
      TRADER_REFRESH_INTERVAL
    );

    await schedulePositionSync();
    console.log("[WORKER] Fully started. Listening for fills...");

    // ─── Graceful shutdown ──────────────────────────────────────────────

    const shutdown = async (signal: string) => {
      console.log(`\n[WORKER] Received ${signal}, shutting down gracefully...`);

      clearInterval(subInterval);
      clearInterval(syncInterval);
      clearInterval(refreshInterval);

      await tradeWorker.close();
      await positionSyncWorker.close();
      await traderRefreshWorker.close();
      console.log("[WORKER] Workers closed");

      await tradeQueue.close();
      await positionSyncQueue.close();
      await traderRefreshQueue.close();
      console.log("[WORKER] Queues closed");

      await wsManager.shutdown();
      healthMonitor.stop();
      redis.disconnect();

      console.log("[WORKER] Shutdown complete");
      process.exit(0);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    await new Promise(() => {});
  } catch (err) {
    console.error("[WORKER] Fatal error:", err);
    process.exit(1);
  }
}

main();
