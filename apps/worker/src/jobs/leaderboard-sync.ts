/**
 * Leaderboard Sync Job
 *
 * Discovers active traders by sampling recent trades on top coins,
 * then fetches their account details and populates traderProfiles.
 *
 * Runs on worker startup and every hour thereafter.
 */

import type { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import type { Database } from "@hl-copy/db";
import { traderProfiles } from "@hl-copy/db";
import type { TraderRefreshData } from "./trader-refresh.js";

const HL_API = "https://api.hyperliquid.xyz";

async function hlPost(body: Record<string, unknown>) {
  const res = await fetch(`${HL_API}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HL API ${res.status}`);
  return res.json();
}

interface RecentTrade {
  coin: string;
  side: string;
  px: string;
  sz: string;
  users: string[];
}

/**
 * Discover active traders by collecting addresses from recent trades
 * on major coins, then filtering for accounts with significant value.
 */
async function discoverTraders(): Promise<
  { address: string; accountValue: number }[]
> {
  const coins = [
    "BTC", "ETH", "SOL", "HYPE", "ARB", "DOGE",
    "SUI", "AVAX", "LINK", "WIF", "PEPE", "ONDO",
  ];

  // Step 1: Collect unique addresses from recent trades
  const addresses = new Set<string>();
  for (const coin of coins) {
    try {
      const trades: RecentTrade[] = await hlPost({
        type: "recentTrades",
        coin,
      });
      for (const t of trades) {
        for (const u of t.users || []) {
          addresses.add(u.toLowerCase());
        }
      }
    } catch {
      // Skip coins that fail
    }
  }

  console.log(
    `[LEADERBOARD] Found ${addresses.size} unique addresses from recent trades`
  );

  // Step 2: Check account values (batch with rate limiting)
  const results: { address: string; accountValue: number }[] = [];
  const addrList = [...addresses];
  const BATCH = 10;
  const MIN_ACCOUNT_VALUE = 1000;

  for (let i = 0; i < addrList.length; i += BATCH) {
    const batch = addrList.slice(i, i + BATCH);
    const promises = batch.map(async (addr) => {
      try {
        const state = await hlPost({
          type: "clearinghouseState",
          user: addr,
        });
        const av = parseFloat(
          state?.crossMarginSummary?.accountValue || "0"
        );
        if (av >= MIN_ACCOUNT_VALUE) {
          return { address: addr, accountValue: av };
        }
      } catch {
        // Skip failed lookups
      }
      return null;
    });

    const batchResults = await Promise.all(promises);
    for (const r of batchResults) {
      if (r) results.push(r);
    }

    // Rate limit between batches
    if (i + BATCH < addrList.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  results.sort((a, b) => b.accountValue - a.accountValue);
  return results;
}

export async function runLeaderboardSync(
  db: Database,
  traderRefreshQueue: Queue<TraderRefreshData>
) {
  console.log("[LEADERBOARD] Starting trader discovery...");

  const traders = await discoverTraders();
  if (traders.length === 0) {
    console.warn("[LEADERBOARD] No traders discovered, skipping sync");
    return { synced: 0 };
  }

  console.log(
    `[LEADERBOARD] Discovered ${traders.length} traders with >$1k accounts`
  );

  let synced = 0;

  for (const trader of traders) {
    try {
      // Upsert trader profile
      const [existing] = await db
        .select({ id: traderProfiles.id })
        .from(traderProfiles)
        .where(eq(traderProfiles.address, trader.address))
        .limit(1);

      if (!existing) {
        await db.insert(traderProfiles).values({
          address: trader.address,
          accountSize: trader.accountValue.toFixed(2),
        });
      } else {
        await db
          .update(traderProfiles)
          .set({
            accountSize: trader.accountValue.toFixed(2),
            updatedAt: new Date(),
          })
          .where(eq(traderProfiles.address, trader.address));
      }

      // Enqueue full refresh for detailed stats + scoring
      await traderRefreshQueue.add(
        "trader-refresh",
        { traderAddress: trader.address, fullRefresh: true },
        { jobId: `leaderboard-${trader.address}`, attempts: 2 }
      );

      synced++;
    } catch (err) {
      console.error(
        `[LEADERBOARD] Failed to sync ${trader.address}:`,
        err
      );
    }
  }

  console.log(`[LEADERBOARD] Sync complete. Synced ${synced} traders.`);
  return { synced };
}
