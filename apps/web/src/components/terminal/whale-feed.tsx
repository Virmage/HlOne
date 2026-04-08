"use client";

import { useState } from "react";
import type { WhaleAlert } from "@/lib/api";
import { formatUsd } from "@/lib/utils";

interface WhaleFeedProps {
  alerts: WhaleAlert[];
  onSelectToken: (coin: string) => void;
  onSelectTrader?: (address: string) => void;
  onCopy?: (address: string) => void;
}

const EVENT_LABELS: Record<string, { label: string; color: string }> = {
  open_long: { label: "Opened Long", color: "text-[var(--hl-green)]" },
  open_short: { label: "Opened Short", color: "text-[var(--hl-red)]" },
  close_long: { label: "Closed Long", color: "text-[var(--hl-muted)]" },
  close_short: { label: "Closed Short", color: "text-[var(--hl-muted)]" },
  added: { label: "Added", color: "text-[var(--hl-green)]" },
  trimmed: { label: "Trimmed", color: "text-[var(--hl-red)]" },
  flip_long: { label: "Flipped Short → Long", color: "text-[var(--hl-green)]" },
  flip_short: { label: "Flipped Long → Short", color: "text-[var(--hl-red)]" },
  flip: { label: "Flipped", color: "text-yellow-400" },
  // Legacy support
  increase: { label: "Added", color: "text-[var(--hl-green)]" },
  decrease: { label: "Trimmed", color: "text-[var(--hl-red)]" },
};

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

export function WhaleFeed({ alerts, onSelectToken, onSelectTrader, onCopy }: WhaleFeedProps) {
  const [expanded, setExpanded] = useState(false);

  if (!alerts.length) {
    return (
      <div className="flex h-40 items-center justify-center text-[var(--hl-muted)] text-[13px]">
        Watching for whale moves...
      </div>
    );
  }

  const visibleAlerts = expanded ? alerts : alerts.slice(0, 6);

  return (
    <div>
    <div className="max-h-[320px] flex flex-col cursor-pointer" onClick={() => setExpanded(true)}>
      <h2 className="text-[13px] font-medium text-[var(--hl-accent)] uppercase tracking-wider mb-2 px-1 shrink-0">
        Whale Alerts
      </h2>
      <div className="overflow-hidden flex-1 space-y-0">
        {visibleAlerts.map((alert) => {
          // For flips, resolve direction from newSize
          const resolvedType = alert.eventType === "flip"
            ? (alert.newSize > 0 ? "flip_long" : "flip_short")
            : alert.eventType;
          const evt = EVENT_LABELS[resolvedType] || { label: alert.eventType, color: "text-[var(--hl-text)]" };

          // For added/trimmed, show Long/Short direction
          const isAddedOrTrimmed = ["added", "trimmed", "increase", "decrease"].includes(alert.eventType);
          const posDirection = alert.newSize > 0 ? "Long" : alert.newSize < 0 ? "Short" : "";
          const dirColor = alert.newSize > 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]";

          return (
            <div
              key={alert.id}
              className="group flex items-start gap-2 py-1.5 px-2 border-b border-[var(--hl-border)] hover:bg-[var(--hl-surface-hover)] transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 text-[12px]">
                  <button
                    onClick={(e) => { e.stopPropagation(); onSelectTrader?.(alert.whaleAddress); }}
                    className="font-medium text-[var(--foreground)] truncate max-w-[100px] hover:text-[var(--hl-accent)] hover:underline transition-colors"
                  >
                    {alert.whaleName}
                  </button>
                  <span className={`font-medium ${evt.color}`}>{evt.label}</span>
                  {isAddedOrTrimmed && posDirection && (
                    <span className={`text-[10px] font-medium ${dirColor}`}>{posDirection}</span>
                  )}
                  <button
                    onClick={() => onSelectToken(alert.coin)}
                    className="font-medium text-[var(--foreground)] hover:text-[var(--hl-accent)] transition-colors"
                  >
                    {alert.coin.includes(":") ? alert.coin.split(":")[1] : alert.coin}
                  </button>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-[var(--hl-muted)] mt-0.5">
                  <span>${alert.positionValueUsd >= 1000000
                    ? `${(alert.positionValueUsd / 1000000).toFixed(1)}M`
                    : `${(alert.positionValueUsd / 1000).toFixed(0)}K`
                  }</span>
                  <span>·</span>
                  <span>{timeAgo(alert.detectedAt)}</span>
                  {alert.accountValue > 0 && (
                    <>
                      <span>·</span>
                      <span title="Trader account value">
                        Acct: ${alert.accountValue >= 1000000
                          ? `${(alert.accountValue / 1000000).toFixed(1)}M`
                          : `${(alert.accountValue / 1000).toFixed(0)}K`
                        }
                      </span>
                    </>
                  )}
                </div>
              </div>
              <div className="flex gap-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                {onCopy && (
                  <button
                    onClick={() => onCopy(alert.whaleAddress)}
                    className="px-2 py-0.5 rounded text-[10px] font-medium bg-[var(--hl-accent)] text-[var(--background)] hover:brightness-110"
                  >
                    Copy Trader
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {!expanded && alerts.length > 6 && (
        <div className="text-[10px] text-[var(--hl-muted)] text-center py-1 shrink-0">Click to see all {alerts.length} alerts</div>
      )}
    </div>
    {/* Expanded modal */}
    {expanded && (
      <div className="fixed inset-0 z-[9998] flex items-center justify-center" onClick={() => setExpanded(false)}>
        <div className="absolute inset-0 bg-black/50" />
        <div className="relative bg-[var(--background)] border border-[var(--hl-border)] rounded-lg shadow-2xl w-[90vw] max-w-[600px] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between p-3 border-b border-[var(--hl-border)] shrink-0">
            <h2 className="text-[13px] font-medium text-[var(--hl-accent)] uppercase tracking-wider">Whale Alerts</h2>
            <button onClick={() => setExpanded(false)} className="text-[var(--hl-muted)] hover:text-[var(--foreground)] text-[16px]">&times;</button>
          </div>
          <div className="overflow-y-auto flex-1 space-y-0">
            {alerts.map((alert) => {
              const resolvedType = alert.eventType === "flip" ? (alert.newSize > 0 ? "flip_long" : "flip_short") : alert.eventType;
              const evt = EVENT_LABELS[resolvedType] || { label: alert.eventType, color: "text-[var(--hl-text)]" };
              const isAddedOrTrimmed = ["added", "trimmed", "increase", "decrease"].includes(alert.eventType);
              const posDirection = alert.newSize > 0 ? "Long" : alert.newSize < 0 ? "Short" : "";
              const dirColor = alert.newSize > 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]";
              return (
                <div key={`exp-${alert.id}`} className="group flex items-start gap-2 py-1.5 px-3 border-b border-[var(--hl-border)] hover:bg-[var(--hl-surface-hover)] transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 text-[12px]">
                      <button onClick={(e) => { e.stopPropagation(); onSelectTrader?.(alert.whaleAddress); }} className="font-medium text-[var(--foreground)] truncate max-w-[120px] hover:text-[var(--hl-accent)]">{alert.whaleName}</button>
                      <span className={`font-medium ${evt.color}`}>{evt.label}</span>
                      {isAddedOrTrimmed && posDirection && <span className={`text-[10px] font-medium ${dirColor}`}>{posDirection}</span>}
                      <button onClick={() => onSelectToken(alert.coin)} className="font-medium text-[var(--foreground)] hover:text-[var(--hl-accent)]">{alert.coin.includes(":") ? alert.coin.split(":")[1] : alert.coin}</button>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-[var(--hl-muted)] mt-0.5">
                      <span>${alert.positionValueUsd >= 1000000 ? `${(alert.positionValueUsd / 1000000).toFixed(1)}M` : `${(alert.positionValueUsd / 1000).toFixed(0)}K`}</span>
                      <span>·</span>
                      <span>{timeAgo(alert.detectedAt)}</span>
                    </div>
                  </div>
                  {onCopy && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onCopy(alert.whaleAddress); }}
                      className="px-2 py-0.5 rounded text-[10px] font-medium bg-[var(--hl-accent)] text-[var(--background)] hover:brightness-110 shrink-0"
                    >
                      Copy Trader
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    )}
    </div>
  );
}
