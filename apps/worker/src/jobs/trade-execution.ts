/**
 * Trade Execution Job
 *
 * BullMQ worker that processes copy trade orders.
 * Flow: Fill event → calculate size → submit order → update DB
 *
 * Uses BullMQ features:
 * - Priority queue (higher priority for close orders)
 * - Retry with exponential backoff
 * - Dead letter queue for failed orders
 * - Rate limiting to stay within Hyperliquid API limits
 */

import { Queue, Worker, type Job } from "bullmq";
type RedisConnection = any;
import { eq, and } from "drizzle-orm";
import type { Database } from "@hl-copy/db";
import {
  copyRelationships,
  copyAllocations,
  copiedPositions,
  executions,
  apiWallets,
  traderProfiles,
  users,
  decryptPrivateKey,
  isEncrypted,
} from "@hl-copy/db";
import { submitMarketOrder, submitCloseOrder } from "../services/order-execution.js";
import {
  calculateFollowerOrder,
  isSkipped,
  type FillEvent,
} from "../services/position-calculator.js";
import type { Hex } from "viem";

export interface TradeJobData {
  traderAddress: string;
  fill: FillEvent;
}

const QUEUE_NAME = "trade-execution";

export function createTradeQueue(redis: RedisConnection) {
  return new Queue<TradeJobData>(QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 1000,
      },
      removeOnComplete: {
        count: 1000, // Keep last 1000 completed
        age: 86400,  // or 24 hours
      },
      removeOnFail: {
        count: 5000, // Keep more failed for debugging
      },
    },
  });
}

export function createTradeWorker(redis: RedisConnection, db: Database) {
  const worker = new Worker<TradeJobData>(
    QUEUE_NAME,
    async (job: Job<TradeJobData>) => {
      const { traderAddress, fill } = job.data;
      const startTime = Date.now();

      console.log(
        `[TRADE] Processing fill: ${fill.coin} ${fill.dir} ${fill.sz} @ ${fill.px} from ${traderAddress.slice(0, 10)}...`
      );

      // Find all active copy relationships for this trader
      const [trader] = await db
        .select()
        .from(traderProfiles)
        .where(eq(traderProfiles.address, traderAddress.toLowerCase()))
        .limit(1);

      if (!trader) {
        console.log(`[TRADE] No trader profile for ${traderAddress}, skipping`);
        return { status: "skipped", reason: "No trader profile" };
      }

      const relationships = await db
        .select({
          relId: copyRelationships.id,
          userId: copyRelationships.userId,
          allocatedCapital: copyAllocations.allocatedCapital,
          maxLeverage: copyAllocations.maxLeverage,
          maxPositionSizePercent: copyAllocations.maxPositionSizePercent,
          minOrderSize: copyAllocations.minOrderSize,
        })
        .from(copyRelationships)
        .innerJoin(
          copyAllocations,
          eq(copyRelationships.id, copyAllocations.copyRelationshipId)
        )
        .where(
          and(
            eq(copyRelationships.traderProfileId, trader.id),
            eq(copyRelationships.isActive, true),
            eq(copyRelationships.isPaused, false)
          )
        );

      if (relationships.length === 0) {
        return { status: "skipped", reason: "No active copy relationships" };
      }

      const results = [];

      for (const rel of relationships) {
        // Get user's API wallet
        const [apiWallet] = await db
          .select()
          .from(apiWallets)
          .where(
            and(
              eq(apiWallets.userId, rel.userId),
              eq(apiWallets.isActive, true)
            )
          )
          .limit(1);

        if (!apiWallet) {
          await logExecution(db, rel.relId, traderAddress, fill, {
            status: "skipped",
            skipReason: "No active API wallet",
          });
          results.push({ relId: rel.relId, status: "skipped", reason: "No API wallet" });
          continue;
        }

        // Get user's wallet address for margin check
        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.id, rel.userId))
          .limit(1);

        if (!user) continue;

        // Get available margin from Hyperliquid
        let availableMargin = 0;
        try {
          const res = await fetch("https://api.hyperliquid.xyz/info", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: "clearinghouseState",
              user: user.walletAddress,
            }),
          });
          const state = await res.json();
          availableMargin = parseFloat(state?.withdrawable || "0");
        } catch {
          // If we can't check margin, use a conservative estimate
          availableMargin = parseFloat(rel.allocatedCapital || "0") * 0.5;
        }

        // Calculate follower order
        const sourceAccountSize = parseFloat(trader.accountSize || "10000");
        const calculation = calculateFollowerOrder(
          fill,
          {
            allocatedCapital: parseFloat(rel.allocatedCapital || "0"),
            maxLeverage: rel.maxLeverage || 10,
            maxPositionSizePercent: rel.maxPositionSizePercent || 25,
            minOrderSize: parseFloat(rel.minOrderSize || "10"),
          },
          sourceAccountSize,
          availableMargin
        );

        if (isSkipped(calculation)) {
          await logExecution(db, rel.relId, traderAddress, fill, {
            status: "skipped",
            skipReason: calculation.reason,
          });
          results.push({ relId: rel.relId, status: "skipped", reason: calculation.reason });
          continue;
        }

        // Decrypt agent wallet private key (supports both encrypted and legacy raw hex)
        const rawKey = apiWallet.encryptedPrivateKey;
        const agentKey = (isEncrypted(rawKey) ? decryptPrivateKey(rawKey) : rawKey) as Hex;

        // Execute the order
        let orderResult;
        if (calculation.reduceOnly) {
          orderResult = await submitCloseOrder(
            agentKey,
            user.walletAddress,
            calculation.asset,
            calculation.isBuy ? "short" : "long",
            calculation.size
          );
        } else {
          orderResult = await submitMarketOrder(
            agentKey,
            user.walletAddress,
            calculation.asset,
            calculation.isBuy,
            calculation.size
          );
        }

        // Log execution
        await logExecution(db, rel.relId, traderAddress, fill, {
          status: orderResult.success ? "filled" : "failed",
          executedSize: calculation.size.toString(),
          executedPrice: fill.px,
          hyperliquidOrderId: orderResult.orderId,
          skipReason: orderResult.error,
          latencyMs: orderResult.latencyMs,
        });

        // Update copied position in DB
        if (orderResult.success) {
          if (calculation.reduceOnly) {
            // Close position
            await db
              .update(copiedPositions)
              .set({
                isOpen: false,
                closedAt: new Date(),
                realizedPnl: fill.closedPnl,
              })
              .where(
                and(
                  eq(copiedPositions.copyRelationshipId, rel.relId),
                  eq(copiedPositions.asset, calculation.asset),
                  eq(copiedPositions.isOpen, true)
                )
              );
          } else {
            // Open or add to position
            await db.insert(copiedPositions).values({
              copyRelationshipId: rel.relId,
              asset: calculation.asset,
              side: calculation.isBuy ? "long" : "short",
              size: calculation.size.toString(),
              entryPrice: fill.px,
              currentPrice: fill.px,
            });
          }
        }

        results.push({
          relId: rel.relId,
          status: orderResult.success ? "filled" : "failed",
          latencyMs: orderResult.latencyMs,
        });
      }

      const totalLatency = Date.now() - startTime;
      console.log(
        `[TRADE] Processed ${results.length} relationships in ${totalLatency}ms`
      );

      return { results, totalLatencyMs: totalLatency };
    },
    {
      connection: redis,
      concurrency: 5, // Process up to 5 trades in parallel
      limiter: {
        max: 10,       // Max 10 jobs
        duration: 1000, // per 1 second (stay well within HL rate limits)
      },
    }
  );

  worker.on("completed", (job) => {
    if (job) {
      console.log(`[TRADE] Job ${job.id} completed`);
    }
  });

  worker.on("failed", (job, err) => {
    console.error(`[TRADE] Job ${job?.id} failed:`, err.message);
  });

  worker.on("error", (err) => {
    console.error("[TRADE] Worker error:", err);
  });

  return worker;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function logExecution(
  db: Database,
  copyRelationshipId: string,
  sourceTraderAddress: string,
  fill: FillEvent,
  result: {
    status: string;
    executedSize?: string;
    executedPrice?: string;
    hyperliquidOrderId?: string;
    skipReason?: string;
    latencyMs?: number;
  }
) {
  await db.insert(executions).values({
    copyRelationshipId,
    sourceTraderAddress,
    asset: fill.coin,
    side: fill.side === "B" ? "buy" : "sell",
    direction: fill.dir,
    sourceSize: fill.sz,
    sourcePrice: fill.px,
    executedSize: result.executedSize,
    executedPrice: result.executedPrice,
    status: result.status,
    skipReason: result.skipReason,
    hyperliquidOrderId: result.hyperliquidOrderId,
    latencyMs: result.latencyMs,
    executedAt: result.status === "filled" ? new Date() : undefined,
  });
}
