"use client";

import type { TokenDetail, WhaleAccumulation } from "@/lib/api";

const displayCoin = (c: string) => c.includes(":") ? c.split(":")[1] : c;

function formatUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function StrengthBolt({ strength }: { strength: number }) {
  const color = strength >= 70 ? "text-yellow-400" : strength >= 40 ? "text-[var(--hl-accent)]" : "text-[var(--hl-muted)]";
  return <span className={`text-[9px] font-medium tabular-nums ${color}`}>⚡{strength}</span>;
}

interface Props {
  detail: TokenDetail | null;
  coin: string;
}

export function CoinIntelPanel({ detail, coin }: Props) {
  if (!detail) return null;

  const flow = detail.coinFlow;
  const accum = detail.coinAccumulation;
  const whaleCount = detail.whaleAlerts?.length || 0;
  const sharpCount = detail.sharpPositions?.length || 0;
  const hasData = flow || accum || whaleCount > 0 || sharpCount > 0;

  if (!hasData) return null;

  return (
    <div className="px-3 py-2 border-b border-[var(--hl-border)] bg-[var(--background)]">
      <div className="flex items-center gap-3 flex-wrap text-[11px]">
        {/* Sharp/Square positioning */}
        {flow && (
          <>
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] text-[var(--hl-muted)] uppercase">Sharps</span>
              <span className={`font-bold ${flow.sharpDirection === "long" ? "text-[var(--hl-green)]" : flow.sharpDirection === "short" ? "text-[var(--hl-red)]" : "text-[var(--hl-muted)]"}`}>
                {flow.sharpDirection === "long" ? "LONG" : flow.sharpDirection === "short" ? "SHORT" : "—"}
              </span>
              <span className="text-[var(--hl-muted)] tabular-nums">{flow.sharpLongCount}L/{flow.sharpShortCount}S</span>
              <StrengthBolt strength={flow.sharpStrength} />
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-[9px] text-[var(--hl-muted)] uppercase">Squares</span>
              <span className={`font-bold ${flow.squareDirection === "long" ? "text-[var(--hl-green)]" : flow.squareDirection === "short" ? "text-[var(--hl-red)]" : "text-[var(--hl-muted)]"}`}>
                {flow.squareDirection === "long" ? "LONG" : flow.squareDirection === "short" ? "SHORT" : "—"}
              </span>
              <span className="text-[var(--hl-muted)] tabular-nums">{flow.squareLongCount}L/{flow.squareShortCount}S</span>
              <StrengthBolt strength={flow.squareStrength} />
            </div>

            {flow.divergence && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-400 font-medium">
                DIVERGENCE
              </span>
            )}

            {flow.consensus && flow.consensus !== "neutral" && (
              <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
                flow.consensus.includes("long") ? "bg-[var(--hl-green)]/15 text-[var(--hl-green)]" : "bg-[var(--hl-red)]/15 text-[var(--hl-red)]"
              }`}>
                {flow.consensus.replace("_", " ").toUpperCase()}
              </span>
            )}
          </>
        )}

        {/* Separator */}
        {flow && (accum || whaleCount > 0 || sharpCount > 0) && (
          <span className="text-[var(--hl-border)]">|</span>
        )}

        {/* Whale accumulation for this coin */}
        {accum && (
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] text-[var(--hl-muted)] uppercase">Whales</span>
            <span className={`font-medium tabular-nums ${accum.net24h > 0 ? "text-[var(--hl-green)]" : accum.net24h < 0 ? "text-[var(--hl-red)]" : "text-[var(--hl-muted)]"}`}>
              {accum.net24h > 0 ? "+" : ""}{formatUsd(accum.net24h)} 24h
            </span>
            <span className={`text-[9px] px-1 py-0.5 rounded font-medium ${
              accum.trend === "accumulating" ? "bg-[var(--hl-green)]/15 text-[var(--hl-green)]" :
              accum.trend === "distributing" ? "bg-[var(--hl-red)]/15 text-[var(--hl-red)]" :
              "bg-[var(--hl-surface)] text-[var(--hl-muted)]"
            }`}>
              {accum.trend === "accumulating" ? "ACCUM" : accum.trend === "distributing" ? "DIST" : "FLAT"}
            </span>
            <span className="text-[var(--hl-muted)] text-[9px]">{accum.whales24h}w</span>
          </div>
        )}

        {/* Sharp trader count + whale event count */}
        {sharpCount > 0 && (
          <span className="text-[var(--hl-muted)]">
            {sharpCount} sharp{sharpCount !== 1 ? "s" : ""} positioned
          </span>
        )}
        {whaleCount > 0 && (
          <span className="text-[var(--hl-muted)]">
            {whaleCount} whale event{whaleCount !== 1 ? "s" : ""}
          </span>
        )}

        {/* Funding regime */}
        {detail.fundingRegime && (
          <>
            <span className="text-[var(--hl-border)]">|</span>
            <span className="text-[var(--hl-muted)] text-[10px] truncate max-w-[300px]" title={detail.fundingRegime}>
              {detail.fundingRegime}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
