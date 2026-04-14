/**
 * Hyperliquid Ecosystem Dashboard — platform-level metrics.
 * Uses already-cached data from market-data + hyperliquid services where possible.
 * Falls back to direct API calls only for unique data (vaults).
 */

import { getCachedAssetCtxs, getCachedMeta, getCachedSpotTokens, getCachedHip3Tokens } from "./market-data.js";
import { getSmartMoneyCached } from "./smart-money.js";
import { getLiquidationHeatmap } from "./liquidation-heatmap.js";
import { getWhaleAlerts } from "./whale-tracker.js";

const HL_API = "https://api.hyperliquid.xyz";

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
  perpAssetCount: number;
  spotTokenCount: number;
  hip3AssetCount: number;
  /** Aggregate long liquidation value tracked (near current prices) */
  longLiqExposure: number;
  /** Aggregate short liquidation value tracked (near current prices) */
  shortLiqExposure: number;
  /** Net whale $ flow in last 24h — positive = net buying */
  whaleNetFlow24h: number;
  /** Count of sharp (profitable) traders currently tracked */
  sharpCount: number;
  /** Net sharp direction: % of sharps positioned long */
  sharpLongPct: number;
}

export interface ValidatorInfo {
  name: string;
  address: string;
  stake: number; // in HYPE
  commission: number; // 0-1
  isActive: boolean;
  isJailed: boolean;
  apr: number; // predicted annualized return
  recentBlocks: number;
}

export interface StakingStats {
  totalStaked: number; // in HYPE
  activeValidators: number;
  totalValidators: number;
  avgApr: number;
  topValidators: ValidatorInfo[];
}

export interface Hip3Stats {
  totalAssets: number;
  totalVolume24h: number;
  totalOI: number;
  byCategory: { category: string; count: number; volume24h: number; oi: number }[];
  byDex: { dex: string; count: number; volume24h: number }[];
}

export interface EcosystemData {
  vaults: VaultSummary[];
  platform: PlatformStats;
  topFundingRates: { coin: string; rate: number; annualized: number }[];
  staking: StakingStats | null;
  hip3: Hip3Stats | null;
  fetchedAt: number;
}

/* ── Platform stats from existing caches ──────────────────── */

async function buildPlatformStats(): Promise<PlatformStats> {
  let totalOI = 0;
  let volume24h = 0;
  let perpAssetCount = 0;
  let spotTokenCount = 0;
  let hip3AssetCount = 0;

  try {
    const ctxs = await getCachedAssetCtxs();
    perpAssetCount = ctxs.size;
    for (const ctx of ctxs.values()) {
      totalOI += parseFloat(ctx.openInterest as string) || 0;
      volume24h += parseFloat(ctx.dayNtlVlm as string) || 0;
    }
  } catch { /* use defaults */ }

  try {
    const spotTokens = await getCachedSpotTokens();
    spotTokenCount = spotTokens.length;
  } catch { /* use defaults */ }

  try {
    const hip3Tokens = await getCachedHip3Tokens();
    hip3AssetCount = hip3Tokens.length;
  } catch { /* use defaults */ }

  // Liquidation exposure from heatmap
  let longLiqExposure = 0;
  let shortLiqExposure = 0;
  try {
    const heatmap = getLiquidationHeatmap();
    for (const h of heatmap) {
      longLiqExposure += h.totalLongLiqAbove;
      shortLiqExposure += h.totalShortLiqBelow;
    }
  } catch { /* use defaults */ }

  // Net whale flow from whale tracker events (last 24h)
  let whaleNetFlow24h = 0;
  try {
    const events = getWhaleAlerts(500);
    const oneDayAgo = Date.now() - 24 * 60 * 60_000;
    for (const e of events) {
      if (e.detectedAt < oneDayAgo) continue;
      const val = e.positionValueUsd || 0;
      if (e.eventType === "open_long" || e.eventType === "added") {
        whaleNetFlow24h += val;
      } else if (e.eventType === "open_short") {
        whaleNetFlow24h -= val;
      } else if (e.eventType === "close_long") {
        whaleNetFlow24h -= val;
      } else if (e.eventType === "close_short") {
        whaleNetFlow24h += val;
      }
    }
  } catch { /* use defaults */ }

  // Sharp trader stats
  let sharpCount = 0;
  let sharpLongPct = 50;
  try {
    const sm = getSmartMoneyCached();
    if (sm) {
      sharpCount = sm.sharps.length;
      // Compute net direction from sharp positions
      let longCount = 0;
      let totalPositions = 0;
      for (const positions of sm.sharpPositions.values()) {
        for (const p of positions) {
          if (p.isSharp) {
            totalPositions++;
            if (p.side === "long") longCount++;
          }
        }
      }
      if (totalPositions > 0) sharpLongPct = Math.round((longCount / totalPositions) * 100);
    }
  } catch { /* use defaults */ }

  return {
    totalOI,
    volume24h,
    perpAssetCount,
    spotTokenCount,
    hip3AssetCount,
    longLiqExposure,
    shortLiqExposure,
    whaleNetFlow24h,
    sharpCount,
    sharpLongPct,
  };
}

/* ── Top funding rates ────────────────────────────────────── */

async function buildTopFunding(): Promise<{ coin: string; rate: number; annualized: number }[]> {
  try {
    const ctxs = await getCachedAssetCtxs();
    const rates: { coin: string; rate: number; annualized: number }[] = [];
    for (const [coin, ctx] of ctxs) {
      const rate = parseFloat(ctx.funding as string) || 0;
      if (Math.abs(rate) > 0.00001) {
        rates.push({ coin, rate, annualized: rate * 3 * 365 * 100 });
      }
    }
    rates.sort((a, b) => Math.abs(b.rate) - Math.abs(a.rate));
    return rates.slice(0, 10);
  } catch {
    return [];
  }
}

/* ── Vault data ───────────────────────────────────────────── */

async function fetchVaults(): Promise<VaultSummary[]> {
  try {
    // Try the vaultSummaries endpoint
    const data = await infoRequest({ type: "vaultSummaries" });
    if (!Array.isArray(data) || data.length === 0) return [];

    return data
      .map((v: Record<string, unknown>) => ({
        name: (v.name as string) || "Unnamed Vault",
        vaultAddress: (v.vaultAddress as string) || "",
        leader: (v.leader as string) || "",
        tvl: parseFloat(v.tvl as string) || 0,
        apr: (v.apr as number) || 0,
        followerCount: (v.followerCount as number) || 0,
      }))
      .filter((v: VaultSummary) => v.tvl > 10_000)
      .sort((a: VaultSummary, b: VaultSummary) => b.tvl - a.tvl)
      .slice(0, 15);
  } catch (err) {
    console.warn("[ecosystem] vaultSummaries not available:", (err as Error).message);
    return [];
  }
}

/* ── Staking stats from validatorSummaries ────────────────── */

async function fetchStakingStats(): Promise<StakingStats | null> {
  try {
    const data = await infoRequest({ type: "validatorSummaries" });
    if (!Array.isArray(data) || data.length === 0) return null;

    const validators: ValidatorInfo[] = data.map((v: Record<string, unknown>) => {
      // stake is in raw units — divide by 1e8 (based on observed data scale)
      const rawStake = parseFloat(v.stake as string) || 0;
      const stake = rawStake > 1e10 ? rawStake / 1e8 : rawStake;
      const commission = parseFloat(v.commission as string) || 0;
      const isActive = v.isActive as boolean ?? false;
      const isJailed = v.isJailed as boolean ?? false;

      // Extract predicted APR from stats array: [["day", {...}], ["week", {...}], ...]
      let apr = 0;
      const stats = v.stats as [string, { predictedApr?: string }][] | undefined;
      if (stats) {
        for (const [, s] of stats) {
          if (s.predictedApr) {
            apr = parseFloat(s.predictedApr) * 100; // convert to %
            break;
          }
        }
      }

      return {
        name: (v.name as string) || "Unknown",
        address: (v.validator as string) || "",
        stake,
        commission,
        isActive,
        isJailed,
        apr,
        recentBlocks: (v.nRecentBlocks as number) || 0,
      };
    });

    const active = validators.filter(v => v.isActive && !v.isJailed);
    const totalStaked = validators.reduce((sum, v) => sum + v.stake, 0);
    const avgApr = active.length > 0
      ? active.reduce((sum, v) => sum + v.apr, 0) / active.length
      : 0;

    return {
      totalStaked,
      activeValidators: active.length,
      totalValidators: validators.length,
      avgApr,
      topValidators: validators
        .filter(v => v.isActive)
        .sort((a, b) => b.stake - a.stake)
        .slice(0, 10),
    };
  } catch (err) {
    console.warn("[ecosystem] validatorSummaries failed:", (err as Error).message);
    return null;
  }
}

/* ── HIP-3 stats from cached token data ──────────────────── */

async function buildHip3Stats(): Promise<Hip3Stats | null> {
  try {
    const tokens = await getCachedHip3Tokens();
    if (!tokens.length) return null;

    const byCategory = new Map<string, { count: number; volume24h: number; oi: number }>();
    const byDex = new Map<string, { count: number; volume24h: number }>();
    let totalVolume = 0;
    let totalOI = 0;

    for (const t of tokens) {
      totalVolume += t.volume24h;
      totalOI += t.openInterest;

      const cat = byCategory.get(t.category) || { count: 0, volume24h: 0, oi: 0 };
      cat.count++;
      cat.volume24h += t.volume24h;
      cat.oi += t.openInterest;
      byCategory.set(t.category, cat);

      const dex = byDex.get(t.dex) || { count: 0, volume24h: 0 };
      dex.count++;
      dex.volume24h += t.volume24h;
      byDex.set(t.dex, dex);
    }

    return {
      totalAssets: tokens.length,
      totalVolume24h: totalVolume,
      totalOI: totalOI,
      byCategory: [...byCategory.entries()]
        .map(([category, s]) => ({ category, ...s }))
        .sort((a, b) => b.volume24h - a.volume24h),
      byDex: [...byDex.entries()]
        .map(([dex, s]) => ({ dex, ...s }))
        .sort((a, b) => b.volume24h - a.volume24h),
    };
  } catch {
    return null;
  }
}

/* ── Cached fetcher ───────────────────────────────────────── */

let cache: EcosystemData | null = null;
let lastFetch = 0;
const CACHE_TTL = 120_000; // 2 min

export async function fetchEcosystemData(): Promise<EcosystemData> {
  if (cache && Date.now() - lastFetch < CACHE_TTL) return cache;

  const [vaults, platform, topFundingRates, staking, hip3] = await Promise.all([
    fetchVaults(),
    buildPlatformStats(),
    buildTopFunding(),
    fetchStakingStats(),
    buildHip3Stats(),
  ]);

  cache = {
    vaults,
    platform,
    topFundingRates,
    staking,
    hip3,
    fetchedAt: Date.now(),
  };
  lastFetch = Date.now();

  return cache;
}

export function getEcosystemCached(): EcosystemData | null {
  return cache;
}
