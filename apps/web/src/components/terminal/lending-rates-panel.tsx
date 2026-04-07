"use client";

import { useEffect, useState, useCallback } from "react";

/* ── Types ─────────────────────────────────────────────────────────── */

interface AssetRate {
  asset: string;
  supplyApy: number | null;
  borrowApy: number | null;
}

interface FelixVaultItem {
  name: string;
  symbol: string;
  state: { totalAssetsUsd: number; apy: number; netApy: number };
  asset: { symbol: string };
}

interface FelixMarketItem {
  loanAsset: { symbol: string };
  collateralAsset: { symbol: string };
  state: {
    supplyApy: number;
    borrowApy: number;
    utilization: number;
    supplyAssetsUsd: number;
  };
}

interface LlamaPool {
  pool: string;
  project: string;
  chain: string;
  symbol: string;
  apyBase: number | null;
  apyReward: number | null;
}

interface LlamaBorrow {
  pool: string;
  project: string;
  chain: string;
  apyBaseBorrow: number | null;
}

/* ── Helpers ───────────────────────────────────────────────────────── */

function normalizeAsset(raw: string): string {
  const s = raw.toUpperCase().trim();
  if (s === "WHYPE" || s === "HYPE") return "HYPE";
  if (s === "USDT0" || s === "USDT") return "USDT0";
  return s;
}

function fmtApy(value: number | null): string {
  if (value === null || value === undefined) return "—";
  return `${(value * 100).toFixed(2)}%`;
}

function fmtApyRaw(value: number | null): string {
  if (value === null || value === undefined) return "—";
  return `${value.toFixed(2)}%`;
}

/* ── Felix data fetching ───────────────────────────────────────────── */

async function fetchFelix(): Promise<AssetRate[]> {
  const MORPHO_URL = "https://blue-api.morpho.org/graphql";

  const vaultQuery = `{
    vaults(where: { chainId_in: [999] }, first: 20) {
      items {
        name symbol
        state { totalAssetsUsd apy netApy }
        asset { symbol }
      }
    }
  }`;

  const marketQuery = `{
    markets(where: { chainId_in: [999] }, first: 30, orderBy: SupplyAssetsUsd, orderDirection: Desc) {
      items {
        loanAsset { symbol }
        collateralAsset { symbol }
        state { supplyApy borrowApy utilization supplyAssetsUsd }
      }
    }
  }`;

  const [vaultRes, marketRes] = await Promise.all([
    fetch(MORPHO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: vaultQuery }),
    }),
    fetch(MORPHO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: marketQuery }),
    }),
  ]);

  const vaultJson = await vaultRes.json();
  const marketJson = await marketRes.json();

  const vaults: FelixVaultItem[] = vaultJson?.data?.vaults?.items ?? [];
  const markets: FelixMarketItem[] = marketJson?.data?.markets?.items ?? [];

  // Build vault supply APY map (best APY per asset)
  const supplyMap = new Map<string, number>();
  for (const v of vaults) {
    const asset = normalizeAsset(v.asset?.symbol ?? "");
    const apy = v.state?.netApy ?? v.state?.apy ?? 0;
    const existing = supplyMap.get(asset);
    if (existing === undefined || apy > existing) {
      supplyMap.set(asset, apy);
    }
  }

  // Build weighted-average borrow APY per loan asset
  const borrowAccum = new Map<string, { weightedSum: number; totalSupply: number }>();
  for (const m of markets) {
    const asset = normalizeAsset(m.loanAsset?.symbol ?? "");
    const borrowApy = m.state?.borrowApy ?? 0;
    const supply = m.state?.supplyAssetsUsd ?? 0;
    const entry = borrowAccum.get(asset) ?? { weightedSum: 0, totalSupply: 0 };
    entry.weightedSum += borrowApy * supply;
    entry.totalSupply += supply;
    borrowAccum.set(asset, entry);
  }

  const borrowMap = new Map<string, number>();
  for (const [asset, { weightedSum, totalSupply }] of borrowAccum) {
    if (totalSupply > 0) borrowMap.set(asset, weightedSum / totalSupply);
  }

  // Merge unique assets
  const allAssets = new Set([...supplyMap.keys(), ...borrowMap.keys()]);
  const results: AssetRate[] = [];
  for (const asset of allAssets) {
    results.push({
      asset,
      supplyApy: supplyMap.get(asset) ?? null,
      borrowApy: borrowMap.get(asset) ?? null,
    });
  }

  // Sort: stables first, then by supply APY desc
  const stables = new Set(["USDC", "USDT0", "USDH", "USDE"]);
  results.sort((a, b) => {
    const aStable = stables.has(a.asset) ? 0 : 1;
    const bStable = stables.has(b.asset) ? 0 : 1;
    if (aStable !== bStable) return aStable - bStable;
    return (b.supplyApy ?? 0) - (a.supplyApy ?? 0);
  });

  return results;
}

/* ── HyperLend data fetching ───────────────────────────────────────── */

async function fetchHyperLend(): Promise<AssetRate[]> {
  const [poolsRes, borrowRes] = await Promise.all([
    fetch("https://yields.llama.fi/pools"),
    fetch("https://yields.llama.fi/lendBorrow"),
  ]);

  const poolsJson = await poolsRes.json();
  const borrowJson = await borrowRes.json();

  const allPools: LlamaPool[] = poolsJson?.data ?? [];
  const allBorrow: LlamaBorrow[] = borrowJson?.data ?? borrowJson ?? [];

  // Filter HyperLend pools
  const hlPools = allPools.filter(
    (p) => p.project === "hyperlend-pooled" && p.chain === "Hyperliquid L1"
  );

  // Build borrow map by pool id
  const borrowMap = new Map<string, number>();
  for (const b of allBorrow) {
    if (b.project === "hyperlend-pooled") {
      if (b.apyBaseBorrow !== null && b.apyBaseBorrow !== undefined) {
        borrowMap.set(b.pool, b.apyBaseBorrow);
      }
    }
  }

  const results: AssetRate[] = hlPools.map((p) => {
    // Extract asset symbol from the pool symbol (e.g. "USDC" from "USDC")
    const asset = normalizeAsset(p.symbol?.split("-")?.[0] ?? p.symbol ?? "");
    return {
      asset,
      supplyApy: p.apyBase,
      borrowApy: borrowMap.get(p.pool) ?? null,
    };
  });

  // Sort stables first
  const stables = new Set(["USDC", "USDT0", "USDH", "USDE"]);
  results.sort((a, b) => {
    const aStable = stables.has(a.asset) ? 0 : 1;
    const bStable = stables.has(b.asset) ? 0 : 1;
    if (aStable !== bStable) return aStable - bStable;
    return (b.supplyApy ?? 0) - (a.supplyApy ?? 0);
  });

  return results;
}

/* ── Sub-components ────────────────────────────────────────────────── */

function assetUrl(asset: string, protocol: "felix" | "hyperlend"): string {
  if (protocol === "felix") {
    // Felix lending page — links to specific vault/market
    const assetSlug = asset.toLowerCase() === "hype" ? "whype" : asset.toLowerCase();
    return `https://www.usefelix.xyz/vanilla/lend?asset=${assetSlug}`;
  }
  // HyperLend — links to specific market
  const assetSlug = asset.toLowerCase() === "hype" ? "whype" : asset.toLowerCase();
  return `https://app.hyperlend.finance/reserve-overview/?underlyingAsset=${assetSlug}`;
}

function RateTable({
  rates,
  loading,
  error,
  felixStyle,
  protocol,
}: {
  rates: AssetRate[];
  loading: boolean;
  error: string | null;
  felixStyle: boolean;
  protocol: "felix" | "hyperlend";
}) {
  if (loading) {
    return (
      <div className="flex h-20 items-center justify-center text-[var(--hl-muted)] text-[11px]">
        Loading rates...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-20 items-center justify-center text-[var(--hl-red)] text-[10px]">
        {error}
      </div>
    );
  }

  if (!rates.length) {
    return (
      <div className="flex h-20 items-center justify-center text-[var(--hl-muted)] text-[10px]">
        No data
      </div>
    );
  }

  return (
    <div className="overflow-y-auto scroll-on-hover max-h-[220px]">
      {/* Header */}
      <div className="flex items-center px-2 py-1 text-[10px] text-[var(--hl-muted)] uppercase tracking-wider border-b border-[var(--hl-border)]">
        <span className="w-14">Asset</span>
        <span className="flex-1 text-right">Supply APY</span>
        <span className="flex-1 text-right">Borrow APY</span>
      </div>
      {rates.map((r, i) => (
        <a
          key={`${r.asset}-${i}`}
          href={assetUrl(r.asset, protocol)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center px-2 py-1 text-[11px] border-b border-[var(--hl-border)] hover:bg-[var(--hl-surface-hover)] transition-colors cursor-pointer"
        >
          <span className="font-medium text-[var(--foreground)] w-14 truncate hover:text-[var(--hl-green)] transition-colors">
            {r.asset}
          </span>
          <span className="flex-1 text-right tabular-nums text-[var(--hl-green)]">
            {felixStyle ? fmtApy(r.supplyApy) : fmtApyRaw(r.supplyApy)}
          </span>
          <span className="flex-1 text-right tabular-nums text-[var(--hl-red)]">
            {felixStyle ? fmtApy(r.borrowApy) : fmtApyRaw(r.borrowApy)}
          </span>
          <span className="text-[var(--hl-muted)] text-[9px] ml-1">↗</span>
        </a>
      ))}
    </div>
  );
}

/* ── Main panel ────────────────────────────────────────────────────── */

type Tab = "felix" | "hyperlend";

export function LendingRatesPanel() {
  const [tab, setTab] = useState<Tab>("felix");

  const [felixRates, setFelixRates] = useState<AssetRate[]>([]);
  const [felixLoading, setFelixLoading] = useState(true);
  const [felixError, setFelixError] = useState<string | null>(null);

  const [hlRates, setHlRates] = useState<AssetRate[]>([]);
  const [hlLoading, setHlLoading] = useState(true);
  const [hlError, setHlError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    // Fetch both independently so one failing doesn't block the other
    fetchFelix()
      .then((data) => {
        setFelixRates(data);
        setFelixError(null);
      })
      .catch((err) => {
        console.error("Felix fetch error:", err);
        setFelixError("Failed to load");
      })
      .finally(() => setFelixLoading(false));

    fetchHyperLend()
      .then((data) => {
        setHlRates(data);
        setHlError(null);
      })
      .catch((err) => {
        console.error("HyperLend fetch error:", err);
        setHlError("Failed to load");
      })
      .finally(() => setHlLoading(false));
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 60_000);
    return () => clearInterval(interval);
  }, [loadData]);

  return (
    <div>
      <h2 className="text-[13px] font-medium text-[var(--hl-muted)] uppercase tracking-wider mb-2 px-1">
        Lending &amp; Borrowing Rates
      </h2>

      {/* Tabs */}
      <div className="flex items-center gap-1 px-1 mb-2">
        <button
          onClick={() => setTab("felix")}
          className={`px-2 py-0.5 text-[10px] uppercase tracking-wider rounded transition-colors ${
            tab === "felix"
              ? "bg-[var(--hl-surface-hover)] text-[var(--foreground)]"
              : "text-[var(--hl-muted)] hover:text-[var(--foreground)]"
          }`}
        >
          Felix
        </button>
        <button
          onClick={() => setTab("hyperlend")}
          className={`px-2 py-0.5 text-[10px] uppercase tracking-wider rounded transition-colors ${
            tab === "hyperlend"
              ? "bg-[var(--hl-surface-hover)] text-[var(--foreground)]"
              : "text-[var(--hl-muted)] hover:text-[var(--foreground)]"
          }`}
        >
          HyperLend
        </button>
      </div>

      {/* Content */}
      {tab === "felix" ? (
        <>
          <RateTable
            rates={felixRates}
            loading={felixLoading}
            error={felixError}
            felixStyle={true}
            protocol="felix"
          />
          <a
            href="https://www.usefelix.xyz/vanilla/lend"
            target="_blank"
            rel="noopener noreferrer"
            className="block mt-2 px-2 text-[10px] text-[var(--hl-green)] hover:underline"
          >
            Lend on Felix &rarr;
          </a>
        </>
      ) : (
        <>
          <RateTable
            rates={hlRates}
            loading={hlLoading}
            error={hlError}
            felixStyle={false}
            protocol="hyperlend"
          />
          <a
            href="https://app.hyperlend.finance"
            target="_blank"
            rel="noopener noreferrer"
            className="block mt-2 px-2 text-[10px] text-[var(--hl-green)] hover:underline"
          >
            Lend on HyperLend &rarr;
          </a>
        </>
      )}
    </div>
  );
}
