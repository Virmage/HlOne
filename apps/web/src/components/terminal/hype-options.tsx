"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import type { HypeOptionsChain, HypeOptionRow } from "@/lib/api";
import { getHypeOptionsChain } from "@/lib/api";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatPrice(val: number, decimals = 2): string {
  return val > 0 ? `$${val.toFixed(decimals)}` : "—";
}

function formatOI(val: number): string {
  if (val >= 1e6) return `${(val / 1e6).toFixed(1)}M`;
  if (val >= 1e3) return `${(val / 1e3).toFixed(0)}K`;
  return val.toFixed(0);
}

function formatGreek(val: number, decimals = 3): string {
  if (val === 0) return "—";
  return val.toFixed(decimals);
}

function ivColor(iv: number): string {
  if (iv > 120) return "text-[var(--hl-red)]";
  if (iv > 80) return "text-orange-400";
  return "text-[var(--hl-text)]";
}

// ─── Component ───────────────────────────────────────────────────────────────

interface HypeOptionsProps {
  isOpen: boolean;
  onClose: () => void;
}

export function HypeOptionsPanel({ isOpen, onClose }: HypeOptionsProps) {
  const [data, setData] = useState<HypeOptionsChain | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedExpiry, setSelectedExpiry] = useState<string | null>(null);
  const [showGreeks, setShowGreeks] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getHypeOptionsChain();
      setData(result);
      if (result?.expiries.length && !selectedExpiry) {
        setSelectedExpiry(result.expiries[0].label);
      }
    } catch (err) {
      console.error("[hype-options] Fetch failed:", err);
    } finally {
      setLoading(false);
    }
  }, [selectedExpiry]);

  useEffect(() => {
    if (isOpen) {
      fetchData();
      const interval = setInterval(fetchData, 30_000);
      return () => clearInterval(interval);
    }
  }, [isOpen, fetchData]);

  // Group by strike for the chain view
  const chainByStrike = useMemo(() => {
    if (!data?.chain || !selectedExpiry) return [];

    const filtered = data.chain.filter(o => o.expiry === selectedExpiry);
    const strikeMap = new Map<number, { call: HypeOptionRow | null; put: HypeOptionRow | null }>();

    for (const opt of filtered) {
      const existing = strikeMap.get(opt.strike) || { call: null, put: null };
      if (opt.type === "C") existing.call = opt;
      else existing.put = opt;
      strikeMap.set(opt.strike, existing);
    }

    return [...strikeMap.entries()]
      .sort(([a], [b]) => a - b)
      .map(([strike, opts]) => ({ strike, ...opts }));
  }, [data, selectedExpiry]);

  if (!isOpen) return null;

  const spotPrice = data?.spotPrice || 0;
  const summary = data?.summary;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative w-[95vw] max-w-[1200px] max-h-[90vh] bg-[var(--hl-bg)] border border-[var(--hl-border)] rounded-lg shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--hl-border)] bg-[var(--hl-surface)]">
          <div className="flex items-center gap-3">
            <h2 className="text-[14px] font-bold text-[var(--foreground)]">HYPE Options</h2>
            <span className="text-[11px] px-2 py-0.5 rounded bg-[rgba(168,85,247,0.15)] text-purple-400 font-medium">Derive</span>
            {spotPrice > 0 && (
              <span className="text-[12px] text-[var(--hl-text)] tabular-nums">${spotPrice.toFixed(2)}</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowGreeks(!showGreeks)}
              className={`text-[10px] px-2 py-1 rounded border transition-colors ${
                showGreeks
                  ? "border-purple-500/50 bg-purple-500/10 text-purple-400"
                  : "border-[var(--hl-border)] text-[var(--hl-muted)] hover:text-[var(--hl-text)]"
              }`}
            >
              Greeks
            </button>
            <button
              onClick={fetchData}
              className="text-[10px] text-[var(--hl-muted)] hover:text-[var(--hl-text)] transition-colors"
              title="Refresh"
            >
              {loading ? "..." : "Refresh"}
            </button>
            <button onClick={onClose} className="text-[var(--hl-muted)] hover:text-[var(--foreground)] transition-colors text-lg leading-none">&times;</button>
          </div>
        </div>

        {/* Summary bar */}
        {summary && (
          <div className="flex items-center gap-4 px-4 py-2 border-b border-[var(--hl-border)] bg-[var(--hl-surface)] text-[10px] flex-wrap">
            <div>
              <span className="text-[var(--hl-muted)]">Max Pain </span>
              <span className="text-[var(--foreground)] tabular-nums font-medium">${summary.maxPain.toLocaleString()}</span>
              <span className={`ml-1 tabular-nums ${summary.maxPainDistance > 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                {summary.maxPainDistance >= 0 ? "+" : ""}{summary.maxPainDistance.toFixed(1)}%
              </span>
            </div>
            <div>
              <span className="text-[var(--hl-muted)]">P/C </span>
              <span className={`tabular-nums font-medium ${summary.putCallRatio > 1 ? "text-[var(--hl-red)]" : "text-[var(--hl-green)]"}`}>
                {summary.putCallRatio.toFixed(2)}
              </span>
            </div>
            <div>
              <span className="text-[var(--hl-muted)]">IV </span>
              <span className={`tabular-nums font-medium ${ivColor(summary.iv)}`}>{summary.iv.toFixed(0)}%</span>
            </div>
            <div>
              <span className="text-[var(--hl-muted)]">IV Rank </span>
              <span className={`tabular-nums ${summary.ivRank > 70 ? "text-[var(--hl-red)]" : summary.ivRank < 30 ? "text-[var(--hl-green)]" : "text-[var(--hl-muted)]"}`}>
                {summary.ivRank}%
              </span>
            </div>
            <div>
              <span className="text-[var(--hl-muted)]">Skew </span>
              <span className={`tabular-nums ${summary.skew25d > 5 ? "text-[var(--hl-red)]" : summary.skew25d < -5 ? "text-[var(--hl-green)]" : "text-[var(--hl-muted)]"}`}>
                {summary.skew25d > 0 ? "+" : ""}{summary.skew25d.toFixed(1)}
              </span>
            </div>
            <div>
              <span className="text-[var(--hl-muted)]">GEX </span>
              <span className={`tabular-nums ${summary.gexLevel === "dampening" ? "text-[var(--hl-green)]" : summary.gexLevel === "amplifying" ? "text-[var(--hl-red)]" : "text-[var(--hl-muted)]"}`}>
                {summary.gex > 0 ? "+" : ""}{summary.gex}M
              </span>
            </div>
            <div>
              <span className="text-[var(--hl-muted)]">Call OI </span>
              <span className="text-[var(--hl-green)] tabular-nums">{formatOI(summary.totalCallOI)}</span>
            </div>
            <div>
              <span className="text-[var(--hl-muted)]">Put OI </span>
              <span className="text-[var(--hl-red)] tabular-nums">{formatOI(summary.totalPutOI)}</span>
            </div>
            {summary.totalVolume24h > 0 && (
              <div>
                <span className="text-[var(--hl-muted)]">24h Vol </span>
                <span className="text-[var(--hl-text)] tabular-nums">{formatOI(summary.totalVolume24h)}</span>
              </div>
            )}
          </div>
        )}

        {/* Expiry tabs */}
        {data?.expiries && data.expiries.length > 0 && (
          <div className="flex items-center gap-1 px-4 py-2 border-b border-[var(--hl-border)] overflow-x-auto">
            {data.expiries.map((exp) => (
              <button
                key={exp.label}
                onClick={() => setSelectedExpiry(exp.label)}
                className={`text-[10px] px-3 py-1 rounded transition-colors whitespace-nowrap ${
                  selectedExpiry === exp.label
                    ? "bg-purple-500/20 text-purple-400 border border-purple-500/30"
                    : "text-[var(--hl-muted)] hover:text-[var(--hl-text)] border border-transparent"
                }`}
              >
                {exp.label}
              </button>
            ))}
          </div>
        )}

        {/* Options chain table */}
        <div className="flex-1 overflow-auto">
          {loading && !data ? (
            <div className="flex items-center justify-center h-40 text-[var(--hl-muted)] text-[12px]">
              Loading HYPE options...
            </div>
          ) : chainByStrike.length === 0 ? (
            <div className="flex items-center justify-center h-40 text-[var(--hl-muted)] text-[12px]">
              No options available for this expiry
            </div>
          ) : (
            <table className="w-full text-[10px]">
              <thead className="sticky top-0 bg-[var(--hl-surface)] z-10">
                <tr className="border-b border-[var(--hl-border)]">
                  {/* Calls side */}
                  <th className="text-left px-2 py-1.5 text-[var(--hl-green)] font-medium">OI</th>
                  <th className="text-left px-2 py-1.5 text-[var(--hl-green)] font-medium">Vol</th>
                  <th className="text-right px-2 py-1.5 text-[var(--hl-green)] font-medium">IV</th>
                  {showGreeks && (
                    <>
                      <th className="text-right px-2 py-1.5 text-[var(--hl-muted)] font-medium">&Delta;</th>
                      <th className="text-right px-2 py-1.5 text-[var(--hl-muted)] font-medium">&Gamma;</th>
                    </>
                  )}
                  <th className="text-right px-2 py-1.5 text-[var(--hl-green)] font-medium">Bid</th>
                  <th className="text-right px-2 py-1.5 text-[var(--hl-green)] font-medium">Ask</th>
                  <th className="text-right px-2 py-1.5 text-[var(--hl-green)] font-medium">Mark</th>
                  {/* Strike */}
                  <th className="text-center px-3 py-1.5 text-[var(--foreground)] font-bold bg-[var(--hl-bg)]">Strike</th>
                  {/* Puts side */}
                  <th className="text-left px-2 py-1.5 text-[var(--hl-red)] font-medium">Mark</th>
                  <th className="text-left px-2 py-1.5 text-[var(--hl-red)] font-medium">Bid</th>
                  <th className="text-left px-2 py-1.5 text-[var(--hl-red)] font-medium">Ask</th>
                  {showGreeks && (
                    <>
                      <th className="text-left px-2 py-1.5 text-[var(--hl-muted)] font-medium">&Delta;</th>
                      <th className="text-left px-2 py-1.5 text-[var(--hl-muted)] font-medium">&Gamma;</th>
                    </>
                  )}
                  <th className="text-left px-2 py-1.5 text-[var(--hl-red)] font-medium">IV</th>
                  <th className="text-right px-2 py-1.5 text-[var(--hl-red)] font-medium">Vol</th>
                  <th className="text-right px-2 py-1.5 text-[var(--hl-red)] font-medium">OI</th>
                </tr>
              </thead>
              <tbody>
                {chainByStrike.map(({ strike, call, put }) => {
                  const isITMCall = spotPrice > 0 && strike < spotPrice;
                  const isITMPut = spotPrice > 0 && strike > spotPrice;
                  const isATM = spotPrice > 0 && Math.abs(strike - spotPrice) / spotPrice < 0.02;

                  return (
                    <tr
                      key={strike}
                      className={`border-b border-[var(--hl-border)]/30 hover:bg-[var(--hl-surface-hover)] transition-colors ${
                        isATM ? "bg-[rgba(168,85,247,0.08)]" : ""
                      }`}
                    >
                      {/* Call side */}
                      <td className={`px-2 py-1 tabular-nums ${isITMCall ? "bg-[rgba(80,210,193,0.05)]" : ""}`}>
                        {call ? formatOI(call.openInterest) : "—"}
                      </td>
                      <td className={`px-2 py-1 tabular-nums ${isITMCall ? "bg-[rgba(80,210,193,0.05)]" : ""}`}>
                        {call && call.volume24h > 0 ? formatOI(call.volume24h) : "—"}
                      </td>
                      <td className={`px-2 py-1 text-right tabular-nums ${call ? ivColor(call.iv) : ""} ${isITMCall ? "bg-[rgba(80,210,193,0.05)]" : ""}`}>
                        {call ? `${call.iv.toFixed(0)}%` : "—"}
                      </td>
                      {showGreeks && (
                        <>
                          <td className={`px-2 py-1 text-right tabular-nums text-[var(--hl-muted)] ${isITMCall ? "bg-[rgba(80,210,193,0.05)]" : ""}`}>
                            {call ? formatGreek(call.delta) : "—"}
                          </td>
                          <td className={`px-2 py-1 text-right tabular-nums text-[var(--hl-muted)] ${isITMCall ? "bg-[rgba(80,210,193,0.05)]" : ""}`}>
                            {call ? formatGreek(call.gamma, 4) : "—"}
                          </td>
                        </>
                      )}
                      <td className={`px-2 py-1 text-right tabular-nums text-[var(--hl-green)] ${isITMCall ? "bg-[rgba(80,210,193,0.05)]" : ""}`}>
                        {call && call.bidPrice > 0 ? `$${call.bidPrice.toFixed(2)}` : "—"}
                      </td>
                      <td className={`px-2 py-1 text-right tabular-nums text-[var(--hl-green)] ${isITMCall ? "bg-[rgba(80,210,193,0.05)]" : ""}`}>
                        {call && call.askPrice > 0 ? `$${call.askPrice.toFixed(2)}` : "—"}
                      </td>
                      <td className={`px-2 py-1 text-right tabular-nums font-medium ${isITMCall ? "bg-[rgba(80,210,193,0.05)]" : ""}`}>
                        {call ? formatPrice(call.markPrice) : "—"}
                      </td>

                      {/* Strike column */}
                      <td className={`px-3 py-1 text-center font-bold tabular-nums bg-[var(--hl-bg)] border-x border-[var(--hl-border)]/30 ${
                        isATM ? "text-purple-400" : "text-[var(--foreground)]"
                      }`}>
                        ${strike}
                        {isATM && <span className="ml-1 text-[8px] text-purple-400/70">ATM</span>}
                      </td>

                      {/* Put side */}
                      <td className={`px-2 py-1 tabular-nums font-medium ${isITMPut ? "bg-[rgba(240,88,88,0.05)]" : ""}`}>
                        {put ? formatPrice(put.markPrice) : "—"}
                      </td>
                      <td className={`px-2 py-1 tabular-nums text-[var(--hl-red)] ${isITMPut ? "bg-[rgba(240,88,88,0.05)]" : ""}`}>
                        {put && put.bidPrice > 0 ? `$${put.bidPrice.toFixed(2)}` : "—"}
                      </td>
                      <td className={`px-2 py-1 tabular-nums text-[var(--hl-red)] ${isITMPut ? "bg-[rgba(240,88,88,0.05)]" : ""}`}>
                        {put && put.askPrice > 0 ? `$${put.askPrice.toFixed(2)}` : "—"}
                      </td>
                      {showGreeks && (
                        <>
                          <td className={`px-2 py-1 tabular-nums text-[var(--hl-muted)] ${isITMPut ? "bg-[rgba(240,88,88,0.05)]" : ""}`}>
                            {put ? formatGreek(put.delta) : "—"}
                          </td>
                          <td className={`px-2 py-1 tabular-nums text-[var(--hl-muted)] ${isITMPut ? "bg-[rgba(240,88,88,0.05)]" : ""}`}>
                            {put ? formatGreek(put.gamma, 4) : "—"}
                          </td>
                        </>
                      )}
                      <td className={`px-2 py-1 tabular-nums ${put ? ivColor(put.iv) : ""} ${isITMPut ? "bg-[rgba(240,88,88,0.05)]" : ""}`}>
                        {put ? `${put.iv.toFixed(0)}%` : "—"}
                      </td>
                      <td className={`px-2 py-1 text-right tabular-nums ${isITMPut ? "bg-[rgba(240,88,88,0.05)]" : ""}`}>
                        {put && put.volume24h > 0 ? formatOI(put.volume24h) : "—"}
                      </td>
                      <td className={`px-2 py-1 text-right tabular-nums ${isITMPut ? "bg-[rgba(240,88,88,0.05)]" : ""}`}>
                        {put ? formatOI(put.openInterest) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer with Derive link */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-[var(--hl-border)] bg-[var(--hl-surface)] text-[10px]">
          <span className="text-[var(--hl-muted)]">
            Data from <span className="text-purple-400">Derive</span> (formerly Lyra Finance)
            {" "}&middot; Min size: 10 HYPE &middot; Maker: 0.01% &middot; Taker: 0.03%
          </span>
          <a
            href="https://derive.xyz/trade/options/HYPE"
            target="_blank"
            rel="noopener noreferrer"
            className="text-purple-400 hover:text-purple-300 transition-colors font-medium"
          >
            Trade on Derive &rarr;
          </a>
        </div>
      </div>
    </div>
  );
}
