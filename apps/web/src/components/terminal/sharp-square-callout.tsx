"use client";

import type { SharpSquareCallout } from "@/lib/api";

interface SharpSquareCalloutProps {
  callout: SharpSquareCallout | null;
  onSelectToken: (coin: string) => void;
}

export function SharpSquareCalloutPanel({ callout, onSelectToken }: SharpSquareCalloutProps) {
  if (!callout) {
    return (
      <div className="flex h-20 items-center justify-center text-[var(--hl-muted)] text-[12px]">
        Analyzing positions...
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-px bg-[var(--hl-border)]">
      {/* Sharps */}
      <div className="bg-[var(--background)] p-3">
        <h3 className="text-[11px] font-medium text-[var(--hl-muted)] uppercase tracking-wider mb-2">
          Sharps
        </h3>
        <div className="space-y-2">
          {callout.sharpTopLong && (
            <button
              onClick={() => onSelectToken(callout.sharpTopLong!.coin)}
              className="w-full text-left flex items-center gap-2 rounded px-2 py-1.5 hover:bg-[var(--hl-surface-hover)] transition-colors"
            >
              <span className="text-[11px] font-bold text-[var(--hl-green)] uppercase">Long</span>
              <span className="text-[15px] font-semibold text-[var(--foreground)]">
                ${callout.sharpTopLong.coin}
              </span>
              <span className="text-[11px] text-[var(--hl-muted)] ml-auto">
                {callout.sharpTopLong.count} traders · {callout.sharpTopLong.pct}%
              </span>
            </button>
          )}
          {callout.sharpTopShort && (
            <button
              onClick={() => onSelectToken(callout.sharpTopShort!.coin)}
              className="w-full text-left flex items-center gap-2 rounded px-2 py-1.5 hover:bg-[var(--hl-surface-hover)] transition-colors"
            >
              <span className="text-[11px] font-bold text-[var(--hl-red)] uppercase">Short</span>
              <span className="text-[15px] font-semibold text-[var(--foreground)]">
                ${callout.sharpTopShort.coin}
              </span>
              <span className="text-[11px] text-[var(--hl-muted)] ml-auto">
                {callout.sharpTopShort.count} traders · {callout.sharpTopShort.pct}%
              </span>
            </button>
          )}
          {!callout.sharpTopLong && !callout.sharpTopShort && (
            <p className="text-[11px] text-[var(--hl-muted)]">No strong conviction</p>
          )}
        </div>
      </div>

      {/* Squares */}
      <div className="bg-[var(--background)] p-3">
        <h3 className="text-[11px] font-medium text-[var(--hl-muted)] uppercase tracking-wider mb-2">
          Squares
        </h3>
        <div className="space-y-2">
          {callout.squareTopLong && (
            <button
              onClick={() => onSelectToken(callout.squareTopLong!.coin)}
              className="w-full text-left flex items-center gap-2 rounded px-2 py-1.5 hover:bg-[var(--hl-surface-hover)] transition-colors"
            >
              <span className="text-[11px] font-bold text-[var(--hl-green)] uppercase">Long</span>
              <span className="text-[15px] font-semibold text-[var(--foreground)]">
                ${callout.squareTopLong.coin}
              </span>
              <span className="text-[11px] text-[var(--hl-muted)] ml-auto">
                {callout.squareTopLong.count} traders · {callout.squareTopLong.pct}%
              </span>
            </button>
          )}
          {callout.squareTopShort && (
            <button
              onClick={() => onSelectToken(callout.squareTopShort!.coin)}
              className="w-full text-left flex items-center gap-2 rounded px-2 py-1.5 hover:bg-[var(--hl-surface-hover)] transition-colors"
            >
              <span className="text-[11px] font-bold text-[var(--hl-red)] uppercase">Short</span>
              <span className="text-[15px] font-semibold text-[var(--foreground)]">
                ${callout.squareTopShort.coin}
              </span>
              <span className="text-[11px] text-[var(--hl-muted)] ml-auto">
                {callout.squareTopShort.count} traders · {callout.squareTopShort.pct}%
              </span>
            </button>
          )}
          {!callout.squareTopLong && !callout.squareTopShort && (
            <p className="text-[11px] text-[var(--hl-muted)]">No strong conviction</p>
          )}
        </div>
      </div>
    </div>
  );
}
