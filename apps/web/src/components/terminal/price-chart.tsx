"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import type { TokenDetail, TokenOverview, WhaleAlert } from "@/lib/api";
import { getTokenDetail } from "@/lib/api";

interface PriceChartProps {
  coin: string;
  tokens: TokenOverview[];
  onSelectToken: (coin: string) => void;
  whaleAlerts?: WhaleAlert[];
}

type Interval = "5m" | "15m" | "1h" | "4h" | "1d" | "1w" | "1M";

const POLL_INTERVAL = 15_000; // 15 seconds

export function PriceChart({ coin, tokens, onSelectToken, whaleAlerts = [] }: PriceChartProps) {
  const [interval, setInterval] = useState<Interval>("1h");
  const [detail, setDetail] = useState<TokenDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const pollRef = useRef<ReturnType<typeof globalThis.setInterval> | null>(null);

  const overview = tokens.find(t => t.coin === coin);

  const fetchData = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const d = await getTokenDetail(coin, interval);
      setDetail(d);
    } catch { /* ignore */ }
    if (showLoading) setLoading(false);
  }, [coin, interval]);

  // Initial fetch + polling
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getTokenDetail(coin, interval)
      .then(d => { if (!cancelled) setDetail(d); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });

    // Poll for live updates
    pollRef.current = globalThis.setInterval(() => {
      if (!cancelled) fetchData(false);
    }, POLL_INTERVAL);

    return () => {
      cancelled = true;
      if (pollRef.current) globalThis.clearInterval(pollRef.current);
    };
  }, [coin, interval, fetchData]);

  const chartData = useMemo(() => {
    if (!detail?.candles?.length) return [];
    return detail.candles.map(c => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      bullish: c.close >= c.open,
    }));
  }, [detail]);

  // Only show real OI candles from the tracker — no simulated data
  const oiCandles = useMemo(() => {
    if (detail?.oiCandles && detail.oiCandles.length >= 10) {
      return detail.oiCandles.map(c => ({
        ...c,
        bullish: c.close >= c.open,
      }));
    }
    return [];
  }, [detail]);

  // Whale alerts: prefer historical from token detail (DB-backed), fallback to live feed
  const coinWhaleAlerts = useMemo(() => {
    if (detail?.whaleAlerts?.length) return detail.whaleAlerts;
    return whaleAlerts.filter(a => a.coin === coin);
  }, [detail, whaleAlerts, coin]);

  const fundingData = useMemo(() => {
    if (!detail?.funding?.length) return [];
    return detail.funding.slice(-48).map(f => ({
      time: f.time,
      rate: f.rate * 100,
      annualized: f.annualized,
    }));
  }, [detail]);

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    if (interval === "1M") return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
    if (interval === "1w" || interval === "1d") return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  };

  const formatPrice = (p: number) => {
    if (p >= 10000) return p.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (p >= 1) return p.toFixed(2);
    return p.toPrecision(4);
  };

  const [coinDropdownOpen, setCoinDropdownOpen] = useState(false);
  const [search, setSearch] = useState("");
  type FilterType = "All" | "Perps" | "Spot" | "Crypto" | "Tradfi" | "Trending";
  const [filter, setFilter] = useState<FilterType>("All");
  const [sortCol, setSortCol] = useState<"volume" | "change" | "oi" | "funding">("volume");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setCoinDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Focus search when dropdown opens
  useEffect(() => {
    if (coinDropdownOpen) {
      setTimeout(() => searchRef.current?.focus(), 50);
    } else {
      setSearch("");
    }
  }, [coinDropdownOpen]);

  const markPx = overview?.markPx ?? overview?.price ?? 0;
  const oraclePx = overview?.oraclePx ?? overview?.price ?? 0;

  // Token classification — matches Hyperliquid's categories
  const TRADFI_TOKENS = new Set(["WTIOIL", "SILVER", "BRENTOIL", "GOLD", "SPX", "S&P500", "XAU", "NIKKEI"]);
  const SPOT_TOKENS = new Set(["HYPE/USDC"]); // spot pairs show differently

  const getTokenCategory = useCallback((coin: string): string[] => {
    const cats: string[] = ["All"];
    if (TRADFI_TOKENS.has(coin)) {
      cats.push("Perps", "Tradfi");
    } else {
      cats.push("Perps", "Crypto");
    }
    return cats;
  }, []);

  // Filtered + sorted tokens for dropdown
  const filteredTokens = useMemo(() => {
    let list = [...tokens];
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(t => t.coin.toLowerCase().includes(q));
    }
    if (filter === "Trending") {
      list = list.filter(t => Math.abs(t.change24h) > 3);
    } else if (filter !== "All") {
      list = list.filter(t => getTokenCategory(t.coin).includes(filter));
    }
    // Sort
    list.sort((a, b) => {
      let av = 0, bv = 0;
      if (sortCol === "volume") { av = a.volume24h; bv = b.volume24h; }
      else if (sortCol === "change") { av = a.change24h; bv = b.change24h; }
      else if (sortCol === "oi") { av = a.openInterest; bv = b.openInterest; }
      else if (sortCol === "funding") { av = a.fundingRate; bv = b.fundingRate; }
      return sortDir === "desc" ? bv - av : av - bv;
    });
    return list;
  }, [tokens, search, filter, sortCol, sortDir, getTokenCategory]);

  const handleSort = (col: typeof sortCol) => {
    if (sortCol === col) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortCol(col); setSortDir("desc"); }
  };

  const sortArrow = (col: typeof sortCol) => sortCol === col ? (sortDir === "desc" ? " ↓" : " ↑") : "";

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Row 1: Coin selector + stats bar (like HL) */}
      <div className="flex items-center border-b border-[var(--hl-border)] px-3 py-1.5 shrink-0">
        {/* Coin dropdown */}
        <div className="relative flex-shrink-0" ref={dropdownRef}>
          <button
            onClick={() => setCoinDropdownOpen(!coinDropdownOpen)}
            className="flex items-center gap-1.5 pr-3 mr-3 border-r border-[var(--hl-border)]"
          >
            <span className="text-[15px] font-bold text-[var(--foreground)]">{coin}-USDC</span>
            <svg width="10" height="6" viewBox="0 0 10 6" fill="none" className="mt-0.5">
              <path d="M1 1L5 5L9 1" stroke="var(--hl-muted)" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          {coinDropdownOpen && (
            <div className="fixed sm:absolute inset-x-2 sm:inset-x-auto top-12 sm:top-full sm:left-0 sm:mt-1 z-50 bg-[var(--background)] border border-[var(--hl-border)] rounded-lg shadow-2xl sm:w-[620px]"
              style={{ maxHeight: "420px" }}
            >
              {/* Search */}
              <div className="px-3 pt-3 pb-2">
                <div className="flex items-center gap-2 bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded px-3 py-1.5">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--hl-muted)" strokeWidth="2">
                    <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
                  </svg>
                  <input
                    ref={searchRef}
                    type="text"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search"
                    className="flex-1 bg-transparent text-[13px] text-[var(--foreground)] outline-none placeholder:text-[var(--hl-muted)]"
                  />
                </div>
              </div>

              {/* Filters */}
              <div className="flex items-center gap-1 px-3 pb-2 overflow-x-auto">
                {(["All", "Perps", "Spot", "Crypto", "Tradfi", "Trending"] as FilterType[]).map(f => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={`px-3 py-1 text-[11px] font-medium rounded transition-colors flex-shrink-0 ${
                      f === filter
                        ? "bg-[var(--hl-green)] text-black"
                        : "text-[var(--hl-muted)] hover:text-[var(--foreground)]"
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>

              {/* Table header */}
              <div className="grid grid-cols-[1fr_80px_90px] sm:grid-cols-[1fr_90px_110px_90px_100px_100px] px-3 py-1 text-[10px] text-[var(--hl-muted)] uppercase border-b border-[var(--hl-border)]">
                <span>Symbol</span>
                <span className="text-right">Last Price</span>
                <span className="text-right cursor-pointer hover:text-[var(--foreground)]" onClick={() => handleSort("change")}>
                  24h{sortArrow("change")}
                </span>
                <span className="text-right cursor-pointer hover:text-[var(--foreground)] hidden sm:block" onClick={() => handleSort("funding")}>
                  8h Funding{sortArrow("funding")}
                </span>
                <span className="text-right cursor-pointer hover:text-[var(--foreground)] hidden sm:block" onClick={() => handleSort("volume")}>
                  Volume{sortArrow("volume")}
                </span>
                <span className="text-right cursor-pointer hover:text-[var(--foreground)] hidden sm:block" onClick={() => handleSort("oi")}>
                  Open Interest{sortArrow("oi")}
                </span>
              </div>

              {/* Token rows */}
              <div className="overflow-y-auto" style={{ maxHeight: "300px" }}>
                {filteredTokens.map(t => (
                  <button
                    key={t.coin}
                    onClick={() => { onSelectToken(t.coin); setCoinDropdownOpen(false); }}
                    className={`w-full grid grid-cols-[1fr_80px_90px] sm:grid-cols-[1fr_90px_110px_90px_100px_100px] px-3 py-1.5 text-[12px] hover:bg-[var(--hl-surface-hover)] transition-colors ${
                      t.coin === coin ? "bg-[var(--hl-surface)]" : ""
                    }`}
                  >
                    <span className="text-left font-medium text-[var(--foreground)] flex items-center gap-1.5">
                      {t.coin === coin && <span className="text-[var(--hl-green)]">●</span>}
                      {t.coin}-USDC
                      {TRADFI_TOKENS.has(t.coin) && (
                        <span className="text-[9px] px-1 py-0 rounded bg-[var(--hl-surface-hover)] text-[var(--hl-green)]">xyz</span>
                      )}
                    </span>
                    <span className="text-right tabular-nums text-[var(--foreground)]">
                      {formatPrice(t.price)}
                    </span>
                    <span className={`text-right tabular-nums ${t.change24h >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                      <span className="sm:hidden">{t.change24h >= 0 ? "+" : ""}{t.change24h.toFixed(2)}%</span>
                      <span className="hidden sm:inline">{(() => {
                        const abs = t.price * Math.abs(t.change24h) / 100;
                        const absStr = abs >= 1 ? abs.toFixed(1) : abs.toPrecision(3);
                        return `${t.change24h >= 0 ? "+" : "-"}${absStr} / ${t.change24h >= 0 ? "+" : ""}${t.change24h.toFixed(2)}%`;
                      })()}</span>
                    </span>
                    <span className={`text-right tabular-nums hidden sm:block ${t.fundingRate >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                      {(t.fundingRate * 100).toFixed(4)}%
                    </span>
                    <span className="text-right tabular-nums text-[var(--foreground)] hidden sm:block">
                      ${t.volume24h.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </span>
                    <span className="text-right tabular-nums text-[var(--foreground)] hidden sm:block">
                      ${t.openInterest.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </span>
                  </button>
                ))}
                {filteredTokens.length === 0 && (
                  <div className="px-3 py-4 text-center text-[12px] text-[var(--hl-muted)]">No tokens found</div>
                )}
              </div>

              {/* Footer shortcuts */}
              <div className="flex items-center gap-4 px-3 py-1.5 border-t border-[var(--hl-border)] text-[10px] text-[var(--hl-muted)]">
                <span>↑↓ Navigate</span>
                <span>Enter Select</span>
                <span>Esc Close</span>
              </div>
            </div>
          )}
        </div>

        {/* Stats bar — like HL's Mark/Oracle/24h/Vol/OI/Funding row */}
        <div className="flex items-center gap-3 sm:gap-4 text-[11px] overflow-x-auto flex-1 min-w-0">
          <div className="flex flex-col shrink-0">
            <span className="text-[9px] text-[var(--hl-muted)] uppercase">Mark</span>
            <span className="text-[var(--foreground)] tabular-nums font-medium">{formatPrice(markPx)}</span>
          </div>
          <div className="flex flex-col shrink-0">
            <span className="text-[9px] text-[var(--hl-muted)] uppercase">Oracle</span>
            <span className="text-[var(--foreground)] tabular-nums font-medium">{formatPrice(oraclePx)}</span>
          </div>
          <div className="flex flex-col shrink-0">
            <span className="text-[9px] text-[var(--hl-muted)] uppercase">24h Change</span>
            {overview ? (
              <span className={`tabular-nums font-medium ${overview.change24h >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                {overview.change24h >= 0 ? "+" : ""}{overview.change24h.toFixed(2)}%
              </span>
            ) : <span className="text-[var(--hl-muted)]">—</span>}
          </div>
          <div className="flex flex-col shrink-0">
            <span className="text-[9px] text-[var(--hl-muted)] uppercase">24h Vol</span>
            <span className="text-[var(--foreground)] tabular-nums font-medium">
              ${overview ? (overview.volume24h / 1e6).toFixed(2) + "M" : "—"}
            </span>
          </div>
          <div className="flex flex-col shrink-0">
            <span className="text-[9px] text-[var(--hl-muted)] uppercase">Open Interest</span>
            <span className="text-[var(--foreground)] tabular-nums font-medium">
              ${overview ? (overview.openInterest / 1e6).toFixed(2) + "M" : "—"}
            </span>
          </div>
          <div className="flex flex-col shrink-0">
            <span className="text-[9px] text-[var(--hl-muted)] uppercase">Funding</span>
            {overview ? (
              <span className={`tabular-nums font-medium ${overview.fundingRate >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                {(overview.fundingRate * 100).toFixed(4)}%
              </span>
            ) : <span className="text-[var(--hl-muted)]">—</span>}
          </div>
        </div>
      </div>

      {/* Row 2: Timeframes */}
      <div className="flex items-center border-b border-[var(--hl-border)] px-3 py-0.5 shrink-0">
        <div className="flex items-center gap-0.5">
          {(["5m", "15m", "1h", "4h", "1d", "1w", "1M"] as Interval[]).map(i => (
            <button
              key={i}
              onClick={() => setInterval(i)}
              className={`px-2 py-0.5 text-[11px] font-medium rounded transition-colors ${
                i === interval
                  ? "text-[var(--foreground)] bg-[var(--hl-surface)]"
                  : "text-[var(--hl-muted)] hover:text-[var(--foreground)]"
              }`}
            >
              {i}
            </button>
          ))}
        </div>
      </div>

      {/* Chart area */}
      <div className="flex-1 min-h-0">
        {loading ? (
          <div className="flex items-center justify-center h-full text-[var(--hl-muted)] text-[12px]">
            Loading {coin} data...
          </div>
        ) : (
          <CandlestickChart
            candles={chartData}
            oiCandles={oiCandles}
            formatTime={formatTime}
            formatPrice={formatPrice}
            walls={detail?.bookAnalysis?.walls}
            currentPrice={overview?.price}
            whaleAlerts={coinWhaleAlerts}
            topTraderFills={detail?.topTraderFills || []}
          />
        )}
      </div>
    </div>
  );
}

// ─── Candlestick Chart (HL-style with OI, zoom/pan, whale markers) ──────────

interface CandleData {
  time: number; open: number; high: number; low: number; close: number; volume: number; bullish: boolean;
}

interface TopTraderFillData {
  time: number;
  side: "buy" | "sell";
  price: number;
  sizeUsd: number;
  trader: string;
}

function CandlestickChart({ candles, oiCandles, formatTime, formatPrice, walls, currentPrice, whaleAlerts = [], topTraderFills = [] }: {
  candles: CandleData[];
  oiCandles: { time: number; open: number; high: number; low: number; close: number; bullish: boolean }[];
  formatTime: (t: number) => string;
  formatPrice: (p: number) => string;
  walls?: { side: string; price: number; size: number; multiplier: number }[] | null;
  currentPrice?: number;
  whaleAlerts?: WhaleAlert[];
  topTraderFills?: TopTraderFillData[];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [visibleCount, setVisibleCount] = useState(60);
  const [offset, setOffset] = useState(0); // 0 = latest candles visible at right edge
  const [priceZoom, setPriceZoom] = useState(1); // 1 = auto-fit, >1 = zoomed in
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startOffset: number } | null>(null);
  const yDragRef = useRef<{ startY: number; startZoom: number } | null>(null);
  const [containerSize, setContainerSize] = useState({ w: 900, h: 400 });

  // Measure container size so SVG viewBox matches pixel dimensions (no stretching)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setContainerSize({ w: Math.round(rect.width), h: Math.round(rect.height) });
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const totalCandles = candles.length;
  const minVisible = 15;
  const maxVisible = Math.min(totalCandles, 500);

  // How many empty candle-widths of padding to show on the right of the latest bar
  const RIGHT_PAD_CANDLES = 6;

  // Reset view when coin changes — show recent data with room to scroll back
  useEffect(() => {
    const total = candles.length;
    // Show at most 60 candles initially, but never more than 60% of total
    // so there's always room to scroll back in time
    const initial = Math.min(60, Math.max(minVisible, Math.floor(total * 0.6)));
    setVisibleCount(initial);
    // Start with negative offset to show padding to the right of the latest candle
    setOffset(-RIGHT_PAD_CANDLES);
    setPriceZoom(1);
  }, [candles.length > 0 ? candles[0].time : 0]);

  // Zoom with mouse wheel — use native event to properly preventDefault
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY > 0 ? 5 : -5;
      setVisibleCount(prev => {
        const next = Math.max(minVisible, Math.min(maxVisible, prev + delta));
        // Allow negative offset (right padding) down to -half of visible count
        const minOff = -Math.floor(next / 2);
        setOffset(o => Math.max(minOff, Math.min(Math.max(0, totalCandles - next), o)));
        return next;
      });
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [maxVisible, totalCandles]);

  // Pan with mouse drag on chart area, Y-zoom on price axis
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * containerSize.w;

    if (svgX > containerSize.w - 70) { // MR=70 — clicking on price axis
      yDragRef.current = { startY: e.clientY, startZoom: priceZoom };
    } else {
      dragRef.current = { startX: e.clientX, startOffset: offset };
    }
    e.preventDefault();
  }, [offset, priceZoom]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!svgRef.current) return;

    // Y-axis drag for price zoom
    if (yDragRef.current) {
      const dy = e.clientY - yDragRef.current.startY;
      const sensitivity = 0.005;
      // Drag up = zoom in (higher zoom), drag down = zoom out
      const newZoom = Math.max(0.3, Math.min(5, yDragRef.current.startZoom - dy * sensitivity));
      setPriceZoom(newZoom);
      return;
    }

    // X-axis drag for panning
    if (!dragRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const pxPerCandle = rect.width / visibleCount;
    const dx = e.clientX - dragRef.current.startX;
    const candleDelta = Math.round(dx / pxPerCandle);
    const maxOff = Math.max(0, totalCandles - visibleCount);
    // Allow negative offset (right padding) — up to half the visible candles
    const minOff = -Math.floor(visibleCount / 2);
    setOffset(Math.max(minOff, Math.min(maxOff, dragRef.current.startOffset + candleDelta)));
  }, [visibleCount, totalCandles]);

  const handleMouseUp = useCallback(() => {
    dragRef.current = null;
    yDragRef.current = null;
  }, []);

  if (!candles.length) {
    return <div className="flex items-center justify-center h-full text-[var(--hl-muted)] text-[12px]">No data</div>;
  }

  // Visible slice: offset is from the RIGHT (0 = latest at edge, negative = padding right)
  // When offset < 0, we still show latest candles but leave empty space on right
  const effectiveOffset = Math.max(0, offset);
  const rightPadding = offset < 0 ? -offset : 0; // empty candle-widths on the right
  const sliceEnd = totalCandles - effectiveOffset;
  const sliceStart = Math.max(0, sliceEnd - (visibleCount - rightPadding));
  const data = candles.slice(sliceStart, sliceEnd);
  const hasOI = oiCandles.length > 0;

  // Matching OI candles for visible range — align by index when same length,
  // otherwise match by timestamp
  let visibleOI: typeof oiCandles = [];
  if (hasOI) {
    if (oiCandles.length === totalCandles) {
      // Same length: direct slice
      visibleOI = oiCandles.slice(sliceStart, sliceEnd);
    } else {
      // Different length: align from the right (most recent)
      const oiOffset = totalCandles - oiCandles.length;
      visibleOI = oiCandles.slice(
        Math.max(0, sliceStart - oiOffset),
        Math.max(0, sliceEnd - oiOffset)
      );
    }
  }

  // Price domain — apply Y-axis zoom around midpoint
  const rawPriceMin = Math.min(...data.map(c => c.low));
  const rawPriceMax = Math.max(...data.map(c => c.high));
  const rawPad = (rawPriceMax - rawPriceMin) * 0.04 || 1;
  const midPrice = (rawPriceMin + rawPriceMax) / 2;
  const halfRange = ((rawPriceMax - rawPriceMin) / 2 + rawPad) / priceZoom;
  const domainMin = midPrice - halfRange;
  const domainMax = midPrice + halfRange;

  const maxVol = Math.max(...data.map(c => c.volume));
  // Hide volume section if >70% of visible candles have 0 volume (e.g. older monthly data)
  const volCandlesWithData = data.filter(c => c.volume > 0).length;
  const hasVolume = volCandlesWithData > data.length * 0.3;

  // OI domain
  let oiMin = 0, oiMax = 0;
  if (visibleOI.length > 0) {
    oiMin = Math.min(...visibleOI.map(c => c.low));
    oiMax = Math.max(...visibleOI.map(c => c.high));
    const oiPad = (oiMax - oiMin) * 0.1 || 1;
    oiMin -= oiPad;
    oiMax += oiPad;
  }

  // Layout — SVG viewBox matches container pixel size (no stretching)
  const W = containerSize.w, H = containerSize.h;
  const ML = 0, MR = 70, MT = 8, MB = 20;
  const volH = hasVolume ? 60 : 0;
  const oiH = visibleOI.length > 0 ? 80 : 0;
  const priceH = H - MT - MB - volH - oiH;
  const chartW = W - ML - MR;

  const hovered = hover !== null && hover < data.length ? data[hover] : null;
  const hoveredOI = hover !== null && hover < visibleOI.length ? visibleOI[hover] : null;

  // Size candles based on total visible slots (data + right padding)
  const totalSlots = data.length + rightPadding;
  const candleW = chartW / totalSlots;
  const bodyW = Math.max(candleW * 0.65, 2);

  const priceY = (p: number) => MT + (1 - (p - domainMin) / (domainMax - domainMin)) * priceH;
  const volY = (v: number) => MT + priceH + volH - (maxVol > 0 ? (v / maxVol) * (volH - 4) : 0);
  const oiY = (val: number) => {
    const oiTop = MT + priceH + volH;
    return oiTop + (1 - (val - oiMin) / (oiMax - oiMin)) * oiH;
  };

  // Map top trader fills to candle indices for chart dots
  const candleDuration = data.length > 1 ? data[1].time - data[0].time : 3600_000;
  // Visible time range
  const visibleStart = data[0].time;
  const visibleEnd = data[data.length - 1].time + candleDuration;

  const whaleMarkers: { candleIdx: number; isBuy: boolean; price: number; name: string; size: number }[] = [];
  if (data.length >= 2) {
    // Use top trader fills (preferred) or whale alerts as fallback
    const fills = topTraderFills.filter(f => f.time >= visibleStart && f.time < visibleEnd);
    for (const fill of fills) {
      for (let i = 0; i < data.length; i++) {
        if (fill.time >= data[i].time && fill.time < data[i].time + candleDuration) {
          whaleMarkers.push({
            candleIdx: i,
            isBuy: fill.side === "buy",
            price: fill.price,
            name: fill.trader,
            size: fill.sizeUsd,
          });
          break;
        }
      }
    }
  }

  // Y-axis ticks for price
  const priceTicks = 6;
  const priceStep = (domainMax - domainMin) / priceTicks;

  // X-axis labels
  const xLabelInterval = Math.max(Math.floor(data.length / 6), 1);

  return (
    <div className="h-full flex flex-col relative overflow-hidden">
      {/* OHLCV overlay */}
      <div className="absolute top-1 left-2 z-10 flex items-center gap-1.5 sm:gap-3 text-[10px] sm:text-[12px] tabular-nums pointer-events-none">
        {hovered ? (
          <>
            <span className="text-[var(--hl-muted)]">{formatTime(hovered.time)}</span>
            <span className="text-[var(--hl-muted)]">O <span className="text-[var(--foreground)]">{formatPrice(hovered.open)}</span></span>
            <span className="text-[var(--hl-muted)]">H <span className="text-[var(--foreground)]">{formatPrice(hovered.high)}</span></span>
            <span className="text-[var(--hl-muted)]">L <span className="text-[var(--foreground)]">{formatPrice(hovered.low)}</span></span>
            <span className="text-[var(--hl-muted)]">C <span className={hovered.bullish ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}>{formatPrice(hovered.close)}</span></span>
            {hovered.volume > 0 && <span className="text-[var(--hl-muted)]">V <span className="text-[var(--foreground)]">{(hovered.volume / 1e6).toFixed(2)}M</span></span>}
            {hoveredOI && (
              <span className="text-[var(--hl-muted)]">OI <span className="text-[var(--foreground)]">${(hoveredOI.close / 1e6).toFixed(1)}M</span></span>
            )}
          </>
        ) : (
          <span className="text-[var(--hl-muted)]">
            {data.length > 0 && formatTime(data[data.length - 1].time)}
          </span>
        )}
      </div>

      <div ref={containerRef} className="flex-1 min-h-0 overflow-hidden" style={{ cursor: dragRef.current ? "grabbing" : yDragRef.current ? "ns-resize" : "crosshair" }}>
        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          onMouseDown={handleMouseDown}
          onMouseMove={(e) => {
            handleMouseMove(e);
            // Hover detection — only when not dragging
            if (!dragRef.current && !yDragRef.current && svgRef.current) {
              const rect = svgRef.current.getBoundingClientRect();
              const svgX = ((e.clientX - rect.left) / rect.width) * W;
              // Change cursor when over price axis
              if (svgX > W - MR) {
                (e.currentTarget.parentElement as HTMLElement).style.cursor = "ns-resize";
              } else {
                (e.currentTarget.parentElement as HTMLElement).style.cursor = "crosshair";
              }
              const idx = Math.floor((svgX - ML) / candleW);
              if (idx >= 0 && idx < data.length) setHover(idx);
              else setHover(null);
            }
          }}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => { setHover(null); handleMouseUp(); }}
          onDoubleClick={() => setPriceZoom(1)} // Double-click resets Y zoom
          style={{ display: "block" }}
        >
          {/* Grid lines */}
          {Array.from({ length: priceTicks + 1 }, (_, i) => {
            const price = domainMin + priceStep * i;
            const y = priceY(price);
            return (
              <g key={`grid-${i}`}>
                <line x1={ML} y1={y} x2={W - MR} y2={y} stroke="var(--hl-border)" strokeWidth={0.5} />
                <text x={W - MR + 4} y={y + 4} fill="var(--foreground)" fontSize={11} fontFamily="monospace">
                  {formatPrice(price)}
                </text>
              </g>
            );
          })}

          {/* Current price line */}
          {currentPrice && currentPrice >= domainMin && currentPrice <= domainMax && (
            <g>
              <line
                x1={ML} y1={priceY(currentPrice)} x2={W - MR} y2={priceY(currentPrice)}
                stroke="var(--hl-green)" strokeWidth={0.8} strokeDasharray="3 2" strokeOpacity={0.6}
              />
              <rect x={W - MR} y={priceY(currentPrice) - 8} width={MR - 2} height={16} fill="var(--hl-green)" rx={2} />
              <text x={W - MR + 4} y={priceY(currentPrice) + 4} fill="black" fontSize={11} fontWeight="bold" fontFamily="monospace">
                {formatPrice(currentPrice)}
              </text>
            </g>
          )}

          {/* Wall reference lines */}
          {walls?.slice(0, 4).map((w, i) => {
            const y = priceY(w.price);
            if (y < MT || y > MT + priceH) return null;
            return (
              <line key={`wall-${i}`} x1={ML} y1={y} x2={W - MR} y2={y}
                stroke={w.side === "bid" ? "var(--hl-green)" : "var(--hl-red)"}
                strokeDasharray="4 4" strokeOpacity={0.3} strokeWidth={1}
              />
            );
          })}

          {/* Separator lines */}
          <line x1={ML} y1={MT + priceH} x2={W - MR} y2={MT + priceH} stroke="var(--hl-border)" strokeWidth={0.5} />
          {visibleOI.length > 0 && (
            <line x1={ML} y1={MT + priceH + volH} x2={W - MR} y2={MT + priceH + volH} stroke="var(--hl-border)" strokeWidth={0.5} />
          )}

          {/* Volume label */}
          {hasVolume && <text x={4} y={MT + priceH + 12} fill="var(--hl-text)" fontSize={10} fontFamily="monospace">Volume</text>}

          {/* OI label + axis */}
          {visibleOI.length > 0 && <text x={4} y={MT + priceH + volH + 12} fill="var(--hl-text)" fontSize={10} fontFamily="monospace">Open Interest</text>}
          {visibleOI.length > 0 && [0, 0.5, 1].map((pct, i) => {
            const val = oiMin + (oiMax - oiMin) * pct;
            const y = oiY(val);
            return (
              <text key={`oi-tick-${i}`} x={W - MR + 4} y={y + 4} fill="var(--foreground)" fontSize={10} fontFamily="monospace">
                {(val / 1e6).toFixed(0)}M
              </text>
            );
          })}

          {/* Candlesticks */}
          {data.map((c, i) => {
            const x = ML + i * candleW;
            const bodyX = x + (candleW - bodyW) / 2;
            const wickX = x + candleW / 2;

            const openY = priceY(c.open);
            const closeY = priceY(c.close);
            const highY = priceY(c.high);
            const lowY = priceY(c.low);

            const bodyTop = Math.min(openY, closeY);
            const bodyHeight = Math.max(Math.abs(openY - closeY), 1);
            const color = c.bullish ? "var(--hl-green)" : "var(--hl-red)";

            const vY = volY(c.volume);
            const vH = MT + priceH + volH - vY;

            return (
              <g key={i}>
                <line x1={wickX} y1={highY} x2={wickX} y2={lowY} stroke={color} strokeWidth={1} />
                <rect x={bodyX} y={bodyTop} width={bodyW} height={bodyHeight} fill={color} rx={0.5} />
                {hasVolume && <rect x={bodyX} y={vY} width={bodyW} height={Math.max(vH, 0)} fill={color} opacity={0.3} />}
              </g>
            );
          })}

          {/* OI Candlesticks */}
          {visibleOI.map((c, i) => {
            if (i >= data.length) return null;
            const x = ML + i * candleW;
            const bx = x + (candleW - bodyW) / 2;
            const wx = x + candleW / 2;

            const openOI = oiY(c.open);
            const closeOI = oiY(c.close);
            const highOI = oiY(c.high);
            const lowOI = oiY(c.low);

            const top = Math.min(openOI, closeOI);
            const bh = Math.max(Math.abs(openOI - closeOI), 1);
            const col = c.bullish ? "var(--hl-green)" : "var(--hl-red)";

            return (
              <g key={`oi-${i}`}>
                <line x1={wx} y1={highOI} x2={wx} y2={lowOI} stroke={col} strokeWidth={0.8} />
                <rect x={bx} y={top} width={bodyW} height={bh} fill={col} opacity={0.7} rx={0.5} />
              </g>
            );
          })}

          {/* Whale/shark markers above candles */}
          {(() => {
            // Group by candle, sort by size descending, limit per candle
            const byCandle = new Map<number, typeof whaleMarkers>();
            for (const m of whaleMarkers) {
              const arr = byCandle.get(m.candleIdx) || [];
              arr.push(m);
              byCandle.set(m.candleIdx, arr);
            }
            const elements: React.ReactNode[] = [];
            const R = 6;
            const spacing = R * 2 + 3;
            byCandle.forEach((markers, candleIdx) => {
              const candle = data[candleIdx];
              markers.sort((a, b) => b.size - a.size);
              const capped = markers.slice(0, 3);
              const baseY = priceY(candle.high) - 4; // start above the wick
              capped.forEach((m, j) => {
                const x = ML + candleIdx * candleW + candleW / 2;
                const y = baseY - j * spacing;
                const color = m.isBuy ? "var(--hl-green)" : "var(--hl-red)";
                const isShark = m.size >= 5_000_000;
                elements.push(
                  <g key={`whale-${candleIdx}-${j}`}>
                    <title>{`${m.name}: ${m.isBuy ? "BUY" : "SELL"} $${(m.size / 1e6).toFixed(1)}M @ ${formatPrice(m.price)}`}</title>
                    {/* Outer glow */}
                    <circle cx={x} cy={y} r={R + 2} fill={color} opacity={0.15} />
                    {/* Main circle */}
                    <circle cx={x} cy={y} r={R} fill={color} opacity={0.85} stroke={color} strokeWidth={0.5} />
                    {/* Whale or shark SVG icon inside */}
                    {isShark ? (
                      /* Shark fin icon */
                      <g transform={`translate(${x - 4}, ${y - 4}) scale(0.32)`}>
                        <path d="M4 20 L14 4 L16 14 L24 12 L20 20 Z" fill="white" opacity={0.9} />
                      </g>
                    ) : (
                      /* Whale icon */
                      <g transform={`translate(${x - 4}, ${y - 3.5}) scale(0.35)`}>
                        <path d="M4 12 Q4 6 10 6 Q14 6 16 8 L20 6 L19 10 Q22 12 20 16 Q16 20 10 18 Q4 16 4 12Z" fill="white" opacity={0.9} />
                        <circle cx="9" cy="10" r="1" fill={color} />
                      </g>
                    )}
                  </g>
                );
              });
            });
            return elements;
          })()}

          {/* X-axis labels */}
          {data.map((c, i) => {
            if (i % xLabelInterval !== 0) return null;
            const x = ML + i * candleW + candleW / 2;
            return (
              <text key={`x-${i}`} x={x} y={H - 4} fill="var(--foreground)" fontSize={11} textAnchor="middle" fontFamily="monospace">
                {formatTime(c.time)}
              </text>
            );
          })}

          {/* Crosshair */}
          {hover !== null && !dragRef.current && (
            <>
              <line
                x1={ML + hover * candleW + candleW / 2} y1={0}
                x2={ML + hover * candleW + candleW / 2} y2={H - MB}
                stroke="var(--hl-muted)" strokeWidth={0.5} strokeDasharray="2 2"
              />
              {hovered && (
                <line
                  x1={ML} y1={priceY(hovered.close)} x2={W - MR} y2={priceY(hovered.close)}
                  stroke="var(--hl-muted)" strokeWidth={0.5} strokeDasharray="2 2"
                />
              )}
            </>
          )}
        </svg>
      </div>
    </div>
  );
}

// ─── Funding Rate Chart ─────────────────────────────────────────────────────

function FundingChart({ data, formatTime }: {
  data: { time: number; rate: number; annualized: number }[];
  formatTime: (t: number) => string;
}) {
  if (!data.length) return <div className="flex items-center justify-center h-full text-[var(--hl-muted)] text-[12px]">No funding data</div>;

  const W = 800, H = 300, ML = 0, MR = 55, MT = 20, MB = 20;
  const chartW = W - ML - MR;
  const chartH = H - MT - MB;

  const maxRate = Math.max(...data.map(d => Math.abs(d.rate)));
  const domain = maxRate * 1.2 || 0.01;

  const barW = chartW / data.length;

  return (
    <div className="h-full flex flex-col">
      <p className="text-[10px] text-[var(--hl-muted)] px-3 pt-1">Funding Rate (%) — positive = longs pay shorts</p>
      <div className="flex-1 min-h-0">
        <svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: "block" }}>
          {/* Zero line */}
          <line x1={ML} y1={MT + chartH / 2} x2={W - MR} y2={MT + chartH / 2} stroke="var(--hl-border)" strokeWidth={0.5} />

          {/* Bars */}
          {data.map((d, i) => {
            const x = ML + i * barW;
            const zeroY = MT + chartH / 2;
            const h = (Math.abs(d.rate) / domain) * (chartH / 2);
            const y = d.rate >= 0 ? zeroY - h : zeroY;
            const color = d.rate >= 0 ? "var(--hl-green)" : "var(--hl-red)";
            return (
              <rect key={i} x={x + 1} y={y} width={Math.max(barW - 2, 1)} height={Math.max(h, 1)} fill={color} opacity={0.6} />
            );
          })}

          {/* Y-axis labels */}
          {[-domain, -domain / 2, 0, domain / 2, domain].map((val, i) => {
            const y = MT + (1 - (val + domain) / (2 * domain)) * chartH;
            return (
              <text key={i} x={W - MR + 4} y={y + 4} fill="var(--foreground)" fontSize={10} fontFamily="monospace">
                {val.toFixed(4)}%
              </text>
            );
          })}

          {/* X-axis labels */}
          {data.map((d, i) => {
            if (i % Math.max(Math.floor(data.length / 6), 1) !== 0) return null;
            return (
              <text key={i} x={ML + i * barW + barW / 2} y={H - 4} fill="var(--foreground)" fontSize={11} textAnchor="middle" fontFamily="monospace">
                {formatTime(d.time)}
              </text>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

// ─── Liquidation Heatmap ────────────────────────────────────────────────────

function LiqHeatmap({ clusters, currentPrice }: {
  clusters: { price: number; side: string; totalValue: number; traderCount: number }[];
  currentPrice: number;
}) {
  if (!clusters.length) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--hl-muted)] text-[12px]">
        No liquidation cluster data
      </div>
    );
  }

  const maxVal = Math.max(...clusters.map(c => c.totalValue));

  return (
    <div className="h-full overflow-y-auto p-2">
      <p className="text-[10px] text-[var(--hl-muted)] mb-2">Liquidation Clusters — stacked from sharp trader positions</p>
      <div className="space-y-1">
        {clusters
          .sort((a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice))
          .slice(0, 20)
          .map((c, i) => {
            const pct = (c.totalValue / maxVal) * 100;
            const dist = ((c.price - currentPrice) / currentPrice) * 100;
            return (
              <div key={i} className="flex items-center gap-2 text-[11px]">
                <span className="w-16 text-right tabular-nums text-[var(--foreground)]">
                  ${c.price.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
                <span className={`w-10 text-[10px] tabular-nums ${dist > 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                  {dist > 0 ? "+" : ""}{dist.toFixed(1)}%
                </span>
                <div className="flex-1 h-3 bg-[var(--hl-surface)] rounded overflow-hidden">
                  <div
                    className={`h-full rounded ${c.side === "long" ? "bg-[var(--hl-green)]" : "bg-[var(--hl-red)]"}`}
                    style={{ width: `${pct}%`, opacity: 0.6 }}
                  />
                </div>
                <span className="w-14 text-right text-[10px] text-[var(--hl-muted)]">
                  ${(c.totalValue / 1e6).toFixed(1)}M
                </span>
                <span className={`w-8 text-[10px] ${c.side === "long" ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                  {c.side === "long" ? "L" : "S"} {c.traderCount}
                </span>
              </div>
            );
          })}
      </div>
    </div>
  );
}
