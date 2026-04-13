"use client";

import type { EcosystemData } from "@/lib/api";

interface EcosystemPanelProps {
  data: EcosystemData | null;
}

function formatUsd(value: number): string {
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function formatNum(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toLocaleString();
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-[var(--background)] p-2.5">
      <div className="text-[10px] text-[var(--hl-muted)] uppercase tracking-wider mb-1">{label}</div>
      <div className="text-[15px] font-semibold text-[var(--foreground)] tabular-nums">{value}</div>
      {sub && <div className="text-[10px] text-[var(--hl-muted)] mt-0.5">{sub}</div>}
    </div>
  );
}

export function EcosystemPanel({ data }: EcosystemPanelProps) {
  if (!data) {
    return (
      <div className="flex h-32 items-center justify-center text-[var(--hl-muted)] text-[11px]">
        Loading ecosystem data...
      </div>
    );
  }

  const { platform, vaults, topFundingRates } = data;

  return (
    <div>
      <h2 className="text-[13px] font-medium text-[var(--hl-accent)] uppercase tracking-wider mb-2 px-1">
        Hyperliquid Ecosystem
      </h2>

      {/* Platform stats grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-[var(--hl-border)] mb-3">
        <StatCard label="Total OI" value={formatUsd(platform.totalOI)} />
        <StatCard label="24h Volume" value={formatUsd(platform.volume24h)} />
        <StatCard
          label="Assets"
          value={String(platform.perpAssetCount) + " perps"}
          sub={`${platform.spotTokenCount} spot · ${platform.hip3AssetCount} HIP-3`}
        />
        <StatCard label="Leaderboard" value={formatNum(platform.totalUsers) + " traders"} />
      </div>

      {/* Top Funding Rates */}
      {topFundingRates.length > 0 && (
        <div className="mb-3">
          <h3 className="text-[10px] font-medium text-[var(--hl-accent)] uppercase tracking-wider mb-1.5 px-1">
            Top Funding Rates
          </h3>
          <div className="overflow-hidden">
            <div className="flex items-center px-2 py-1 text-[10px] text-[var(--hl-muted)] uppercase tracking-wider border-b border-[var(--hl-border)]">
              <span className="flex-1">Coin</span>
              <span className="w-20 text-right">Rate (8h)</span>
              <span className="w-20 text-right">Annualized</span>
            </div>
            {topFundingRates.map((f, i) => (
              <div key={i} className="flex items-center px-2 py-1 text-[11px] border-b border-[var(--hl-border)]">
                <span className="flex-1 font-medium text-[var(--foreground)]">{f.coin}</span>
                <span className={`w-20 text-right tabular-nums ${f.rate > 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                  {f.rate > 0 ? "+" : ""}{(f.rate * 100).toFixed(4)}%
                </span>
                <span className={`w-20 text-right tabular-nums font-medium ${f.annualized > 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                  {f.annualized > 0 ? "+" : ""}{f.annualized.toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top Vaults */}
      {vaults.length > 0 && (
        <div>
          <h3 className="text-[10px] font-medium text-[var(--hl-accent)] uppercase tracking-wider mb-1.5 px-1">
            Top Vaults
          </h3>
          <div className="overflow-hidden">
            <div className="flex items-center px-2 py-1 text-[10px] text-[var(--hl-muted)] uppercase tracking-wider border-b border-[var(--hl-border)]">
              <span className="flex-1">Vault</span>
              <span className="w-20 text-right">TVL</span>
              <span className="w-14 text-right">APR</span>
              <span className="w-14 text-right">Followers</span>
            </div>
            {vaults.map((v, i) => (
              <div key={i} className="flex items-center px-2 py-1 text-[11px] border-b border-[var(--hl-border)]">
                <span className="flex-1 text-[var(--foreground)] truncate">{v.name}</span>
                <span className="w-20 text-right tabular-nums text-[var(--foreground)]">{formatUsd(v.tvl)}</span>
                <span className={`w-14 text-right tabular-nums ${v.apr > 0 ? "text-[var(--hl-green)]" : v.apr < 0 ? "text-[var(--hl-red)]" : "text-[var(--hl-muted)]"}`}>
                  {(v.apr * 100).toFixed(1)}%
                </span>
                <span className="w-14 text-right tabular-nums text-[var(--hl-muted)]">{v.followerCount}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
