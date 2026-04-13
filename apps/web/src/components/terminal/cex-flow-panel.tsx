"use client";

import type { CexFlowSummary } from "@/lib/api";

function formatUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

interface Props {
  data: CexFlowSummary | null;
}

export function CexFlowPanel({ data }: Props) {
  if (!data) {
    return (
      <div>
        <h3 className="text-[10px] font-medium text-[var(--hl-accent)] uppercase tracking-wider mb-1.5 px-1">
          CEX Flows
        </h3>
        <p className="text-[11px] text-[var(--hl-muted)] px-1">
          Set WHALE_ALERT_API_KEY to enable CEX flow tracking.
          <br />
          <span className="text-[9px]">Free at whale-alert.io — tracks $500K+ deposits/withdrawals to exchanges.</span>
        </p>
      </div>
    );
  }

  const netIsDeposit = data.netFlowUsd1h > 0;

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-[10px] font-medium text-[var(--hl-accent)] uppercase tracking-wider px-1">
          CEX Flows (1h)
        </h3>
        <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
          netIsDeposit ? "bg-[var(--hl-red)]/15 text-[var(--hl-red)]" : "bg-[var(--hl-green)]/15 text-[var(--hl-green)]"
        }`}>
          NET {netIsDeposit ? "DEPOSIT" : "WITHDRAWAL"}
        </span>
      </div>

      {/* Summary */}
      <div className="flex gap-4 px-1 text-[10px] mb-2">
        <span className="text-[var(--hl-muted)]">
          Deposits: <span className="text-[var(--hl-red)] font-medium">{formatUsd(data.totalDepositsUsd1h)}</span>
        </span>
        <span className="text-[var(--hl-muted)]">
          Withdrawals: <span className="text-[var(--hl-green)] font-medium">{formatUsd(data.totalWithdrawalsUsd1h)}</span>
        </span>
        <span className="text-[var(--hl-muted)]">
          Net: <span className={`font-bold ${netIsDeposit ? "text-[var(--hl-red)]" : "text-[var(--hl-green)]"}`}>
            {netIsDeposit ? "" : "+"}{formatUsd(-data.netFlowUsd1h)}
          </span>
        </span>
      </div>

      {/* Per-coin breakdown */}
      {data.byCoin.length > 0 && (
        <div className="mb-2">
          <div className="text-[9px] text-[var(--hl-muted)] uppercase tracking-wider px-1 mb-1">By Coin</div>
          <div className="flex flex-wrap gap-1.5 px-1">
            {data.byCoin.slice(0, 8).map(c => (
              <span key={c.symbol} className={`text-[10px] px-1.5 py-0.5 rounded border border-[var(--hl-border)] ${
                c.net > 0 ? "text-[var(--hl-red)]" : "text-[var(--hl-green)]"
              }`}>
                {c.symbol} {c.net > 0 ? "↓" : "↑"}{formatUsd(Math.abs(c.net))}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Recent large transfers */}
      {data.recentTransfers.length > 0 && (
        <div>
          <div className="text-[9px] text-[var(--hl-muted)] uppercase tracking-wider px-1 mb-1">Recent Transfers</div>
          <div className="space-y-0.5">
            {data.recentTransfers.slice(0, 8).map((t, i) => (
              <div key={i} className="flex items-center gap-1.5 text-[10px] px-1 py-0.5">
                <span className={`font-bold ${t.direction === "deposit" ? "text-[var(--hl-red)]" : "text-[var(--hl-green)]"}`}>
                  {t.direction === "deposit" ? "→" : "←"}
                </span>
                <span className="text-[var(--foreground)] font-medium w-10">{t.symbol}</span>
                <span className="text-[var(--foreground)] tabular-nums font-medium">{formatUsd(t.amountUsd)}</span>
                <span className="text-[var(--hl-muted)] truncate ml-auto">
                  {t.direction === "deposit" ? `→ ${t.to.owner}` : `← ${t.from.owner}`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
