"use client";

import type { WhaleAccumulation } from "@/lib/api";

const displayCoin = (c: string) => c.includes(":") ? c.split(":")[1] : c;

function formatUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

interface Props {
  data: WhaleAccumulation[];
  onSelectToken: (coin: string) => void;
}

export function WhaleAccumulationPanel({ data, onSelectToken }: Props) {
  if (!data.length) {
    return (
      <div className="flex h-32 items-center justify-center text-[var(--hl-muted)] text-[11px]">
        Collecting whale data...
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-[13px] font-medium text-[var(--hl-accent)] uppercase tracking-wider mb-2 px-1">
        Whale Accumulation
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-[var(--hl-border)] text-[var(--hl-muted)]">
              <th className="text-left py-1.5 px-2 font-normal">Coin</th>
              <th className="text-right py-1.5 px-2 font-normal">1h</th>
              <th className="text-right py-1.5 px-2 font-normal">24h</th>
              <th className="text-right py-1.5 px-2 font-normal">7d</th>
              <th className="text-right py-1.5 px-2 font-normal">Whales</th>
              <th className="text-center py-1.5 px-2 font-normal">Trend</th>
            </tr>
          </thead>
          <tbody>
            {data.map(row => (
              <tr
                key={row.coin}
                onClick={() => onSelectToken(row.coin)}
                className="border-b border-[var(--hl-border)] hover:bg-[var(--hl-surface-hover)] cursor-pointer transition-colors"
              >
                <td className="py-1.5 px-2 font-medium text-[var(--foreground)]">{displayCoin(row.coin)}</td>
                <td className={`py-1.5 px-2 text-right tabular-nums ${row.net1h > 0 ? "text-[var(--hl-green)]" : row.net1h < 0 ? "text-[var(--hl-red)]" : "text-[var(--hl-muted)]"}`}>
                  {row.net1h > 0 ? "+" : ""}{formatUsd(row.net1h)}
                </td>
                <td className={`py-1.5 px-2 text-right tabular-nums font-medium ${row.net24h > 0 ? "text-[var(--hl-green)]" : row.net24h < 0 ? "text-[var(--hl-red)]" : "text-[var(--hl-muted)]"}`}>
                  {row.net24h > 0 ? "+" : ""}{formatUsd(row.net24h)}
                </td>
                <td className={`py-1.5 px-2 text-right tabular-nums ${row.net7d > 0 ? "text-[var(--hl-green)]" : row.net7d < 0 ? "text-[var(--hl-red)]" : "text-[var(--hl-muted)]"}`}>
                  {row.net7d > 0 ? "+" : ""}{formatUsd(row.net7d)}
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums text-[var(--hl-muted)]">{row.whales24h}</td>
                <td className="py-1.5 px-2 text-center">
                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
                    row.trend === "accumulating" ? "bg-[var(--hl-green)]/15 text-[var(--hl-green)]" :
                    row.trend === "distributing" ? "bg-[var(--hl-red)]/15 text-[var(--hl-red)]" :
                    "bg-[var(--hl-surface)] text-[var(--hl-muted)]"
                  }`}>
                    {row.trend === "accumulating" ? "ACCUM" : row.trend === "distributing" ? "DIST" : "—"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
