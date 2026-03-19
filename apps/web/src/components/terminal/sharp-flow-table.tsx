"use client";

import type { SharpFlow } from "@/lib/api";
import { pnlColor } from "@/lib/utils";

interface SharpFlowTableProps {
  flows: SharpFlow[];
  onSelectToken: (coin: string) => void;
}

export function SharpFlowTable({ flows, onSelectToken }: SharpFlowTableProps) {
  if (!flows.length) {
    return (
      <div className="flex h-40 items-center justify-center text-[var(--hl-muted)] text-[13px]">
        Loading smart money data...
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-[13px] font-medium text-[var(--hl-muted)] uppercase tracking-wider mb-2 px-1">
        Sharp Flow
      </h2>
      <div className="overflow-y-auto max-h-[calc(50vh-60px)]">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-[var(--hl-border)] text-[var(--hl-muted)]">
              <th className="py-1.5 px-2 text-left font-normal">Token</th>
              <th className="py-1.5 px-2 text-right font-normal">Price</th>
              <th className="py-1.5 px-2 text-right font-normal">24h</th>
              <th className="py-1.5 px-2 text-center font-normal">Sharp Str.</th>
              <th className="py-1.5 px-2 text-center font-normal">Square Str.</th>
              <th className="py-1.5 px-2 text-right font-normal">Score</th>
            </tr>
          </thead>
          <tbody>
            {flows.map((f) => {
              let scoreColor = "text-[var(--hl-muted)]";
              if (f.score !== null) {
                if (f.score >= 70) scoreColor = "text-[var(--hl-green)]";
                else if (f.score <= 30) scoreColor = "text-[var(--hl-red)]";
                else scoreColor = "text-[var(--hl-text)]";
              }

              const sharpColor = f.sharpDirection === "long" ? "text-[var(--hl-green)]" : f.sharpDirection === "short" ? "text-[var(--hl-red)]" : "text-[var(--hl-muted)]";
              const squareColor = f.squareDirection === "long" ? "text-[var(--hl-green)]" : f.squareDirection === "short" ? "text-[var(--hl-red)]" : "text-[var(--hl-muted)]";

              return (
                <tr
                  key={f.coin}
                  className="border-b border-[var(--hl-border)] hover:bg-[var(--hl-surface-hover)] cursor-pointer transition-colors"
                  onClick={() => onSelectToken(f.coin)}
                >
                  <td className="py-1.5 px-2">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-[var(--foreground)]">{f.coin}</span>
                      {f.divergence && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-[#f058581a] text-[var(--hl-red)] font-medium">
                          DIV
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-1.5 px-2 text-right text-[var(--hl-text)] tabular-nums">
                    ${f.price >= 1 ? f.price.toLocaleString(undefined, { maximumFractionDigits: 2 }) : f.price.toPrecision(4)}
                  </td>
                  <td className={`py-1.5 px-2 text-right tabular-nums ${pnlColor(f.change24h)}`}>
                    {f.change24h >= 0 ? "+" : ""}{f.change24h.toFixed(2)}%
                  </td>
                  {/* Sharp Strength */}
                  <td className="py-1.5 px-2">
                    <div className="flex items-center gap-1.5 justify-center">
                      <div className="w-10 h-1.5 rounded-full bg-[var(--hl-border)] overflow-hidden">
                        <div
                          className={`h-full rounded-full ${f.sharpDirection === "long" ? "bg-[var(--hl-green)]" : f.sharpDirection === "short" ? "bg-[var(--hl-red)]" : "bg-[var(--hl-muted)]"}`}
                          style={{ width: `${f.sharpStrength}%` }}
                        />
                      </div>
                      <span className={`text-[10px] tabular-nums font-medium ${sharpColor}`}>
                        {f.sharpStrength > 0 ? `${f.sharpDirection === "long" ? "L" : f.sharpDirection === "short" ? "S" : "—"} ${f.sharpStrength}` : "—"}
                      </span>
                    </div>
                  </td>
                  {/* Square Strength */}
                  <td className="py-1.5 px-2">
                    <div className="flex items-center gap-1.5 justify-center">
                      <div className="w-10 h-1.5 rounded-full bg-[var(--hl-border)] overflow-hidden">
                        <div
                          className={`h-full rounded-full ${f.squareDirection === "long" ? "bg-[var(--hl-green)]" : f.squareDirection === "short" ? "bg-[var(--hl-red)]" : "bg-[var(--hl-muted)]"}`}
                          style={{ width: `${f.squareStrength}%` }}
                        />
                      </div>
                      <span className={`text-[10px] tabular-nums font-medium ${squareColor}`}>
                        {f.squareStrength > 0 ? `${f.squareDirection === "long" ? "L" : f.squareDirection === "short" ? "S" : "—"} ${f.squareStrength}` : "—"}
                      </span>
                    </div>
                  </td>
                  <td className={`py-1.5 px-2 text-right tabular-nums font-medium ${scoreColor}`}>
                    {f.score !== null ? f.score : "—"}
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
