"use client";

import { useState, useEffect, useRef } from "react";

interface BookLevel {
  px: string;
  sz: string;
  n: number;
}

interface Trade {
  px: string;
  sz: string;
  side: string;
  time: number;
}

interface OrderBookProps {
  coin: string;
}

const API_URL = typeof window !== "undefined" && process.env.NODE_ENV === "production"
  ? ""
  : (process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001");

export function OrderBook({ coin }: OrderBookProps) {
  const [tab, setTab] = useState<"book" | "trades">("book");
  const [bids, setBids] = useState<BookLevel[]>([]);
  const [asks, setAsks] = useState<BookLevel[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchBook = async () => {
      try {
        const res = await fetch(`${API_URL}/api/market/book/${coin}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          setBids(data.bids || []);
          setAsks(data.asks || []);
          setTrades(data.trades || []);
        }
      } catch { /* ignore */ }
    };

    fetchBook();
    pollRef.current = setInterval(fetchBook, 10_000); // 10s — avoid HL 429s

    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [coin]);

  const formatPx = (px: string) => {
    const n = parseFloat(px);
    if (n >= 10000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (n >= 1) return n.toFixed(2);
    return n.toPrecision(4);
  };

  const formatSz = (sz: string) => {
    const n = parseFloat(sz);
    if (n >= 1000) return (n / 1000).toFixed(1) + "K";
    if (n >= 1) return n.toFixed(2);
    return n.toPrecision(3);
  };

  // Max size for bar width calculation
  const maxBidSz = Math.max(...bids.map(b => parseFloat(b.sz)), 0.001);
  const maxAskSz = Math.max(...asks.map(a => parseFloat(a.sz)), 0.001);
  const maxSz = Math.max(maxBidSz, maxAskSz);

  return (
    <div className="flex flex-col h-full border-l border-[var(--hl-border)]">
      {/* Tabs */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-[var(--hl-border)]">
        <button
          onClick={() => setTab("book")}
          className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
            tab === "book" ? "text-[var(--foreground)] bg-[var(--hl-surface)]" : "text-[var(--hl-muted)] hover:text-[var(--foreground)]"
          }`}
        >
          Book
        </button>
        <button
          onClick={() => setTab("trades")}
          className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
            tab === "trades" ? "text-[var(--foreground)] bg-[var(--hl-surface)]" : "text-[var(--hl-muted)] hover:text-[var(--foreground)]"
          }`}
        >
          Trades
        </button>
      </div>

      {tab === "book" ? (
        <div className="flex-1 overflow-hidden flex flex-col text-[10px] tabular-nums">
          {/* Header */}
          <div className="flex items-center px-2 py-0.5 text-[9px] text-[var(--hl-muted)] uppercase border-b border-[var(--hl-border)]">
            <span className="flex-1">Price</span>
            <span className="w-14 text-right">Size</span>
            <span className="w-14 text-right">Total</span>
          </div>

          {/* Asks (reversed — lowest ask at bottom) */}
          <div className="flex-1 overflow-y-auto flex flex-col-reverse">
            {asks.slice(0, 12).map((a, i) => {
              const sz = parseFloat(a.sz);
              const pct = (sz / maxSz) * 100;
              return (
                <div key={`ask-${i}`} className="flex items-center px-2 py-[1px] relative">
                  <div
                    className="absolute right-0 top-0 h-full bg-[var(--hl-red)] opacity-[0.08]"
                    style={{ width: `${pct}%` }}
                  />
                  <span className="flex-1 text-[var(--hl-red)] relative z-10">{formatPx(a.px)}</span>
                  <span className="w-14 text-right text-[var(--foreground)] relative z-10">{formatSz(a.sz)}</span>
                  <span className="w-14 text-right text-[var(--hl-muted)] relative z-10">{a.n}</span>
                </div>
              );
            })}
          </div>

          {/* Spread */}
          {bids.length > 0 && asks.length > 0 && (
            <div className="flex items-center px-2 py-0.5 border-y border-[var(--hl-border)] text-[var(--hl-muted)]">
              <span className="flex-1 text-[var(--foreground)] font-medium">
                {formatPx(asks[0]?.px || "0")}
              </span>
              <span className="text-[9px]">
                Spread: {(parseFloat(asks[0]?.px || "0") - parseFloat(bids[0]?.px || "0")).toFixed(2)}
              </span>
            </div>
          )}

          {/* Bids */}
          <div className="flex-1 overflow-y-auto">
            {bids.slice(0, 12).map((b, i) => {
              const sz = parseFloat(b.sz);
              const pct = (sz / maxSz) * 100;
              return (
                <div key={`bid-${i}`} className="flex items-center px-2 py-[1px] relative">
                  <div
                    className="absolute right-0 top-0 h-full bg-[var(--hl-green)] opacity-[0.08]"
                    style={{ width: `${pct}%` }}
                  />
                  <span className="flex-1 text-[var(--hl-green)] relative z-10">{formatPx(b.px)}</span>
                  <span className="w-14 text-right text-[var(--foreground)] relative z-10">{formatSz(b.sz)}</span>
                  <span className="w-14 text-right text-[var(--hl-muted)] relative z-10">{b.n}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        /* Trades tab */
        <div className="flex-1 overflow-y-auto text-[10px] tabular-nums">
          <div className="flex items-center px-2 py-0.5 text-[9px] text-[var(--hl-muted)] uppercase border-b border-[var(--hl-border)]">
            <span className="flex-1">Price</span>
            <span className="w-14 text-right">Size</span>
            <span className="w-16 text-right">Time</span>
          </div>
          {trades.map((t, i) => {
            const isBuy = t.side === "B" || t.side === "buy";
            const d = new Date(t.time);
            const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
            return (
              <div key={i} className="flex items-center px-2 py-[1px]">
                <span className={`flex-1 ${isBuy ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                  {formatPx(t.px)}
                </span>
                <span className="w-14 text-right text-[var(--foreground)]">{formatSz(t.sz)}</span>
                <span className="w-16 text-right text-[var(--hl-muted)]">{time}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
