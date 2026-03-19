"use client";

import type { WhaleAlert } from "@/lib/api";
import { formatUsd } from "@/lib/utils";

interface WhaleFeedProps {
  alerts: WhaleAlert[];
  onSelectToken: (coin: string) => void;
  onCopy?: (address: string) => void;
  onFade?: (address: string) => void;
}

const EVENT_LABELS: Record<string, { label: string; color: string }> = {
  open_long: { label: "Opened Long", color: "text-[var(--hl-green)]" },
  open_short: { label: "Opened Short", color: "text-[var(--hl-red)]" },
  close_long: { label: "Closed Long", color: "text-[var(--hl-muted)]" },
  close_short: { label: "Closed Short", color: "text-[var(--hl-muted)]" },
  increase: { label: "Increased", color: "text-[var(--hl-green)]" },
  decrease: { label: "Decreased", color: "text-[var(--hl-red)]" },
  flip: { label: "Flipped", color: "text-yellow-400" },
};

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

export function WhaleFeed({ alerts, onSelectToken, onCopy, onFade }: WhaleFeedProps) {
  if (!alerts.length) {
    return (
      <div className="flex h-40 items-center justify-center text-[var(--hl-muted)] text-[13px]">
        Watching for whale moves...
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-[13px] font-medium text-[var(--hl-muted)] uppercase tracking-wider mb-2 px-1">
        Whale Alerts
      </h2>
      <div className="overflow-y-auto max-h-[calc(50vh-60px)] space-y-0">
        {alerts.map((alert) => {
          const evt = EVENT_LABELS[alert.eventType] || { label: alert.eventType, color: "text-[var(--hl-text)]" };

          return (
            <div
              key={alert.id}
              className="group flex items-start gap-2 py-2 px-2 border-b border-[var(--hl-border)] hover:bg-[var(--hl-surface-hover)] transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 text-[12px]">
                  <span className="font-medium text-[var(--foreground)] truncate max-w-[100px]">
                    {alert.whaleName}
                  </span>
                  <span className={`font-medium ${evt.color}`}>{evt.label}</span>
                  <button
                    onClick={() => onSelectToken(alert.coin)}
                    className="font-medium text-[var(--foreground)] hover:text-[var(--hl-green)] transition-colors"
                  >
                    {alert.coin}
                  </button>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-[var(--hl-muted)] mt-0.5">
                  <span>${alert.positionValueUsd >= 1000000
                    ? `${(alert.positionValueUsd / 1000000).toFixed(1)}M`
                    : `${(alert.positionValueUsd / 1000).toFixed(0)}K`
                  }</span>
                  <span>·</span>
                  <span>{timeAgo(alert.detectedAt)}</span>
                </div>
              </div>
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {onCopy && (
                  <button
                    onClick={() => onCopy(alert.whaleAddress)}
                    className="px-2 py-0.5 rounded text-[10px] font-medium bg-[var(--hl-green)] text-[var(--background)] hover:brightness-110"
                  >
                    Copy
                  </button>
                )}
                {onFade && (
                  <button
                    onClick={() => onFade(alert.whaleAddress)}
                    className="px-2 py-0.5 rounded text-[10px] font-medium bg-[var(--hl-red)] text-white hover:brightness-110"
                  >
                    Fade
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
