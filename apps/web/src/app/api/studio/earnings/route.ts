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
        const stats = await fetchHLBuilderStats(b.wallet, b.deployId);
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

// ─── Stubs ──────────────────────────────────────────────────────────────────

async function lookupBuildsByWallet(wallet: string): Promise<Array<{
  deployId: string;
  wallet: string;
  slug: string;
  name: string;
  deployUrl: string;
  markupBps: number;
  createdAt: string;
}>> {
  // Dev stub — returns one mock build
  if (process.env.NODE_ENV !== "production") {
    return [
      {
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
  return [];
  // Real impl:
  // return await db.query("SELECT ... FROM studio_builds WHERE wallet = $1 ORDER BY created_at DESC", [wallet]);
}

async function fetchHLBuilderStats(
  _builderWallet: string,
  _deployId: string
): Promise<{
  volumeUsd: number;
  feesEarnedUsd: number;
  trades: number;
  uniqueUsers: number;
  last24h: { volumeUsd: number; trades: number };
  last7d: { volumeUsd: number; trades: number };
}> {
  // Dev stub — returns mock data
  if (process.env.NODE_ENV !== "production") {
    return {
      volumeUsd: Math.random() * 250_000,
      feesEarnedUsd: Math.random() * 25,
      trades: Math.floor(Math.random() * 500),
      uniqueUsers: Math.floor(Math.random() * 80),
      last24h: { volumeUsd: Math.random() * 40_000, trades: Math.floor(Math.random() * 80) },
      last7d: { volumeUsd: Math.random() * 180_000, trades: Math.floor(Math.random() * 350) },
    };
  }
  // Real impl: query HL info API for user's fills where builder = HLONE_BUILDER_WALLET
  // and filter by originating deploy (tracked via our own usage events DB)
  return {
    volumeUsd: 0, feesEarnedUsd: 0, trades: 0, uniqueUsers: 0,
    last24h: { volumeUsd: 0, trades: 0 }, last7d: { volumeUsd: 0, trades: 0 },
  };
}
