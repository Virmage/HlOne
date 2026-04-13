/**
 * Hyperliquid Ecosystem Dashboard — platform-level metrics.
 * All data from free Hyperliquid APIs, no key needed.
 * Provides: vault TVL, platform OI, volume, active traders, HYPE staking.
 */

const HL_API = "https://api.hyperliquid.xyz";
const STATS_API = "https://stats-data.hyperliquid.xyz/Mainnet";

async function infoRequest(body: Record<string, unknown>) {
  const res = await fetch(`${HL_API}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HL API error: ${res.status}`);
  return res.json();
}

/* ── Types ─────────────────────────────────────────────────── */

export interface VaultSummary {
  name: string;
  vaultAddress: string;
  leader: string;
  tvl: number;
  apr: number;
  followerCount: number;
}

export interface PlatformStats {
  totalOI: number;
  volume24h: number;
  totalUsers: number;
  totalTrades: number;
}

export interface HypeStaking {
  totalStaked: number;
  validatorCount: number;
  topValidators: { name: string; stake: number; commission: number }[];
}

export interface EcosystemData {
  vaults: VaultSummary[];
  platform: PlatformStats;
  staking: HypeStaking | null;
  spotTokenCount: number;
  perpAssetCount: number;
  fetchedAt: number;
}

/* ── Vault data ───────────────────────────────────────────── */

async function fetchVaultSummaries(): Promise<VaultSummary[]> {
  try {
    const data = await infoRequest({ type: "vaultSummaries" }) as {
      name: string;
      vaultAddress: string;
      leader: string;
      tvl: string;
      apr: number;
      followerCount: number;
    }[];

    if (!Array.isArray(data)) return [];

    return data
      .map((v) => ({
        name: v.name || "Unnamed Vault",
        vaultAddress: v.vaultAddress,
        leader: v.leader,
        tvl: parseFloat(v.tvl) || 0,
        apr: v.apr || 0,
        followerCount: v.followerCount || 0,
      }))
      .filter((v) => v.tvl > 10_000) // Only vaults with >$10K
      .sort((a, b) => b.tvl - a.tvl)
      .slice(0, 20);
  } catch (err) {
    console.warn("[ecosystem] vaultSummaries error:", err);
    return [];
  }
}

/* ── Platform stats from asset contexts ───────────────────── */

async function fetchPlatformStats(): Promise<PlatformStats> {
  try {
    const [meta, ctxs] = await infoRequest({ type: "metaAndAssetCtxs" }) as [
      { universe: { name: string }[] },
      { dayNtlVlm: string; openInterest: string }[]
    ];

    let totalOI = 0;
    let volume24h = 0;

    for (const ctx of ctxs) {
      totalOI += parseFloat(ctx.openInterest) || 0;
      volume24h += parseFloat(ctx.dayNtlVlm) || 0;
    }

    // Get user count from leaderboard
    let totalUsers = 0;
    let totalTrades = 0;
    try {
      const lbRes = await fetch(`${STATS_API}/leaderboard`, {
        headers: { "User-Agent": "hl-ecosystem/1.0" },
      });
      if (lbRes.ok) {
        const lb = await lbRes.json() as { ethAddress: string; windowPerformances: [string, { vlm: string }][] }[];
        totalUsers = lb.length;
        for (const t of lb) {
          const allTimePerf = t.windowPerformances?.find(([w]) => w === "allTime");
          if (allTimePerf) {
            totalTrades += parseFloat(allTimePerf[1].vlm) > 0 ? 1 : 0;
          }
        }
      }
    } catch { /* non-critical */ }

    return { totalOI, volume24h, totalUsers, totalTrades };
  } catch (err) {
    console.warn("[ecosystem] platform stats error:", err);
    return { totalOI: 0, volume24h: 0, totalUsers: 0, totalTrades: 0 };
  }
}

/* ── Staking data ─────────────────────────────────────────── */

async function fetchStakingData(): Promise<HypeStaking | null> {
  try {
    const data = await infoRequest({ type: "validatorSummaries" }) as {
      validator: string;
      name: string;
      stake: string;
      nRecentBlocks: number;
      isJailed: boolean;
      commission: string;
    }[];

    if (!Array.isArray(data) || data.length === 0) return null;

    let totalStaked = 0;
    const topValidators: HypeStaking["topValidators"] = [];

    for (const v of data) {
      const stake = parseFloat(v.stake) || 0;
      totalStaked += stake;
      if (!v.isJailed) {
        topValidators.push({
          name: v.name || v.validator.slice(0, 8),
          stake,
          commission: parseFloat(v.commission) || 0,
        });
      }
    }

    topValidators.sort((a, b) => b.stake - a.stake);

    return {
      totalStaked,
      validatorCount: data.filter((v) => !v.isJailed).length,
      topValidators: topValidators.slice(0, 10),
    };
  } catch (err) {
    console.warn("[ecosystem] staking data error:", err);
    return null;
  }
}

/* ── Spot + Perp counts ───────────────────────────────────── */

async function fetchAssetCounts(): Promise<{ spotTokenCount: number; perpAssetCount: number }> {
  try {
    const [metaRes, spotMetaRes] = await Promise.all([
      infoRequest({ type: "meta" }),
      infoRequest({ type: "spotMeta" }),
    ]);

    const meta = metaRes as { universe: unknown[] };
    const spotMeta = spotMetaRes as { tokens: unknown[] };

    return {
      perpAssetCount: meta?.universe?.length || 0,
      spotTokenCount: spotMeta?.tokens?.length || 0,
    };
  } catch {
    return { spotTokenCount: 0, perpAssetCount: 0 };
  }
}

/* ── Cached fetcher ───────────────────────────────────────── */

let cache: EcosystemData | null = null;
let lastFetch = 0;
const CACHE_TTL = 120_000; // 2 min

export async function fetchEcosystemData(): Promise<EcosystemData> {
  if (cache && Date.now() - lastFetch < CACHE_TTL) return cache;

  const [vaults, platform, staking, counts] = await Promise.all([
    fetchVaultSummaries(),
    fetchPlatformStats(),
    fetchStakingData(),
    fetchAssetCounts(),
  ]);

  cache = {
    vaults,
    platform,
    staking,
    ...counts,
    fetchedAt: Date.now(),
  };
  lastFetch = Date.now();

  return cache;
}

export function getEcosystemCached(): EcosystemData | null {
  return cache;
}
