"use client";

import { useState } from "react";
import type { TradingSignal, FundingOpportunity, SharpSquareCallout } from "@/lib/api";

/** Strip dex prefix from coin names (e.g. "xyz:GOLD" -> "GOLD") */
const displayCoin = (c: string) => c.includes(":") ? c.split(":")[1] : c;

interface SignalsPanelProps {
  signals: TradingSignal[];
  fundingOpps: FundingOpportunity[];
  callout: SharpSquareCallout | null;
  onSelectToken: (coin: string) => void;
}

function StrengthBolt({ strength }: { strength: number }) {
  const color = strength >= 70 ? "text-yellow-400 bg-yellow-500/15" : strength >= 40 ? "text-[var(--hl-accent)] bg-[var(--hl-accent)]/10" : "text-[var(--hl-muted)] bg-[var(--hl-surface)]";
  return (
    <span className={`text-[9px] px-1 py-0.5 rounded font-medium tabular-nums ${color}`}>
      ⚡{strength}
    </span>
  );
}

function FlowTooltip() {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-block">
      <button onClick={() => setOpen(!open)} className="text-[var(--hl-muted)] hover:text-[var(--foreground)] transition-colors text-[9px] ml-1" title="What is this?">ⓘ</button>
      {open && (
        <div className="absolute left-0 top-5 z-50 w-52 p-2 rounded border border-[var(--hl-border)] bg-[var(--hl-surface)] text-[10px] text-[var(--hl-text)] shadow-lg leading-relaxed">
          <p className="font-medium text-[var(--foreground)] mb-1">Sharps vs Squares</p>
          <p><strong>Sharps</strong> = top traders by ROI &amp; consistency. <strong>Squares</strong> = retail/lower-performing traders.</p>
          <p className="mt-1">⚡ = conviction strength (0-100) based on agreement, trader count, and position size.</p>
          <p className="mt-1 text-[var(--hl-muted)]">When sharps and squares disagree, sharps tend to be right.</p>
          <button onClick={() => setOpen(false)} className="absolute top-1 right-1.5 text-[var(--hl-muted)] hover:text-[var(--foreground)]">&times;</button>
        </div>
      )}
    </span>
  );
}

type FlowItem = { side: "LONG" | "SHORT"; coin: string; strength: number };

function FlowColumn({ title, items, onSelectToken, accent }: {
  title: string;
  items: FlowItem[];
  onSelectToken: (coin: string) => void;
  accent: string;
}) {
  return (
    <div className="bg-[var(--background)] p-2 min-w-0">
      <h3 className="text-[10px] font-medium uppercase tracking-wider mb-1.5 px-1" style={{ color: accent }}>
        {title}
        {title.includes("Sharps") && <FlowTooltip />}
      </h3>
      <div className="space-y-0.5">
        {items.length === 0 ? (
          <p className="text-[11px] text-[var(--hl-muted)] px-1">No signals</p>
        ) : (
          items.map((item, i) => (
            <button
              key={i}
              onClick={() => onSelectToken(item.coin)}
              className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-[var(--hl-surface-hover)] transition-colors text-[12px]"
            >
              <span className={`font-bold w-4 ${item.side === "LONG" ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                {item.side === "LONG" ? "L" : "S"}
              </span>
              <span className="font-medium text-[var(--foreground)]">{displayCoin(item.coin)}</span>
              <span className="ml-auto"><StrengthBolt strength={item.strength} /></span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

export function SignalsPanel({ signals, fundingOpps, callout, onSelectToken }: SignalsPanelProps) {
  // Build sharps and squares flow items separately
  const sharpItems: FlowItem[] = [];
  const squareItems: FlowItem[] = [];

  if (callout) {
    for (const item of callout.sharpLongs || []) sharpItems.push({ side: "LONG", coin: item.coin, strength: item.strength });
    for (const item of callout.sharpShorts || []) sharpItems.push({ side: "SHORT", coin: item.coin, strength: item.strength });
    for (const item of callout.squareLongs || []) squareItems.push({ side: "LONG", coin: item.coin, strength: item.strength });
    for (const item of callout.squareShorts || []) squareItems.push({ side: "SHORT", coin: item.coin, strength: item.strength });

    // Fallback to old fields if new arrays are empty
    if (sharpItems.length === 0 && squareItems.length === 0) {
      if (callout.sharpTopLong) sharpItems.push({ side: "LONG", coin: callout.sharpTopLong.coin, strength: callout.sharpTopLong.pct });
      if (callout.sharpTopShort) sharpItems.push({ side: "SHORT", coin: callout.sharpTopShort.coin, strength: callout.sharpTopShort.pct });
      if (callout.squareTopLong) squareItems.push({ side: "LONG", coin: callout.squareTopLong.coin, strength: callout.squareTopLong.pct });
      if (callout.squareTopShort) squareItems.push({ side: "SHORT", coin: callout.squareTopShort.coin, strength: callout.squareTopShort.pct });
    }
  }

  sharpItems.sort((a, b) => b.strength - a.strength);
  squareItems.sort((a, b) => b.strength - a.strength);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-px bg-[var(--hl-border)]">
      {/* Sharps Flow */}
      <FlowColumn title="Sharps Flow" items={sharpItems} onSelectToken={onSelectToken} accent="var(--hl-accent)" />

      {/* Squares Flow */}
      <FlowColumn title="Squares Flow" items={squareItems} onSelectToken={onSelectToken} accent="var(--hl-muted)" />

      {/* Funding Arbitrage */}
      <div className="bg-[var(--background)] p-2">
        <h3 className="text-[10px] font-medium text-[var(--hl-accent)] uppercase tracking-wider mb-1.5 px-1">
          Funding Arbitrage
        </h3>
        <div className="space-y-0.5">
          {fundingOpps.length === 0 ? (
            <p className="text-[11px] text-[var(--hl-muted)] px-1">No opportunities</p>
          ) : (
            fundingOpps.slice(0, 8).map((f) => (
              <button
                key={f.coin}
                onClick={() => onSelectToken(f.coin)}
                className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-[var(--hl-surface-hover)] transition-colors text-[12px]"
              >
                <span className={`font-bold w-4 ${f.direction === "long" ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                  {f.direction === "long" ? "L" : "S"}
                </span>
                <span className="font-medium text-[var(--foreground)] w-16">{displayCoin(f.coin)}</span>
                <span className={`tabular-nums font-semibold ${Math.abs(f.annualizedPct) > 100 ? "text-[var(--hl-green)]" : "text-[var(--foreground)]"}`}>
                  {Math.abs(f.annualizedPct).toFixed(0)}% APR
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Trading Signals */}
      <div className="bg-[var(--background)] p-2">
        <h3 className="text-[10px] font-medium text-[var(--hl-accent)] uppercase tracking-wider mb-1.5 px-1">
          Signals
        </h3>
        <div className="space-y-0.5">
          {signals.length === 0 ? (
            <p className="text-[11px] text-[var(--hl-muted)] px-1">No active signals</p>
          ) : (
            signals.slice(0, 8).map((s, i) => (
              <button
                key={i}
                onClick={() => onSelectToken(s.coin)}
                className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-[var(--hl-surface-hover)] transition-colors text-[12px]"
              >
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                  s.severity === "critical" ? "bg-[var(--hl-red)] text-white" :
                  s.severity === "warning" ? "bg-yellow-600 text-white" :
                  "bg-[var(--hl-surface)] text-[var(--hl-muted)]"
                }`}>
                  {s.severity === "critical" ? "!!" : s.severity === "warning" ? "!" : "~"}
                </span>
                <span className="font-medium text-[var(--foreground)] w-16">{displayCoin(s.coin)}</span>
                <span className="text-[var(--foreground)] truncate">{s.title.replace(/^\w+:/, "")}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
