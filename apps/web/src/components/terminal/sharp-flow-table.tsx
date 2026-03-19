"use client";

import type { SharpFlow } from "@/lib/api";
import { formatUsd, pnlColor } from "@/lib/utils";

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
              <th className="py-1.5 px-2 text-center font-normal">Sharps</th>
              <th className="py-1.5 px-2 text-center font-normal">Direction</th>
              <th className="py-1.5 px-2 text-right font-normal">Score</th>
            </tr>
          </thead>
          <tbody>
            {flows.map((f) => {
              const totalSharps = f.sharpLongCount + f.sharpShortCount;
              const longPct = totalSharps > 0 ? (f.sharpLongCount / totalSharps) * 100 : 50;
              const isLong = longPct > 50;

              let scoreColor = "text-[var(--hl-muted)]";
              if (f.score !== null) {
                if (f.score >= 70) scoreColor = "text-[var(--hl-green)]";
                else if (f.score <= 30) scoreColor = "text-[var(--hl-red)]";
                else scoreColor = "text-[var(--hl-text)]";
              }

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
                  <td className="py-1.5 px-2 text-center">
                    <span className="text-[var(--hl-green)]">{f.sharpLongCount}</span>
                    <span className="text-[var(--hl-muted)] mx-0.5">/</span>
                    <span className="text-[var(--hl-red)]">{f.sharpShortCount}</span>
                  </td>
                  <td className="py-1.5 px-2">
                    <div className="flex items-center gap-1">
                      <div className="flex-1 h-1.5 rounded-full bg-[var(--hl-red)] overflow-hidden">
                        <div
                          className="h-full bg-[var(--hl-green)] rounded-full"
                          style={{ width: `${longPct}%` }}
                        />
                      </div>
                      <span className={`text-[10px] tabular-nums ${isLong ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                        {Math.round(isLong ? longPct : 100 - longPct)}%
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
