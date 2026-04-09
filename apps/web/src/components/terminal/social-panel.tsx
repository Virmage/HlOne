"use client";

import type { SocialMetrics } from "@/lib/api";

interface SocialPanelProps {
  social: SocialMetrics[];
  onSelectToken: (coin: string) => void;
}

export function SocialPanel({ social, onSelectToken }: SocialPanelProps) {
  if (!social.length) {
    return (
      <div className="flex h-32 items-center justify-center text-[var(--hl-muted)] text-[12px]">
        No social data available
      </div>
    );
  }

  // Sort by galaxy score descending
  const sorted = [...social].sort((a, b) => b.galaxyScore - a.galaxyScore);

  return (
    <div>
      <h2 className="text-[13px] font-medium text-[var(--hl-accent)] uppercase tracking-wider mb-2 px-1">
        Social Sentiment <span className="text-[10px] font-normal text-[var(--hl-muted)]">LunarCrush</span>
      </h2>
      <div className="overflow-hidden">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-[var(--hl-border)] text-[var(--hl-muted)] text-[10px]">
              <th className="py-1 px-2 text-left font-normal">Token</th>
              <th className="py-1 px-2 text-center font-normal">Galaxy</th>
              <th className="py-1 px-2 text-center font-normal">Sentiment</th>
              <th className="py-1 px-2 text-right font-normal">Social Vol</th>
              <th className="py-1 px-2 text-right font-normal">Rank</th>
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, 9).map((s) => {
              const sentimentColor = s.sentiment >= 60
                ? "text-[var(--hl-green)]"
                : s.sentiment <= 40
                ? "text-[var(--hl-red)]"
                : "text-[var(--hl-text)]";

              const galaxyColor = s.galaxyScore >= 70
                ? "text-[var(--hl-green)]"
                : s.galaxyScore <= 30
                ? "text-[var(--hl-red)]"
                : "text-[var(--hl-text)]";

              return (
                <tr
                  key={s.coin}
                  className="border-b border-[var(--hl-border)] hover:bg-[var(--hl-surface-hover)] cursor-pointer transition-colors"
                  onClick={() => onSelectToken(s.coin)}
                >
                  <td className="py-1 px-2 font-medium text-[var(--foreground)]">{s.coin}</td>
                  <td className="py-1 px-2 text-center">
                    <div className="flex items-center gap-1 justify-center">
                      <div className="w-8 h-1.5 rounded-full bg-[var(--hl-border)] overflow-hidden">
                        <div
                          className={`h-full rounded-full ${s.galaxyScore >= 60 ? "bg-[var(--hl-green)]" : s.galaxyScore <= 40 ? "bg-[var(--hl-red)]" : "bg-[var(--hl-text)]"}`}
                          style={{ width: `${s.galaxyScore}%` }}
                        />
                      </div>
                      <span className={`tabular-nums ${galaxyColor}`}>{s.galaxyScore}</span>
                    </div>
                  </td>
                  <td className={`py-1 px-2 text-center tabular-nums ${sentimentColor}`}>
                    {s.sentiment}
                  </td>
                  <td className="py-1 px-2 text-right tabular-nums text-[var(--foreground)]">
                    {s.socialVolume >= 1000 ? `${(s.socialVolume / 1000).toFixed(1)}K` : s.socialVolume}
                  </td>
                  <td className="py-1 px-2 text-right tabular-nums text-[var(--hl-muted)]">
                    #{s.altRank}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
