"use client";

import { useState } from "react";
import type { OptionsSnapshot } from "@/lib/api";

interface DeriveOptionsPanelProps {
  options: Record<string, OptionsSnapshot>;
}

function formatUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function formatOI(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(1);
}

const COIN_ORDER = ["BTC", "ETH", "SOL", "HYPE"];

function GexBadge({ level }: { level: string }) {
  const color = level === "dampening" ? "text-[var(--hl-green)]" : level === "amplifying" ? "text-[var(--hl-red)]" : "text-[var(--hl-muted)]";
  const bg = level === "dampening" ? "bg-[var(--hl-green)]/10" : level === "amplifying" ? "bg-[var(--hl-red)]/10" : "bg-[var(--hl-surface)]";
  return <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium uppercase ${color} ${bg}`}>{level}</span>;
}

function CoinCard({ coin, data }: { coin: string; data: OptionsSnapshot }) {
  const pcColor = data.putCallRatio > 1.2 ? "text-[var(--hl-red)]" : data.putCallRatio < 0.8 ? "text-[var(--hl-green)]" : "text-[var(--foreground)]";
  const skewColor = data.skew25d > 3 ? "text-[var(--hl-red)]" : data.skew25d < -3 ? "text-[var(--hl-green)]" : "text-[var(--foreground)]";
  const maxPainDir = data.maxPainDistance > 0 ? "text-[var(--hl-green)]" : data.maxPainDistance < 0 ? "text-[var(--hl-red)]" : "text-[var(--foreground)]";

  return (
    <div className="bg-[var(--background)] p-2.5 space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-semibold text-[var(--foreground)]">{coin}</span>
        <GexBadge level={data.gexLevel} />
      </div>

      {/* Key metrics 2x3 grid */}
      <div className="grid grid-cols-3 gap-x-3 gap-y-1.5 text-[10px]">
        <div>
          <div className="text-[var(--hl-muted)]">IV (DVOL)</div>
          <div className="text-[var(--foreground)] font-medium tabular-nums">{data.dvol.toFixed(1)}%</div>
        </div>
        <div>
          <div className="text-[var(--hl-muted)]">IV Rank</div>
          <div className={`font-medium tabular-nums ${data.ivRank > 70 ? "text-[var(--hl-red)]" : data.ivRank < 30 ? "text-[var(--hl-green)]" : "text-[var(--foreground)]"}`}>
            {data.ivRank}%
          </div>
        </div>
        <div>
          <div className="text-[var(--hl-muted)]">P/C Ratio</div>
          <div className={`font-medium tabular-nums ${pcColor}`}>{data.putCallRatio.toFixed(2)}</div>
        </div>
        <div>
          <div className="text-[var(--hl-muted)]">Max Pain</div>
          <div className="text-[var(--foreground)] font-medium tabular-nums">${data.maxPain.toLocaleString()}</div>
        </div>
        <div>
          <div className="text-[var(--hl-muted)]">Distance</div>
          <div className={`font-medium tabular-nums ${maxPainDir}`}>
            {data.maxPainDistance > 0 ? "+" : ""}{data.maxPainDistance.toFixed(1)}%
          </div>
        </div>
        <div>
          <div className="text-[var(--hl-muted)]">25d Skew</div>
          <div className={`font-medium tabular-nums ${skewColor}`}>
            {data.skew25d > 0 ? "+" : ""}{data.skew25d.toFixed(1)}
          </div>
        </div>
      </div>

      {/* GEX value */}
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-[var(--hl-muted)]">GEX</span>
        <span className={`font-medium tabular-nums ${data.gex > 0 ? "text-[var(--hl-green)]" : data.gex < 0 ? "text-[var(--hl-red)]" : "text-[var(--foreground)]"}`}>
          {data.gex > 0 ? "+" : ""}{data.gex.toFixed(1)}M
        </span>
      </div>

      {/* OI bar */}
      <div className="text-[10px]">
        <div className="flex justify-between text-[var(--hl-muted)] mb-0.5">
          <span>Calls {formatOI(data.totalCallOI)}</span>
          <span>Puts {formatOI(data.totalPutOI)}</span>
        </div>
        <div className="h-1.5 flex rounded-full overflow-hidden bg-[var(--hl-surface)]">
          <div
            className="bg-[var(--hl-green)] transition-all"
            style={{ width: `${((data.totalCallOI / (data.totalCallOI + data.totalPutOI)) * 100) || 50}%` }}
          />
          <div
            className="bg-[var(--hl-red)] transition-all"
            style={{ width: `${((data.totalPutOI / (data.totalCallOI + data.totalPutOI)) * 100) || 50}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function StrikesTable({ options }: { options: Record<string, OptionsSnapshot> }) {
  // Aggregate top strikes across all coins
  const allStrikes: { coin: string; strike: number; callOI: number; putOI: number; totalOI: number }[] = [];
  for (const [coin, data] of Object.entries(options)) {
    for (const s of data.topStrikes || []) {
      allStrikes.push({ coin, strike: s.strike, callOI: s.callOI, putOI: s.putOI, totalOI: s.callOI + s.putOI });
    }
  }
  allStrikes.sort((a, b) => b.totalOI - a.totalOI);

  if (allStrikes.length === 0) return null;

  return (
    <div>
      <h3 className="text-[10px] font-medium text-[var(--hl-accent)] uppercase tracking-wider mb-1.5 px-1">
        Top Strikes by OI
      </h3>
      <div className="overflow-hidden">
        <div className="flex items-center px-2 py-1 text-[10px] text-[var(--hl-muted)] uppercase tracking-wider border-b border-[var(--hl-border)]">
          <span className="w-12">Coin</span>
          <span className="w-20">Strike</span>
          <span className="flex-1 text-right">Call OI</span>
          <span className="flex-1 text-right">Put OI</span>
          <span className="w-14 text-right">Bias</span>
        </div>
        {allStrikes.slice(0, 12).map((s, i) => {
          const bias = s.callOI > s.putOI ? "CALL" : "PUT";
          const biasColor = bias === "CALL" ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]";
          return (
            <div key={`${s.coin}-${s.strike}-${i}`} className="flex items-center px-2 py-1 text-[11px] border-b border-[var(--hl-border)]">
              <span className="w-12 font-medium text-[var(--foreground)]">{s.coin}</span>
              <span className="w-20 tabular-nums text-[var(--foreground)]">${s.strike.toLocaleString()}</span>
              <span className="flex-1 text-right tabular-nums text-[var(--hl-green)]">{formatOI(s.callOI)}</span>
              <span className="flex-1 text-right tabular-nums text-[var(--hl-red)]">{formatOI(s.putOI)}</span>
              <span className={`w-14 text-right font-medium text-[10px] ${biasColor}`}>{bias}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function DeriveOptionsPanel({ options }: DeriveOptionsPanelProps) {
  const coins = COIN_ORDER.filter(c => options[c]);

  if (coins.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-[var(--hl-muted)] text-[11px]">
        Loading Derive options data...
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-[13px] font-medium text-[var(--hl-accent)] uppercase tracking-wider px-1">
        Derive Options — IV &amp; Greeks
      </h2>

      {/* Coin cards grid */}
      <div className="grid grid-cols-2 gap-px bg-[var(--hl-border)]">
        {coins.map(coin => (
          <CoinCard key={coin} coin={coin} data={options[coin]} />
        ))}
      </div>

      {/* Top strikes table */}
      <StrikesTable options={options} />
    </div>
  );
}
