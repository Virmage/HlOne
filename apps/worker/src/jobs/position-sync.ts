/**
 * Position Sync Job
 *
 * Periodically syncs source trader positions and updates
 * current prices on copied positions. Runs every 30 seconds.
 */

import { Queue, Worker, type Job } from "bullmq";
type RedisConnection = any;
import { eq, and } from "drizzle-orm";
import type { Database } from "@hl-copy/db";
import {
  traderProfiles,
  sourcePositions,
  copiedPositions,
  copyRelationships,
} from "@hl-copy/db";

const QUEUE_NAME = "position-sync";

export interface PositionSyncData {
  traderAddress: string;
}

export function createPositionSyncQueue(redis: RedisConnection) {
  return new Queue<PositionSyncData>(QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "fixed", delay: 5000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    },
  });
}

export function createPositionSyncWorker(redis: RedisConnection, db: Database) {
  const worker = new Worker<PositionSyncData>(
    QUEUE_NAME,
    async (job: Job<PositionSyncData>) => {
      const { traderAddress } = job.data;

      // Fetch live positions from Hyperliquid
      const res = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "clearinghouseState",
          user: traderAddress,
        }),
      });
      const state = await res.json();

      if (!state?.assetPositions) return { synced: 0 };

      const [trader] = await db
        .select()
        .from(traderProfiles)
        .where(eq(traderProfiles.address, traderAddress.toLowerCase()))
        .limit(1);

      if (!trader) return { synced: 0 };

      // Update source positions
      const livePositions = state.assetPositions
        .filter((p: { position: { szi: string } }) => parseFloat(p.position.szi) !== 0)
        .map((p: { position: Record<string, unknown> }) => p.position);

      for (const pos of livePositions) {
        const szi = parseFloat(pos.szi as string);
        const side = szi > 0 ? "long" : "short";
        const size = Math.abs(szi).toString();

        await db
          .insert(sourcePositions)
          .values({
            traderProfileId: trader.id,
            asset: pos.coin as string,
            side,
            size,
            entryPrice: pos.entryPx as string,
            leverage: (pos.leverage as { value: number })?.value,
            unrealizedPnl: pos.unrealizedPnl as string,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [sourcePositions.traderProfileId, sourcePositions.asset],
            set: {
              side,
              size,
              entryPrice: pos.entryPx as string,
              leverage: (pos.leverage as { value: number })?.value,
              unrealizedPnl: pos.unrealizedPnl as string,
              updatedAt: new Date(),
            },
          });
      }

      // Remove closed positions
      const liveAssets = new Set(livePositions.map((p: Record<string, unknown>) => p.coin));
      const existingPositions = await db
        .select()
        .from(sourcePositions)
        .where(eq(sourcePositions.traderProfileId, trader.id));

      for (const existing of existingPositions) {
        if (!liveAssets.has(existing.asset)) {
          await db
            .delete(sourcePositions)
            .where(eq(sourcePositions.id, existing.id));
        }
      }

      // Update current prices on copied positions
      const allMidsRes = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "allMids" }),
      });
      const mids = await allMidsRes.json();

      // Get all copy relationships for this trader
      const rels = await db
        .select({ id: copyRelationships.id })
        .from(copyRelationships)
        .where(
          and(
            eq(copyRelationships.traderProfileId, trader.id),
            eq(copyRelationships.isActive, true)
          )
        );

      for (const rel of rels) {
        const openPositions = await db
          .select()
          .from(copiedPositions)
          .where(
            and(
              eq(copiedPositions.copyRelationshipId, rel.id),
              eq(copiedPositions.isOpen, true)
            )
          );

        for (const pos of openPositions) {
          const currentPrice = mids[pos.asset];
          if (currentPrice) {
            const entry = parseFloat(pos.entryPrice);
            const current = parseFloat(currentPrice);
            const size = parseFloat(pos.size);
            const pnl =
              pos.side === "long"
                ? (current - entry) * size
                : (entry - current) * size;

            await db
              .update(copiedPositions)
              .set({
                currentPrice: currentPrice.toString(),
                unrealizedPnl: pnl.toFixed(2),
              })
              .where(eq(copiedPositions.id, pos.id));
          }
        }
      }

      // Update trader profile account size
      if (state.crossMarginSummary) {
        await db
          .update(traderProfiles)
          .set({
            accountSize: state.crossMarginSummary.accountValue,
            updatedAt: new Date(),
          })
          .where(eq(traderProfiles.id, trader.id));
      }

      return { synced: livePositions.length };
    },
    {
      connection: redis,
      concurrency: 3,
    }
  );

  return worker;
}
