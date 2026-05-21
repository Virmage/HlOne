/**
 * Position Sync Job
 *
 * Periodically syncs source trader positions and updates
 * current prices on copied positions. Runs every 30 seconds.
 */

import { Queue, Worker, type Job } from "bullmq";
type RedisConnection = any;
import { eq, and, inArray, sql } from "drizzle-orm";
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

      // Project to id only — the rest of the trader row (account size,
      // hyperliquid handles, etc.) isn't used here. Cuts ~80% of the
      // bytes-on-wire vs the old SELECT *.
      const [trader] = await db
        .select({ id: traderProfiles.id })
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

      // Remove closed positions. Project to id + asset only (asset is
      // needed for the liveAssets diff; the rest of the row isn't).
      const liveAssets = new Set(livePositions.map((p: Record<string, unknown>) => p.coin));
      const existingPositions = await db
        .select({ id: sourcePositions.id, asset: sourcePositions.asset })
        .from(sourcePositions)
        .where(eq(sourcePositions.traderProfileId, trader.id));

      const idsToDelete = existingPositions
        .filter((existing: { asset: string }) => !liveAssets.has(existing.asset))
        .map((existing: { id: string }) => existing.id);
      if (idsToDelete.length > 0) {
        // One DELETE round-trip instead of N. Same end state.
        await db
          .delete(sourcePositions)
          .where(inArray(sourcePositions.id, idsToDelete));
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

      // Fetch ALL open copied positions across every relationship in
      // ONE query (was: per-rel SELECT loop = N round-trips). Project
      // to only the columns we touch — id, asset, side, size,
      // entryPrice — instead of pulling every column.
      type CopiedPosSlim = {
        id: string;
        asset: string;
        side: string;
        size: string;
        entryPrice: string;
      };
      let openPositions: CopiedPosSlim[] = [];
      if (rels.length > 0) {
        openPositions = await db
          .select({
            id: copiedPositions.id,
            asset: copiedPositions.asset,
            side: copiedPositions.side,
            size: copiedPositions.size,
            entryPrice: copiedPositions.entryPrice,
          })
          .from(copiedPositions)
          .where(
            and(
              inArray(
                copiedPositions.copyRelationshipId,
                rels.map((r: { id: string }) => r.id),
              ),
              eq(copiedPositions.isOpen, true)
            )
          );
      }

      // Compute new price + PnL for every open position in JS, then
      // bulk-UPDATE all of them in ONE SQL statement (`UPDATE ... FROM
      // (VALUES ...)`). Old code did one round-trip per position every
      // 30s — on Neon both directions are metered, so a trader with
      // 10 open positions × 2,880 cycles/day = 28k UPDATE round trips
      // per day.
      const updates: Array<{ id: string; currentPrice: string; unrealizedPnl: string }> = [];
      for (const pos of openPositions) {
        const currentPriceRaw = mids[pos.asset];
        if (!currentPriceRaw) continue;
        const entry = parseFloat(pos.entryPrice);
        const current = parseFloat(currentPriceRaw);
        const size = parseFloat(pos.size);
        const pnl =
          pos.side === "long"
            ? (current - entry) * size
            : (entry - current) * size;
        updates.push({
          id: pos.id,
          currentPrice: currentPriceRaw.toString(),
          unrealizedPnl: pnl.toFixed(2),
        });
      }
      if (updates.length > 0) {
        // Bulk UPDATE FROM VALUES. Single round-trip regardless of N.
        const valuesSql = sql.join(
          updates.map(
            (u) =>
              sql`(${u.id}::uuid, ${u.currentPrice}::numeric, ${u.unrealizedPnl}::numeric)`,
          ),
          sql`, `,
        );
        await db.execute(sql`
          UPDATE copied_positions AS cp
          SET current_price = v.current_price,
              unrealized_pnl = v.unrealized_pnl
          FROM (VALUES ${valuesSql}) AS v(id, current_price, unrealized_pnl)
          WHERE cp.id = v.id
        `);
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
