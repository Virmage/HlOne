/**
 * Trader Refresh Job
 *
 * Periodically refreshes trader profiles:
 * - Fetches portfolio performance from Hyperliquid
 * - Updates PnL, ROI, win rate, trade count
 * - Takes equity curve snapshots
 * - Recomputes ranking scores
 *
 * Runs every 15 minutes for active traders.
 */

import { Queue, Worker, type Job } from "bullmq";
type RedisConnection = any;
import { eq } from "drizzle-orm";
import type { Database } from "@hl-copy/db";
import {
  traderProfiles,
  traderSnapshots,
  traderScores,
} from "@hl-copy/db";

const QUEUE_NAME = "trader-refresh";

export interface TraderRefreshData {
  traderAddress: string;
  fullRefresh?: boolean; // includes score recomputation
}

export function createTraderRefreshQueue(redis: RedisConnection) {
  return new Queue<TraderRefreshData>(QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "fixed", delay: 10000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
    },
  });
}

export function createTraderRefreshWorker(redis: RedisConnection, db: Database) {
  const worker = new Worker<TraderRefreshData>(
    QUEUE_NAME,
    async (job: Job<TraderRefreshData>) => {
      const { traderAddress, fullRefresh } = job.data;
      const addr = traderAddress.toLowerCase();

      // Get or create profile
      let [profile] = await db
        .select()
        .from(traderProfiles)
        .where(eq(traderProfiles.address, addr))
        .limit(1);

      if (!profile) {
        [profile] = await db
          .insert(traderProfiles)
          .values({ address: addr })
          .returning();
      }

      // Fetch clearinghouse state
      const stateRes = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "clearinghouseState", user: traderAddress }),
      });
      const state = await stateRes.json();

      // Fetch fills for win rate / trade count
      const fillsRes = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "userFills", user: traderAddress }),
      });
      const fills = await fillsRes.json();

      // Calculate stats
      const accountValue = parseFloat(
        state?.crossMarginSummary?.accountValue || "0"
      );

      let totalPnl = 0;
      let wins = 0;
      let trades = 0;
      let maxLeverage = 0;

      if (Array.isArray(fills)) {
        for (const fill of fills) {
          const closedPnl = parseFloat(fill.closedPnl || "0");
          if (closedPnl !== 0) {
            totalPnl += closedPnl;
            trades++;
            if (closedPnl > 0) wins++;
          }
        }
      }

      // Get max leverage from current positions
      if (state?.assetPositions) {
        for (const pos of state.assetPositions) {
          const lev = pos.position?.leverage?.value || 0;
          if (lev > maxLeverage) maxLeverage = lev;
        }
      }

      const winRate = trades > 0 ? wins / trades : 0;
      const roiPercent = accountValue > 0 ? (totalPnl / accountValue) * 100 : 0;

      // Get drawdown from portfolio endpoint
      let drawdownPercent = 0;
      try {
        const portfolioRes = await fetch("https://api.hyperliquid.xyz/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "portfolio", user: traderAddress }),
        });
        const portfolio = await portfolioRes.json();
        // Calculate drawdown from account value history if available
        if (portfolio?.accountValueHistory) {
          const values = portfolio.accountValueHistory.map(
            (v: [number, string]) => parseFloat(v[1])
          );
          let peak = 0;
          let maxDrawdown = 0;
          for (const v of values) {
            if (v > peak) peak = v;
            const dd = peak > 0 ? ((peak - v) / peak) * 100 : 0;
            if (dd > maxDrawdown) maxDrawdown = dd;
          }
          drawdownPercent = maxDrawdown;
        }
      } catch {
        // Portfolio endpoint may not be available for all users
      }

      // Update profile
      await db
        .update(traderProfiles)
        .set({
          accountSize: accountValue.toFixed(2),
          totalPnl: totalPnl.toFixed(2),
          roiPercent,
          winRate,
          tradeCount: trades,
          maxLeverage,
          lastActiveAt: fills?.length > 0 ? new Date(fills[0].time) : undefined,
          updatedAt: new Date(),
        })
        .where(eq(traderProfiles.id, profile.id));

      // Save snapshot
      await db.insert(traderSnapshots).values({
        traderProfileId: profile.id,
        accountValue: accountValue.toFixed(2),
        totalPnl: totalPnl.toFixed(2),
        roiPercent,
        drawdownPercent,
        openPositions: state?.assetPositions || [],
      });

      // Recompute score if full refresh
      if (fullRefresh) {
        // Simple scoring — in production, use the full ranking engine
        // across all traders at once for proper normalization
        const riskAdjustedReturn = roiPercent > 0 ? Math.min(roiPercent / 100, 1) : 0;
        const absolutePnlScore = Math.min(Math.max(totalPnl / 100000, 0), 1);
        const roiScore = Math.min(Math.max(roiPercent / 200, 0), 1);
        const consistencyScore = winRate;
        const drawdownPenalty = 1 - Math.min(drawdownPercent / 50, 1);
        const daysSinceActive = profile.lastActiveAt
          ? (Date.now() - profile.lastActiveAt.getTime()) / (1000 * 60 * 60 * 24)
          : 30;
        const recencyScore = Math.max(0, 1 - daysSinceActive / 30);

        const compositeScore =
          0.3 * riskAdjustedReturn +
          0.2 * absolutePnlScore +
          0.15 * roiScore +
          0.15 * consistencyScore +
          0.1 * drawdownPenalty +
          0.1 * recencyScore;

        await db
          .insert(traderScores)
          .values({
            traderProfileId: profile.id,
            riskAdjustedReturn,
            absolutePnlScore,
            roiScore,
            consistencyScore,
            drawdownPenalty,
            recencyScore,
            compositeScore,
          })
          .onConflictDoUpdate({
            target: traderScores.traderProfileId,
            set: {
              riskAdjustedReturn,
              absolutePnlScore,
              roiScore,
              consistencyScore,
              drawdownPenalty,
              recencyScore,
              compositeScore,
              computedAt: new Date(),
            },
          });
      }

      return {
        address: traderAddress,
        accountValue,
        totalPnl,
        trades,
        winRate,
      };
    },
    {
      connection: redis,
      concurrency: 5,
      limiter: {
        max: 20,       // Max 20 refreshes
        duration: 60000, // per minute (stay within HL rate limits)
      },
    }
  );

  return worker;
}
