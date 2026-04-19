"use client";

/**
 * HLOne Studio — Builder Dashboard.
 *
 * Shows all deployed builds for the connected wallet + aggregate earnings.
 * Data comes from /api/studio/earnings, which pulls HL builder-code stats.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSafeAccount } from "@/hooks/use-safe-account";

interface BuildStat {
  deployId: string;
  slug: string;
  name: string;
  deployUrl: string;
  markupBps: number;
  createdAt: string;
  stats: {
    volumeUsd: number;
    feesEarnedUsd: number;
    trades: number;
    uniqueUsers: number;
    last24h: { volumeUsd: number; trades: number };
    last7d: { volumeUsd: number; trades: number };
  };
}

interface EarningsData {
  builds: BuildStat[];
  totals: {
    totalVolumeUsd: number;
    totalFeesEarnedUsd: number;
    totalTrades: number;
    totalUsers: number;
  };
}

export default function DashboardPage() {
  const { address, isConnected } = useSafeAccount();
  const [data, setData] = useState<EarningsData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!address) return;
    setLoading(true);
    fetch(`/api/studio/earnings?wallet=${address}`)
      .then(r => r.json())
      .then(d => setData(d))
      .catch(err => console.error("[dashboard] fetch error:", err))
      .finally(() => setLoading(false));
  }, [address]);

  if (!isConnected) {
    return (
      <div className="min-h-screen bg-[var(--background)] flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-[16px] font-semibold text-[var(--foreground)]">Connect wallet to view your builds</h2>
          <Link href="/studio" className="inline-block mt-4 px-4 py-2 rounded bg-[var(--hl-accent)] text-[var(--background)] text-[12px] font-medium">
            Build on HLOne Studio →
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <header className="border-b border-[var(--hl-border)] px-6 py-3 flex items-center justify-between sticky top-0 z-40 bg-[var(--background)]">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-[15px] font-semibold text-[var(--foreground)]">
            HLOne <span className="text-[var(--hl-accent)]">Studio</span>
          </Link>
          <span className="text-[11px] text-[var(--hl-muted)]">Builder Dashboard</span>
        </div>
        <Link
          href="/studio"
          className="px-3 py-1.5 rounded text-[11px] font-medium bg-[var(--hl-accent)] text-[var(--background)] hover:brightness-110"
        >
          + New Build
        </Link>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">
        {loading ? (
          <div className="text-center py-12 text-[var(--hl-muted)] text-[12px]">Loading your builds...</div>
        ) : !data || data.builds.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-[14px] text-[var(--foreground)] font-medium">No builds yet</div>
            <p className="text-[11px] text-[var(--hl-muted)] mt-1">Deploy your first build to start earning fees.</p>
            <Link
              href="/studio"
              className="inline-block mt-4 px-4 py-2 rounded bg-[var(--hl-accent)] text-[var(--background)] text-[12px] font-medium"
            >
              Build your first terminal →
            </Link>
          </div>
        ) : (
          <>
            {/* Totals */}
            <section className="mb-8">
              <h2 className="text-[12px] font-semibold text-[var(--hl-accent)] uppercase tracking-wider mb-3">Your totals</h2>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <StatCard label="Total Volume" value={`$${data.totals.totalVolumeUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
                <StatCard label="Fees Earned" value={`$${data.totals.totalFeesEarnedUsd.toFixed(2)}`} highlight />
                <StatCard label="Trades" value={data.totals.totalTrades.toLocaleString()} />
                <StatCard label="Unique Users" value={data.totals.totalUsers.toLocaleString()} />
              </div>
            </section>

            {/* Per-build list */}
            <section>
              <h2 className="text-[12px] font-semibold text-[var(--hl-accent)] uppercase tracking-wider mb-3">Your builds</h2>
              <div className="space-y-3">
                {data.builds.map(b => (
                  <div
                    key={b.deployId}
                    className="rounded-lg border border-[var(--hl-border)] bg-[var(--hl-surface)] p-4"
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-[14px] font-semibold text-[var(--foreground)]">{b.name}</h3>
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--hl-accent)]/15 text-[var(--hl-accent)]">
                            {b.markupBps} bps ({(b.markupBps / 100).toFixed(3)}%)
                          </span>
                        </div>
                        <a
                          href={b.deployUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] text-[var(--hl-muted)] hover:text-[var(--hl-accent)] font-mono"
                        >
                          {b.deployUrl} →
                        </a>
                      </div>
                      <div className="text-[9px] text-[var(--hl-muted)] text-right">
                        Deployed {new Date(b.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                    <div className="grid grid-cols-4 gap-3 text-[11px]">
                      <BuildStat label="24h Volume" value={`$${b.stats.last24h.volumeUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
                      <BuildStat label="7d Volume" value={`$${b.stats.last7d.volumeUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
                      <BuildStat label="All-time Volume" value={`$${b.stats.volumeUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
                      <BuildStat label="Fees Earned" value={`$${b.stats.feesEarnedUsd.toFixed(2)}`} highlight />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function StatCard({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded-lg border border-[var(--hl-border)] bg-[var(--hl-surface)] p-4">
      <div className="text-[10px] text-[var(--hl-muted)] uppercase tracking-wide">{label}</div>
      <div className={`text-[20px] font-semibold mt-1 tabular-nums ${highlight ? "text-[var(--hl-accent)]" : "text-[var(--foreground)]"}`}>
        {value}
      </div>
    </div>
  );
}

function BuildStat({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div>
      <div className="text-[9px] text-[var(--hl-muted)] uppercase tracking-wide">{label}</div>
      <div className={`text-[12px] font-medium mt-0.5 tabular-nums ${highlight ? "text-[var(--hl-accent)]" : "text-[var(--foreground)]"}`}>
        {value}
      </div>
    </div>
  );
}
