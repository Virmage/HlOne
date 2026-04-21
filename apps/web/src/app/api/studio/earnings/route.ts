/**
 * GET /api/studio/earnings?wallet=0x...
 *
 * Returns the builder's earnings summary across all their deployed builds.
 * Pulls volume + fees from HyperLiquid's builder code data + our own tracking.
 *
 * Env vars needed:
 *   DATABASE_URL              - Postgres for build records
 *   HL_ADMIN_API_KEY          - (optional) for richer builder stats from HL
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const wallet = url.searchParams.get("wallet");

    if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      return NextResponse.json({ error: "Invalid wallet" }, { status: 400 });
    }

    // TODO: look up real builds from DB
    const builds = await lookupBuildsByWallet(wallet);

    // TODO: pull live volume + fee data from HL's builder code API for each build's wallet
    const enriched = await Promise.all(
      builds.map(async (b) => {
        const stats = await fetchHLBuilderStats(b.wallet, b.buildId);
        return {
          deployId: b.deployId,
          slug: b.slug,
          name: b.name,
          deployUrl: b.deployUrl,
          markupBps: b.markupBps,
          createdAt: b.createdAt,
          stats,
        };
      })
    );

    const totals = enriched.reduce(
      (acc, b) => {
        acc.totalVolumeUsd += b.stats.volumeUsd;
        acc.totalFeesEarnedUsd += b.stats.feesEarnedUsd;
        acc.totalTrades += b.stats.trades;
        acc.totalUsers += b.stats.uniqueUsers;
        return acc;
      },
      { totalVolumeUsd: 0, totalFeesEarnedUsd: 0, totalTrades: 0, totalUsers: 0 }
    );

    return NextResponse.json({ builds: enriched, totals });
  } catch (err) {
    console.error("[studio/earnings] Error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// ─── Persistence + HL fills (Prisma + HL info API) ──────────────────────────

async function lookupBuildsByWallet(wallet: string): Promise<Array<{
  buildId: string;
  deployId: string;
  wallet: string;
  slug: string;
  name: string;
  deployUrl: string;
  markupBps: number;
  createdAt: string;
}>> {
  if (!prisma) {
    // Dev mode (no DB): return a single mock build for UI preview in development
    // only. In production, no-DB = empty list (don't fake earnings data).
    if (process.env.NODE_ENV === "production") return [];
    return [
      {
        buildId: "dev_stub_1",
        deployId: "dev_stub_1",
        wallet,
        slug: "my-whale-hunter",
        name: "My Whale Hunter",
        deployUrl: "https://my-whale-hunter.hlone.build",
        markupBps: 15,
        createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ];
  }
  const builds = await prisma.studioBuild.findMany({
    where: { ownerWallet: wallet.toLowerCase(), status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, deployId: true, ownerWallet: true, slug: true, name: true,
      deployUrl: true, markupBps: true, createdAt: true,
    },
  });
  return builds.map(b => ({
    buildId: b.id,
    deployId: b.deployId,
    wallet: b.ownerWallet,
    slug: b.slug,
    name: b.name,
    deployUrl: b.deployUrl ?? "",
    markupBps: b.markupBps,
    createdAt: b.createdAt.toISOString(),
  }));
}

/**
 * Fetch HL fills where builder = HLONE_BUILDER_WALLET, aggregate stats by
 * originating deploy via our API usage events table.
 *
 * Note: HL's info API doesn't expose a "builder code earnings" query directly.
 * We'd need to query the builder wallet's fills OR use our own usage events
 * as a proxy. For MVP this returns 0s when no usage events exist.
 */
async function fetchHLBuilderStats(
  _builderWallet: string,
  buildId: string,
): Promise<{
  volumeUsd: number;
  feesEarnedUsd: number;
  trades: number;
  uniqueUsers: number;
  last24h: { volumeUsd: number; trades: number };
  last7d: { volumeUsd: number; trades: number };
}> {
  if (!prisma || buildId === "dev_stub_1") {
    // Dev-only mock data. Production without DB returns zeros (never fake earnings).
    if (process.env.NODE_ENV === "production") {
      return {
        volumeUsd: 0, feesEarnedUsd: 0, trades: 0, uniqueUsers: 0,
        last24h: { volumeUsd: 0, trades: 0 }, last7d: { volumeUsd: 0, trades: 0 },
      };
    }
    return {
      volumeUsd: Math.random() * 250_000,
      feesEarnedUsd: Math.random() * 25,
      trades: Math.floor(Math.random() * 500),
      uniqueUsers: Math.floor(Math.random() * 80),
      last24h: { volumeUsd: Math.random() * 40_000, trades: Math.floor(Math.random() * 80) },
      last7d: { volumeUsd: Math.random() * 180_000, trades: Math.floor(Math.random() * 350) },
    };
  }

  try {
    const now = Date.now();
    const [total, h24, d7, uniqueUsers] = await Promise.all([
      prisma.apiUsageEvent.count({ where: { buildId } }),
      prisma.apiUsageEvent.count({ where: { buildId, createdAt: { gte: new Date(now - 24 * 60 * 60 * 1000) } } }),
      prisma.apiUsageEvent.count({ where: { buildId, createdAt: { gte: new Date(now - 7 * 24 * 60 * 60 * 1000) } } }),
      prisma.apiUsageEvent.groupBy({
        by: ["userWallet"],
        where: { buildId, userWallet: { not: null } },
      }),
    ]);
    // Trades ≈ usage events (each order validates). Volume + fees aren't in our
    // DB — derived via a backfill job that queries HL fills. Returning 0 for
    // those until that job is built.
    return {
      volumeUsd: 0,
      feesEarnedUsd: 0,
      trades: total,
      uniqueUsers: uniqueUsers.length,
      last24h: { volumeUsd: 0, trades: h24 },
      last7d: { volumeUsd: 0, trades: d7 },
    };
  } catch (err) {
    console.warn("[earnings] stats query failed:", (err as Error).message);
    return {
      volumeUsd: 0, feesEarnedUsd: 0, trades: 0, uniqueUsers: 0,
      last24h: { volumeUsd: 0, trades: 0 }, last7d: { volumeUsd: 0, trades: 0 },
    };
  }
}
