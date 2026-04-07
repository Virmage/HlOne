"use client";

import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import type { DeriveOptionsChain, HypeOptionRow } from "@/lib/api";
import { getDeriveOptionsChain } from "@/lib/api";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SelectedOption {
  instrument: string;
  coin: string;
  strike: number;
  type: "C" | "P";
  expiry: string;
  expiryTimestamp: number;
  side: "buy" | "sell";
  price: number;       // pre-fill from bid (sell) or ask (buy)
  markPrice: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  bidPrice: number;
  askPrice: number;
  openInterest: number;
}

interface InlineOptionsChainProps {
  coin: string;
  onSelectOption: (opt: SelectedOption) => void;
  selectedOption: SelectedOption | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function ivColor(iv: number): string {
  if (iv > 120) return "text-[var(--hl-red)]";
  if (iv > 80) return "text-orange-400";
  return "text-[var(--hl-text)]";
}

// ─── Component ──────────────────────────────────────────────────────────────

// ─── Direct Derive API fallback (when backend is down) ──────────────────────

async function fetchDirectFromDerive(coin: string): Promise<DeriveOptionsChain> {
  const DERIVE_API = "https://api.lyra.finance";

  // 1. Get instruments
  const instRes = await fetch(`${DERIVE_API}/public/get_instruments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currency: coin, expired: false, instrument_type: "option" }),
  });
  const instData = await instRes.json();
  const instruments: string[] = (instData.result || []).map((i: { instrument_name: string }) => i.instrument_name);

  if (instruments.length === 0) throw new Error("No instruments");

  // 2. Get spot price
  let spotPrice = 0;
  try {
    const tickerRes = await fetch(`${DERIVE_API}/public/get_ticker`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instrument_name: `${coin}-PERP` }),
    });
    const tickerData = await tickerRes.json();
    spotPrice = parseFloat(tickerData.result?.best_bid_price || "0") || parseFloat(tickerData.result?.index_price || "0");
  } catch {}

  // 3. Get tickers for a subset (nearest expiries, near ATM)
  // Parse expiries from instrument names
  const expirySet = new Set<string>();
  for (const name of instruments) {
    const parts = name.split("-");
    if (parts.length >= 4) expirySet.add(parts[1]);
  }
  const sortedExpiries = [...expirySet].sort();
  // Take first 4 expiries to limit API calls
  const nearExpiries = sortedExpiries.slice(0, 4);

  // Filter instruments to near expiries
  const nearInstruments = instruments.filter(name => {
    const parts = name.split("-");
    return nearExpiries.includes(parts[1]);
  });

  // Batch fetch tickers (max 40 at a time to be reasonable)
  const toFetch = nearInstruments.slice(0, 80);
  const chain: HypeOptionRow[] = [];

  const batchSize = 10;
  for (let i = 0; i < toFetch.length; i += batchSize) {
    const batch = toFetch.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (inst) => {
        const res = await fetch(`${DERIVE_API}/public/get_ticker`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instrument_name: inst }),
        });
        return { instrument: inst, ticker: (await res.json()).result };
      })
    );

    for (const r of results) {
      if (r.status !== "fulfilled" || !r.value.ticker) continue;
      const { instrument, ticker } = r.value;
      const parts = instrument.split("-");
      if (parts.length < 4) continue;

      const expiryRaw = parts[1]; // e.g. "20260409"
      const strike = parseInt(parts[2]);
      const type = parts[3] as "C" | "P";

      // Format expiry label: "Apr 9" from "20260409"
      const y = parseInt(expiryRaw.slice(0, 4));
      const m = parseInt(expiryRaw.slice(4, 6)) - 1;
      const d = parseInt(expiryRaw.slice(6, 8));
      const dt = new Date(y, m, d);
      const label = dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const ts = dt.getTime();

      chain.push({
        instrument,
        expiry: label,
        expiryTimestamp: ts,
        strike,
        type,
        markPrice: parseFloat(ticker.mark_price || "0"),
        bidPrice: parseFloat(ticker.best_bid_price || "0"),
        askPrice: parseFloat(ticker.best_ask_price || "0"),
        bidAmount: parseFloat(ticker.best_bid_amount || "0"),
        askAmount: parseFloat(ticker.best_ask_amount || "0"),
        iv: parseFloat(ticker.mark_iv || "0"),
        delta: parseFloat(ticker.greeks?.delta || "0"),
        gamma: parseFloat(ticker.greeks?.gamma || "0"),
        theta: parseFloat(ticker.greeks?.theta || "0"),
        vega: parseFloat(ticker.greeks?.vega || "0"),
        openInterest: parseFloat(ticker.open_interest || "0"),
        volume24h: parseFloat(ticker.stats?.volume || "0"),
      });
    }
  }

  // Build expiries list
  const expiryMap = new Map<string, number>();
  for (const opt of chain) {
    if (!expiryMap.has(opt.expiry)) expiryMap.set(opt.expiry, opt.expiryTimestamp);
  }
  const expiries = [...expiryMap.entries()]
    .sort(([, a], [, b]) => a - b)
    .map(([label, timestamp]) => ({ label, timestamp }));

  return {
    coin,
    chain,
    spotPrice,
    expiries,
    source: "derive" as const,
    timestamp: Date.now(),
    summary: {
      maxPain: 0,
      maxPainExpiry: "",
      maxPainDistance: 0,
      putCallRatio: 0,
      totalCallOI: chain.filter(o => o.type === "C").reduce((s, o) => s + o.openInterest, 0),
      totalPutOI: chain.filter(o => o.type === "P").reduce((s, o) => s + o.openInterest, 0),
      iv: chain.length > 0 ? chain.reduce((s, o) => s + o.iv, 0) / chain.length : 0,
      ivRank: 0,
      skew25d: 0,
      gex: 0,
      gexLevel: "neutral" as const,
      totalVolume24h: chain.reduce((s, o) => s + o.volume24h, 0),
    },
  };
}

// ─── Component ──────────────────────────────────────────────────────────────

export function InlineOptionsChain({ coin, onSelectOption, selectedOption }: InlineOptionsChainProps) {
  const [data, setData] = useState<DeriveOptionsChain | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedExpiry, setSelectedExpiry] = useState<string | null>(null);
  const atmRef = useRef<HTMLTableRowElement>(null);

  const fetchData = useCallback(async () => {
    try {
      // Try backend API first
      const result = await getDeriveOptionsChain(coin);
      setData(result);
      setError(null);
      if (result?.expiries.length && !selectedExpiry) {
        setSelectedExpiry(result.expiries[0].label);
      }
    } catch (err) {
      console.warn("[options-chain] Backend fetch failed, trying Derive direct:", err);
      try {
        // Fallback: fetch directly from Derive API
        const result = await fetchDirectFromDerive(coin);
        setData(result);
        setError(null);
        if (result?.expiries.length && !selectedExpiry) {
          setSelectedExpiry(result.expiries[0].label);
        }
      } catch (err2) {
        console.error("[options-chain] Direct fetch also failed:", err2);
        setError("Failed to load options data");
      }
    } finally {
      setLoading(false);
    }
  }, [coin]);

  useEffect(() => {
    setSelectedExpiry(null);
    setData(null);
    setLoading(true);
    setError(null);
    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, [coin, fetchData]);

  // Scroll to ATM on load
  useEffect(() => {
    if (atmRef.current) {
      atmRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [selectedExpiry, data]);

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

  const spot = data?.spotPrice || 0;

  const handleCellClick = (opt: HypeOptionRow, clickSide: "buy" | "sell") => {
    onSelectOption({
      instrument: opt.instrument,
      coin,
      strike: opt.strike,
      type: opt.type,
      expiry: opt.expiry,
      expiryTimestamp: opt.expiryTimestamp,
      side: clickSide,
      price: clickSide === "buy" ? opt.askPrice : opt.bidPrice,
      markPrice: opt.markPrice,
      iv: opt.iv,
      delta: opt.delta,
      gamma: opt.gamma,
      theta: opt.theta,
      vega: opt.vega,
      bidPrice: opt.bidPrice,
      askPrice: opt.askPrice,
      openInterest: opt.openInterest,
    });
  };

  const selectedExpObj = data?.expiries.find(e => e.label === selectedExpiry);
  const daysToExpiry = selectedExpObj ? Math.ceil((selectedExpObj.timestamp - Date.now()) / 86400000) : 0;
  const hoursToExpiry = selectedExpObj ? Math.ceil((selectedExpObj.timestamp - Date.now()) / 3600000) : 0;
  const timeLabel = daysToExpiry > 0
    ? `${daysToExpiry}d ${hoursToExpiry % 24}h`
    : hoursToExpiry > 0 ? `${hoursToExpiry}h` : "";

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--hl-muted)] text-[12px]">
        Loading {coin} options chain...
      </div>
    );
  }

  if (error || !data || data.expiries.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="text-[var(--hl-muted)] text-[12px] mb-2">{error || `No options data available for ${coin}`}</div>
          <button
            onClick={() => { setLoading(true); setError(null); fetchData(); }}
            className="text-[11px] text-purple-400 hover:text-purple-300 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[var(--background)]">
      {/* Top bar: coin + expiry tabs */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-[var(--hl-border)] bg-[var(--hl-surface)] overflow-x-auto shrink-0">
        <span className="text-[11px] font-bold text-[var(--foreground)] mr-2 shrink-0">{coin}</span>
        {data.expiries.map((exp) => {
          const isSelected = selectedExpiry === exp.label;
          const days = Math.ceil((exp.timestamp - Date.now()) / 86400000);
          return (
            <button
              key={exp.label}
              onClick={() => setSelectedExpiry(exp.label)}
              className={`text-[10px] px-2.5 py-1 rounded whitespace-nowrap transition-colors shrink-0 ${
                isSelected
                  ? "bg-[var(--foreground)] text-[var(--background)] font-semibold"
                  : "text-[var(--hl-muted)] hover:text-[var(--foreground)] hover:bg-[var(--hl-surface-hover)]"
              }`}
            >
              {exp.label}
              {isSelected && days <= 7 && <span className="ml-1 text-[8px] opacity-70">({days}d)</span>}
            </button>
          );
        })}
        {selectedExpiry && timeLabel && (
          <span className="text-[10px] text-[var(--hl-muted)] ml-auto shrink-0 pl-2">
            {selectedExpiry} {timeLabel}
          </span>
        )}
      </div>

      {/* Column headers: Calls | Strike | Puts */}
      <div className="grid grid-cols-[1fr_auto_1fr] border-b border-[var(--hl-border)] bg-[var(--hl-surface)] shrink-0">
        <div className="text-center text-[10px] font-semibold text-[var(--hl-green)] py-1">Calls</div>
        <div className="text-center text-[10px] font-semibold text-[var(--foreground)] py-1 px-4 border-x border-[var(--hl-border)]">
          {spot > 0 && <span className="text-[var(--hl-muted)] font-normal mr-1">{coin}</span>}
          {spot > 0 && `$${spot.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
        </div>
        <div className="text-center text-[10px] font-semibold text-[var(--hl-red)] py-1">Puts</div>
      </div>

      {/* Options chain table */}
      <div className="flex-1 overflow-auto">
        {chainByStrike.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-[var(--hl-muted)] text-[11px]">
            No options for this expiry
          </div>
        ) : (
          <table className="w-full text-[10px] border-collapse">
            <thead className="sticky top-0 bg-[var(--hl-surface)] z-10">
              <tr className="border-b border-[var(--hl-border)]">
                {/* Call side */}
                <th className="text-right px-1.5 py-1 text-[var(--hl-muted)] font-medium w-[40px]">BidSz</th>
                <th className="text-right px-1.5 py-1 text-[var(--hl-muted)] font-medium w-[45px]">BidIV</th>
                <th className="text-right px-1.5 py-1 text-[var(--hl-green)] font-medium w-[55px]">Bid</th>
                <th className="text-right px-1.5 py-1 text-[var(--hl-muted)] font-medium w-[55px]">Mark</th>
                <th className="text-right px-1.5 py-1 text-[var(--hl-red)] font-medium w-[55px]">Ask</th>
                <th className="text-right px-1.5 py-1 text-[var(--hl-muted)] font-medium w-[45px]">AskIV</th>
                <th className="text-right px-1.5 py-1 text-[var(--hl-muted)] font-medium w-[45px]">Delta</th>
                <th className="text-right px-1.5 py-1 text-[var(--hl-muted)] font-medium w-[50px]">MkIV</th>
                {/* Strike */}
                <th className="text-center px-3 py-1 text-[var(--foreground)] font-bold bg-[var(--background)] border-x border-[var(--hl-border)] w-[70px]">Strike</th>
                {/* Put side */}
                <th className="text-left px-1.5 py-1 text-[var(--hl-muted)] font-medium w-[50px]">MkIV</th>
                <th className="text-left px-1.5 py-1 text-[var(--hl-muted)] font-medium w-[45px]">Delta</th>
                <th className="text-left px-1.5 py-1 text-[var(--hl-green)] font-medium w-[55px]">Bid</th>
                <th className="text-left px-1.5 py-1 text-[var(--hl-muted)] font-medium w-[55px]">Mark</th>
                <th className="text-left px-1.5 py-1 text-[var(--hl-red)] font-medium w-[55px]">Ask</th>
                <th className="text-left px-1.5 py-1 text-[var(--hl-muted)] font-medium w-[45px]">BidIV</th>
                <th className="text-left px-1.5 py-1 text-[var(--hl-muted)] font-medium w-[40px]">BidSz</th>
              </tr>
            </thead>
            <tbody>
              {chainByStrike.map(({ strike, call, put }, idx) => {
                const isITMCall = spot > 0 && strike < spot;
                const isITMPut = spot > 0 && strike > spot;
                const isATM = spot > 0 && Math.abs(strike - spot) / spot < 0.015;
                const isSelectedStrike = selectedOption?.strike === strike && selectedOption?.expiry === selectedExpiry;

                // Spot price divider: insert between last ITM call and first OTM call
                const prevStrike = idx > 0 ? chainByStrike[idx - 1].strike : 0;
                const showSpotDivider = spot > 0 && prevStrike < spot && strike >= spot && prevStrike > 0;

                return (
                  <React.Fragment key={strike}>
                    {showSpotDivider && (
                      <tr>
                        <td colSpan={16} className="relative h-6">
                          <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-purple-500/40" />
                          <div className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 bg-[var(--background)] px-3 py-0.5 text-[10px] font-medium text-purple-400 rounded border border-purple-500/30">
                            {coin} ${spot.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                        </td>
                      </tr>
                    )}
                    <tr
                      ref={isATM ? atmRef : undefined}
                      className={`border-b border-[var(--hl-border)]/20 transition-colors ${
                        isSelectedStrike ? "bg-[rgba(168,85,247,0.1)]" : ""
                      } ${isATM ? "bg-[rgba(168,85,247,0.04)]" : ""}`}
                    >
                      {/* ─── Call side ─── */}
                      <td className={`px-1.5 py-[3px] text-right tabular-nums text-[var(--hl-muted)] ${isITMCall ? "bg-[rgba(80,210,193,0.04)]" : ""}`}>
                        {call?.bidAmount ? call.bidAmount.toFixed(1) : "\u2014"}
                      </td>
                      <td className={`px-1.5 py-[3px] text-right tabular-nums text-[var(--hl-muted)] ${isITMCall ? "bg-[rgba(80,210,193,0.04)]" : ""}`}>
                        {call?.iv ? `${call.iv.toFixed(1)}%` : "\u2014"}
                      </td>
                      <td
                        className={`px-1.5 py-[3px] text-right tabular-nums cursor-pointer transition-colors ${
                          isITMCall ? "bg-[rgba(80,210,193,0.04)]" : ""
                        } ${call?.bidPrice ? "text-[var(--hl-green)] hover:bg-[rgba(80,210,193,0.15)] font-medium" : "text-[var(--hl-muted)]"}`}
                        onClick={() => call?.bidPrice && handleCellClick(call, "sell")}
                        title={call?.bidPrice ? `Sell Call @ $${call.bidPrice.toFixed(2)}` : undefined}
                      >
                        {call?.bidPrice ? `$${call.bidPrice.toFixed(2)}` : "\u2014"}
                      </td>
                      <td className={`px-1.5 py-[3px] text-right tabular-nums text-[var(--foreground)] ${isITMCall ? "bg-[rgba(80,210,193,0.04)]" : ""}`}>
                        {call?.markPrice ? `$${call.markPrice.toFixed(2)}` : "\u2014"}
                      </td>
                      <td
                        className={`px-1.5 py-[3px] text-right tabular-nums cursor-pointer transition-colors ${
                          isITMCall ? "bg-[rgba(80,210,193,0.04)]" : ""
                        } ${call?.askPrice ? "text-[var(--hl-red)] hover:bg-[rgba(240,88,88,0.15)] font-medium" : "text-[var(--hl-muted)]"}`}
                        onClick={() => call?.askPrice && handleCellClick(call, "buy")}
                        title={call?.askPrice ? `Buy Call @ $${call.askPrice.toFixed(2)}` : undefined}
                      >
                        {call?.askPrice ? `$${call.askPrice.toFixed(2)}` : "\u2014"}
                      </td>
                      <td className={`px-1.5 py-[3px] text-right tabular-nums text-[var(--hl-muted)] ${isITMCall ? "bg-[rgba(80,210,193,0.04)]" : ""}`}>
                        {call?.iv ? `${call.iv.toFixed(1)}%` : "\u2014"}
                      </td>
                      <td className={`px-1.5 py-[3px] text-right tabular-nums text-[var(--hl-muted)] ${isITMCall ? "bg-[rgba(80,210,193,0.04)]" : ""}`}>
                        {call?.delta ? call.delta.toFixed(2) : "\u2014"}
                      </td>
                      <td className={`px-1.5 py-[3px] text-right tabular-nums ${call ? ivColor(call.iv) : "text-[var(--hl-muted)]"} ${isITMCall ? "bg-[rgba(80,210,193,0.04)]" : ""}`}>
                        {call?.iv ? `${call.iv.toFixed(1)}%` : "\u2014"}
                      </td>

                      {/* ─── Strike ─── */}
                      <td className={`px-3 py-[3px] text-center font-bold tabular-nums bg-[var(--background)] border-x border-[var(--hl-border)]/30 ${
                        isATM ? "text-purple-400" : "text-[var(--foreground)]"
                      }`}>
                        ${strike.toLocaleString()}
                      </td>

                      {/* ─── Put side ─── */}
                      <td className={`px-1.5 py-[3px] tabular-nums ${put ? ivColor(put.iv) : "text-[var(--hl-muted)]"} ${isITMPut ? "bg-[rgba(240,88,88,0.04)]" : ""}`}>
                        {put?.iv ? `${put.iv.toFixed(1)}%` : "\u2014"}
                      </td>
                      <td className={`px-1.5 py-[3px] tabular-nums text-[var(--hl-muted)] ${isITMPut ? "bg-[rgba(240,88,88,0.04)]" : ""}`}>
                        {put?.delta ? put.delta.toFixed(2) : "\u2014"}
                      </td>
                      <td
                        className={`px-1.5 py-[3px] tabular-nums cursor-pointer transition-colors ${
                          isITMPut ? "bg-[rgba(240,88,88,0.04)]" : ""
                        } ${put?.bidPrice ? "text-[var(--hl-green)] hover:bg-[rgba(80,210,193,0.15)] font-medium" : "text-[var(--hl-muted)]"}`}
                        onClick={() => put?.bidPrice && handleCellClick(put, "sell")}
                        title={put?.bidPrice ? `Sell Put @ $${put.bidPrice.toFixed(2)}` : undefined}
                      >
                        {put?.bidPrice ? `$${put.bidPrice.toFixed(2)}` : "\u2014"}
                      </td>
                      <td className={`px-1.5 py-[3px] tabular-nums text-[var(--foreground)] ${isITMPut ? "bg-[rgba(240,88,88,0.04)]" : ""}`}>
                        {put?.markPrice ? `$${put.markPrice.toFixed(2)}` : "\u2014"}
                      </td>
                      <td
                        className={`px-1.5 py-[3px] tabular-nums cursor-pointer transition-colors ${
                          isITMPut ? "bg-[rgba(240,88,88,0.04)]" : ""
                        } ${put?.askPrice ? "text-[var(--hl-red)] hover:bg-[rgba(240,88,88,0.15)] font-medium" : "text-[var(--hl-muted)]"}`}
                        onClick={() => put?.askPrice && handleCellClick(put, "buy")}
                        title={put?.askPrice ? `Buy Put @ $${put.askPrice.toFixed(2)}` : undefined}
                      >
                        {put?.askPrice ? `$${put.askPrice.toFixed(2)}` : "\u2014"}
                      </td>
                      <td className={`px-1.5 py-[3px] tabular-nums text-[var(--hl-muted)] ${isITMPut ? "bg-[rgba(240,88,88,0.04)]" : ""}`}>
                        {put?.iv ? `${put.iv.toFixed(1)}%` : "\u2014"}
                      </td>
                      <td className={`px-1.5 py-[3px] tabular-nums text-[var(--hl-muted)] ${isITMPut ? "bg-[rgba(240,88,88,0.04)]" : ""}`}>
                        {put?.bidAmount ? put.bidAmount.toFixed(1) : "\u2014"}
                      </td>
                    </tr>
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
