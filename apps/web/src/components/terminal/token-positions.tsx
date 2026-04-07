"use client";

import type { TraderPosition } from "@/lib/api";
import { formatUsd, pnlColor } from "@/lib/utils";

interface TokenPositionsProps {
  positions: TraderPosition[];
  onCopy?: (address: string) => void;
  onFade?: (address: string) => void;
}

export function TokenPositions({ positions, onCopy, onFade }: TokenPositionsProps) {
  const longs = positions.filter(p => p.side === "long");
  const shorts = positions.filter(p => p.side === "short");
  const totalLong = longs.length;
  const totalShort = shorts.length;
  const total = totalLong + totalShort;
  const longPct = total > 0 ? (totalLong / total) * 100 : 50;

  return (
    <div>
      <h3 className="text-[11px] font-medium text-[var(--hl-muted)] uppercase tracking-wider mb-2">
        Sharp Positions ({positions.length})
      </h3>

      {/* Long/Short bar */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[11px] text-[var(--hl-green)]">{totalLong} Long</span>
        <div className="flex-1 h-2 rounded-full bg-[var(--hl-red)] overflow-hidden">
          <div className="h-full bg-[var(--hl-green)] rounded-full" style={{ width: `${longPct}%` }} />
        </div>
        <span className="text-[11px] text-[var(--hl-red)]">{totalShort} Short</span>
      </div>

      {/* Position list */}
      <div className="space-y-0 max-h-[300px] overflow-y-auto">
        {positions.map((pos, i) => (
          <div
            key={`${pos.address}-${i}`}
            className="group flex items-center gap-2 py-1.5 px-1 border-b border-[var(--hl-border)] hover:bg-[var(--hl-surface-hover)] transition-colors text-[11px]"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-[var(--foreground)] truncate max-w-[110px]">
                  {pos.displayName}
                </span>
                <span className={`px-1 py-0 rounded text-[9px] font-medium ${
                  pos.side === "long"
                    ? "bg-[#5dea8d1a] text-[var(--hl-green)]"
                    : "bg-[#f058581a] text-[var(--hl-red)]"
                }`}>
                  {pos.side.toUpperCase()}
                </span>
                {pos.isSharp && (
                  <span className="text-[8px] px-1 py-0 rounded bg-[var(--hl-accent)] text-[var(--background)] font-bold">
                    S
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 text-[var(--hl-muted)] mt-0.5">
                <span>${(pos.positionValue / 1000).toFixed(0)}K</span>
                <span>·</span>
                <span>Entry ${pos.entryPx >= 1 ? pos.entryPx.toLocaleString(undefined, { maximumFractionDigits: 2 }) : pos.entryPx.toPrecision(4)}</span>
                {pos.leverage > 0 && (
                  <>
                    <span>·</span>
                    <span>{pos.leverage}x</span>
                  </>
                )}
              </div>
            </div>
            <div className={`text-right tabular-nums ${pnlColor(pos.unrealizedPnl)}`}>
              {formatUsd(pos.unrealizedPnl)}
            </div>
            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              {onCopy && (
                <button
                  onClick={() => onCopy(pos.address)}
                  className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-[var(--hl-accent)] text-[var(--background)]"
                >
                  Copy
                </button>
              )}
              {onFade && (
                <button
                  onClick={() => onFade(pos.address)}
                  className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-[var(--hl-red)] text-white"
                >
                  Fade
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
