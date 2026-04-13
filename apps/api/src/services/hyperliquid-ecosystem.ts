/**
 * Hyperliquid Ecosystem Dashboard — platform-level metrics.
 * Uses already-cached data from market-data + hyperliquid services where possible.
 * Falls back to direct API calls only for unique data (vaults).
 */

import { getCachedAssetCtxs, getCachedMeta, getCachedSpotTokens, getCachedHip3Tokens } from "./market-data.js";
import { discoverActiveTraders } from "./hyperliquid.js";

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
  totalUsers: number;
  perpAssetCount: number;
  spotTokenCount: number;
  hip3AssetCount: number;
}

export interface EcosystemData {
  vaults: VaultSummary[];
  platform: PlatformStats;
  topFundingRates: { coin: string; rate: number; annualized: number }[];
  fetchedAt: number;
}

/* ── Platform stats from existing caches ──────────────────── */

async function buildPlatformStats(): Promise<PlatformStats> {
  let totalOI = 0;
  let volume24h = 0;
  let perpAssetCount = 0;
  let spotTokenCount = 0;
  let hip3AssetCount = 0;
  let totalUsers = 0;

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

  try {
    const traders = await discoverActiveTraders();
    totalUsers = traders.length;
  } catch { /* use defaults */ }

  return { totalOI, volume24h, totalUsers, perpAssetCount, spotTokenCount, hip3AssetCount };
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

/* ── Cached fetcher ───────────────────────────────────────── */

let cache: EcosystemData | null = null;
let lastFetch = 0;
const CACHE_TTL = 120_000; // 2 min

export async function fetchEcosystemData(): Promise<EcosystemData> {
  if (cache && Date.now() - lastFetch < CACHE_TTL) return cache;

  const [vaults, platform, topFundingRates] = await Promise.all([
    fetchVaults(),
    buildPlatformStats(),
    buildTopFunding(),
  ]);

  cache = {
    vaults,
    platform,
    topFundingRates,
    fetchedAt: Date.now(),
  };
  lastFetch = Date.now();

  return cache;
}

export function getEcosystemCached(): EcosystemData | null {
  return cache;
}
