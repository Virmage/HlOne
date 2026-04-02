"use client";

import type { SharpSquareCallout } from "@/lib/api";

interface SharpSquareCalloutProps {
  callout: SharpSquareCallout | null;
  onSelectToken: (coin: string) => void;
}

export function SharpSquareCalloutPanel({ callout, onSelectToken }: SharpSquareCalloutProps) {
  if (!callout) return null;

  const items = [
    callout.sharpTopLong && { label: "Sharps", side: "LONG" as const, ...callout.sharpTopLong },
    callout.sharpTopShort && { label: "Sharps", side: "SHORT" as const, ...callout.sharpTopShort },
    callout.squareTopLong && { label: "Squares", side: "LONG" as const, ...callout.squareTopLong },
    callout.squareTopShort && { label: "Squares", side: "SHORT" as const, ...callout.squareTopShort },
  ].filter(Boolean) as { label: string; side: "LONG" | "SHORT"; coin: string; count: number; pct: number }[];

  if (items.length === 0) return null;

  return (
    <div className="flex items-center gap-4 px-3 py-1.5 border-b border-[var(--hl-border)] text-[11px]">
      {items.map((item, i) => (
        <button
          key={i}
          onClick={() => onSelectToken(item.coin)}
          className="flex items-center gap-1.5 hover:bg-[var(--hl-surface-hover)] rounded px-2 py-0.5 transition-colors"
        >
          <span className="text-[var(--hl-muted)] text-[10px]">{item.label}</span>
          <span className={`font-bold ${item.side === "LONG" ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
            {item.side === "LONG" ? "L" : "S"}
          </span>
          <span className="font-semibold text-[var(--foreground)]">{item.coin}</span>
          <span className="text-[var(--hl-muted)] tabular-nums">{item.count}</span>
          <span className="text-[var(--hl-muted)] tabular-nums">{item.pct}%</span>
        </button>
      ))}
    </div>
  );
}
