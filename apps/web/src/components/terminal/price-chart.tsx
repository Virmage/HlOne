"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import type { TokenDetail, TokenOverview, WhaleAlert, LiquidationBand } from "@/lib/api";
import { getTokenDetail, getOICandles as fetchOICandles, getCandles as fetchCandlesViaBackend } from "@/lib/api";
import { useAccountInfo } from "@/hooks/use-account-info";

interface PriceChartProps {
  coin: string;
  tokens: TokenOverview[];
  onSelectToken: (coin: string) => void;
  whaleAlerts?: WhaleAlert[];
  liquidationBands?: LiquidationBand[];
}

type Interval = "5m" | "15m" | "1h" | "4h" | "12h" | "1d" | "1w" | "1M";
type DrawingTool = "none" | "trendline" | "hline" | "hray" | "ray";

interface DrawingLine {
  id: string;
  type: "trendline" | "hline" | "hray" | "ray";
  // Stored in price coordinates (not pixels) so they survive zoom/pan
  p1: { time: number; price: number };
  p2?: { time: number; price: number }; // undefined for hline
  color: string;
}

const POLL_INTERVAL = 15_000; // 15 seconds

// ─── Direct HL candle fetch (fast, ~200ms, no backend round-trip) ────────
const HL_API = "https://api.hyperliquid.xyz";
const LOOKBACK: Record<string, number> = {
  "5m": 2 * 86400_000, "15m": 5 * 86400_000, "1h": 14 * 86400_000,
  "4h": 30 * 86400_000, "12h": 60 * 86400_000, "1d": 365 * 86400_000, "1w": 3 * 365 * 86400_000, "1M": 5 * 365 * 86400_000,
};

type CandleRaw = { t: number; o: string; h: string; l: string; c: string; v: string };

// Client-side candle cache — switching back to a previously loaded interval is instant
const candleCache = new Map<string, { candles: TokenDetail["candles"]; fetchedAt: number }>();
const CANDLE_CACHE_TTL = 30_000; // 30s — stale candles shown instantly, refresh in background

async function fetchCandlesDirect(coin: string, interval: string, retries = 2): Promise<TokenDetail["candles"]> {
  const now = Date.now();
  const startTime = now - (LOOKBACK[interval] || 7 * 86400_000);
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 300 * attempt));
    try {
      const res = await fetch(`${HL_API}/info`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval, startTime, endTime: now } }),
      });
      if (res.status === 429) continue; // rate limited, retry
      if (!res.ok) return [];
      const raw: CandleRaw[] = await res.json();
      const candles = raw.map(c => ({
        time: c.t, open: parseFloat(c.o), high: parseFloat(c.h),
        low: parseFloat(c.l), close: parseFloat(c.c), volume: parseFloat(c.v),
      }));
      candleCache.set(`${coin}:${interval}`, { candles, fetchedAt: Date.now() });
      return candles;
    } catch { continue; }
  }
  return [];
}

function getCachedCandles(coin: string, interval: string): TokenDetail["candles"] | null {
  const cached = candleCache.get(`${coin}:${interval}`);
  if (!cached) return null;
  return cached.candles;
}

export function PriceChart({ coin, tokens, onSelectToken, whaleAlerts = [], liquidationBands }: PriceChartProps) {
  const [interval, setInterval] = useState<Interval>("1h");
  const [detail, setDetail] = useState<TokenDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const pollRef = useRef<ReturnType<typeof globalThis.setInterval> | null>(null);

  const overview = tokens.find(t => t.coin === coin);
  const accountInfo = useAccountInfo();

  // Full detail fetch (initial load + coin change + background poll)
  const prevCoinRef = useRef(coin);
  const prevIntervalRef = useRef(interval);
  useEffect(() => {
    let cancelled = false;
    const coinChanged = prevCoinRef.current !== coin;
    const intervalChanged = prevIntervalRef.current !== interval;
    prevCoinRef.current = coin;
    prevIntervalRef.current = interval;

    if (coinChanged || !detail) {
      // Coin change or first load:
      // 1. Fetch candles + OI in parallel (~200ms each) for instant chart render
      // 2. Fetch full detail in background for funding, whale data etc.
      setLoading(true);
      let fastDone = false;
      // Fast path: candles via backend + OI in parallel
      Promise.all([
        fetchCandlesViaBackend(coin, interval).then(r => r.candles.map(c => ({
          time: c.t, open: parseFloat(c.o), high: parseFloat(c.h),
          low: parseFloat(c.l), close: parseFloat(c.c), volume: parseFloat(c.v),
        }))).catch(e => { console.warn("[PriceChart] fast candle fetch failed:", e); return [] as TokenDetail["candles"]; }),
        fetchOICandles(coin, interval).then(r => r.oiCandles).catch(e => { console.warn("[PriceChart] OI fetch failed:", e); return []; }),
      ]).then(([candles, oiCandles]) => {
        if (cancelled) return;
        if (candles.length > 0) {
          setDetail(prev => {
            if (prev && prev.coin === coin) return { ...prev, candles, ...(oiCandles.length > 0 ? { oiCandles } : {}) };
            return {
              coin, candles, oiCandles: oiCandles || [], whaleAlerts: [],
              topTraderFills: [], funding: [], fundingRegime: "",
              liquidationClusters: [], sharpPositions: [],
              overview: null, score: null, bookAnalysis: null,
              options: null, news: [], social: null, timestamp: Date.now(),
            } as unknown as TokenDetail;
          });
          fastDone = true;
          setLoading(false);
        }
      });
      getTokenDetail(coin, interval)
        .then(d => {
          if (!cancelled) {
            setDetail(d);
            setLoading(false);
            if (d.candles?.length) candleCache.set(`${coin}:${interval}`, { candles: d.candles, fetchedAt: Date.now() });
          }
        })
        .catch(e => { console.error("[PriceChart] getTokenDetail failed:", e); })
        .finally(() => { if (!cancelled && !fastDone) setLoading(false); });
    } else if (intervalChanged) {
      // Interval change: candles + OI change per timeframe.
      // Show cached candles instantly, then fetch fresh via backend (~200ms).
      const cached = getCachedCandles(coin, interval);
      if (cached && cached.length > 0) {
        setDetail(prev => prev ? { ...prev, candles: cached } : prev);
      }
      // Fetch candles + OI in parallel for the new interval
      fetchCandlesViaBackend(coin, interval)
        .then(r => {
          if (cancelled) return;
          const candles = r.candles.map(c => ({
            time: c.t, open: parseFloat(c.o), high: parseFloat(c.h),
            low: parseFloat(c.l), close: parseFloat(c.c), volume: parseFloat(c.v),
          }));
          if (candles.length > 0) {
            candleCache.set(`${coin}:${interval}`, { candles, fetchedAt: Date.now() });
            setDetail(prev => prev ? { ...prev, candles } : prev);
          }
        })
        .catch(e => {
          console.warn("[PriceChart] backend candles failed, trying direct:", e);
          fetchCandlesDirect(coin, interval)
            .then(candles => {
              if (!cancelled && candles.length > 0) {
                setDetail(prev => prev ? { ...prev, candles } : prev);
              }
            })
            .catch(e2 => { console.error("[PriceChart] all candle fetches failed:", e2); });
        });
      // Fetch OI candles for new interval
      fetchOICandles(coin, interval)
        .then(r => {
          if (!cancelled && r.oiCandles?.length > 0) {
            setDetail(prev => prev ? { ...prev, oiCandles: r.oiCandles } : prev);
          }
        })
        .catch(e => { console.warn("[PriceChart] interval OI fetch failed:", e); });
      // Refetch full detail in background for fills/whale events matching new timeframe
      getTokenDetail(coin, interval)
        .then(d => {
          if (!cancelled) {
            setDetail(prev => prev ? {
              ...prev,
              topTraderFills: d.topTraderFills,
              whaleAlerts: d.whaleAlerts,
              funding: d.funding,
              fundingRegime: d.fundingRegime,
            } : prev);
          }
        })
        .catch(e => { console.warn("[PriceChart] interval detail fetch failed:", e); });
    }

    // Poll for live candle updates via backend (skip if tab hidden)
    pollRef.current = globalThis.setInterval(() => {
      if (!cancelled && !document.hidden) {
        fetchCandlesViaBackend(coin, interval)
          .then(r => {
            if (cancelled) return;
            const candles = r.candles.map(c => ({
              time: c.t, open: parseFloat(c.o), high: parseFloat(c.h),
              low: parseFloat(c.l), close: parseFloat(c.c), volume: parseFloat(c.v),
            }));
            if (candles.length > 0) {
              candleCache.set(`${coin}:${interval}`, { candles, fetchedAt: Date.now() });
              setDetail(prev => prev ? { ...prev, candles } : prev);
            }
          })
          .catch(e => { console.warn("[PriceChart] poll failed:", e); });
      }
    }, POLL_INTERVAL);

    return () => {
      cancelled = true;
      if (pollRef.current) globalThis.clearInterval(pollRef.current);
    };
  }, [coin, interval]);

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
    if (detail?.oiCandles && detail.oiCandles.length >= 2) {
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
    if (interval === "1w" || interval === "1d" || interval === "12h") return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  };

  const formatPrice = (p: number) => {
    if (p >= 10000) return p.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (p >= 1) return p.toFixed(2);
    return p.toPrecision(4);
  };

  // SMA overlays — persist to localStorage
  const SMA_PERIODS = [25, 50, 100, 200] as const;
  const SMA_COLORS: Record<number, string> = { 25: "#f59e0b", 50: "#8b5cf6", 100: "#3b82f6", 200: "#ef4444" };
  const ALL_SMAS = new Set(SMA_PERIODS);
  const [smasOn, setSmasOn] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem("hlone_smas_on") !== "0";
  });
  const enabledSMAs = smasOn ? ALL_SMAS : new Set<number>();
  const toggleSMAs = useCallback(() => {
    setSmasOn(prev => {
      const next = !prev;
      localStorage.setItem("hlone_smas_on", next ? "1" : "0");
      return next;
    });
  }, []);

  // Drawing tools — persist to localStorage
  const [magnetMode, setMagnetMode] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("hlone_magnet") === "on";
  });
  const [drawingTool, setDrawingTool] = useState<DrawingTool>("none");
  const [drawings, setDrawings] = useState<DrawingLine[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const saved = localStorage.getItem(`hlone_drawings_${coin}`);
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [pendingDrawing, setPendingDrawing] = useState<Partial<DrawingLine> | null>(null);
  const drawingCounter = useRef(0);

  // Heatmap toggle — persist preference
  const [showHeatmap, setShowHeatmap] = useState(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem("hlone_heatmap") !== "off";
  });

  // Load drawings when coin changes
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`hlone_drawings_${coin}`);
      setDrawings(saved ? JSON.parse(saved) : []);
    } catch { setDrawings([]); }
  }, [coin]);

  // Save drawings to localStorage whenever they change
  useEffect(() => {
    try {
      localStorage.setItem(`hlone_drawings_${coin}`, JSON.stringify(drawings));
    } catch { /* ignore */ }
  }, [drawings, coin]);

  // Save heatmap preference
  useEffect(() => {
    try {
      localStorage.setItem("hlone_heatmap", showHeatmap ? "on" : "off");
    } catch { /* ignore */ }
  }, [showHeatmap]);

  // Save magnet preference
  useEffect(() => {
    try {
      localStorage.setItem("hlone_magnet", magnetMode ? "on" : "off");
    } catch { /* ignore */ }
  }, [magnetMode]);

  const addDrawing = useCallback((d: DrawingLine) => {
    setDrawings(prev => [...prev, d]);
  }, []);

  const removeDrawing = useCallback((id: string) => {
    setDrawings(prev => prev.filter(d => d.id !== id));
  }, []);

  const clearDrawings = useCallback(() => {
    setDrawings([]);
    setPendingDrawing(null);
    setDrawingTool("none");
  }, []);

  const [coinDropdownOpen, setCoinDropdownOpen] = useState(false);
  const [search, setSearch] = useState("");
  type FilterType = "All" | "Perps" | "Spot" | "Tradfi" | "Stocks" | "Indices" | "Commodities" | "FX" | "Trending";
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

  // Filtered + sorted tokens for dropdown
  const filteredTokens = useMemo(() => {
    let list = [...tokens];
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(t => t.coin.toLowerCase().includes(q));
    }
    if (filter === "Trending") {
      list = list.filter(t => Math.abs(t.change24h) > 3);
    } else if (filter === "Perps") {
      list = list.filter(t => !t.isSpot && !t.dex);
    } else if (filter === "Spot") {
      list = list.filter(t => t.isSpot);
    } else if (filter === "Tradfi") {
      list = list.filter(t => !!t.dex && t.category !== "crypto");
    } else if (filter === "Stocks") {
      list = list.filter(t => t.category === "stocks" || t.category === "pre-ipo");
    } else if (filter === "Indices") {
      list = list.filter(t => t.category === "indices" || t.category === "sectors");
    } else if (filter === "Commodities") {
      list = list.filter(t => t.category === "commodities");
    } else if (filter === "FX") {
      list = list.filter(t => t.category === "fx");
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
  }, [tokens, search, filter, sortCol, sortDir]);

  const handleSort = (col: typeof sortCol) => {
    if (sortCol === col) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortCol(col); setSortDir("desc"); }
  };

  const sortArrow = (col: typeof sortCol) => sortCol === col ? (sortDir === "desc" ? " ↓" : " ↑") : "";

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Row 1: Coin selector + stats bar (like HL) */}
      <div className="flex items-center border-b border-[var(--hl-border)] px-1.5 sm:px-3 py-1 sm:py-1.5 shrink-0">
        {/* Coin dropdown */}
        <div className="relative flex-shrink-0" ref={dropdownRef}>
          <button
            onClick={() => setCoinDropdownOpen(!coinDropdownOpen)}
            className="flex items-center gap-1 sm:gap-1.5 pr-2 sm:pr-3 mr-2 sm:mr-3 border-r border-[var(--hl-border)]"
          >
            <span className="text-[13px] sm:text-[15px] font-bold text-[var(--foreground)]">{coin.includes(":") ? coin.split(":")[1] : coin}-USDC</span>
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
                {(["All", "Perps", "Spot", "Tradfi", "Stocks", "Indices", "Commodities", "FX", "Trending"] as FilterType[]).map(f => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={`px-3 py-1 text-[11px] font-medium rounded transition-colors flex-shrink-0 ${
                      f === filter
                        ? "bg-[var(--hl-accent)] text-black"
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
                    onClick={() => { onSelectToken(t.displayName || t.coin); setCoinDropdownOpen(false); }}
                    className={`w-full grid grid-cols-[1fr_80px_90px] sm:grid-cols-[1fr_90px_110px_90px_100px_100px] px-3 py-1.5 text-[12px] hover:bg-[var(--hl-surface-hover)] transition-colors ${
                      (t.coin === coin || t.displayName === coin) ? "bg-[var(--hl-surface)]" : ""
                    }`}
                  >
                    <span className="text-left font-medium text-[var(--foreground)] flex items-center gap-1.5">
                      {t.coin === coin && <span className="text-[var(--hl-accent)]">●</span>}
                      {t.displayName || (t.coin.includes(":") ? t.coin.split(":")[1] : t.coin)}
                      {t.maxLeverage > 1 && (
                        <span className="text-[9px] font-semibold px-1 py-0.5 rounded bg-[rgba(80,210,193,0.15)] text-[var(--hl-green)]">{t.maxLeverage}x</span>
                      )}
                      {t.dex && <span className="text-[9px] text-[var(--hl-muted)] font-normal">{t.dex}</span>}
                      {t.isSpot && <span className="text-[9px] text-[var(--hl-muted)] font-normal">SPOT</span>}
                      {!t.dex && !t.isSpot && <span className="text-[9px] text-[var(--hl-muted)] font-normal">-USDC</span>}
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
                    <span className={`text-right tabular-nums hidden sm:block ${t.isSpot ? "text-[var(--hl-muted)]" : t.fundingRate >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                      {t.isSpot ? "--" : `${(t.fundingRate * 100).toFixed(4)}%`}
                    </span>
                    <span className="text-right tabular-nums text-[var(--foreground)] hidden sm:block">
                      ${t.volume24h.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </span>
                    <span className="text-right tabular-nums hidden sm:block text-[var(--foreground)]">
                      {t.isSpot ? <span className="text-[var(--hl-muted)]">--</span> : `$${t.openInterest.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
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
        <div className="flex items-center gap-2 sm:gap-4 text-[10px] sm:text-[11px] overflow-x-auto scrollbar-none flex-1 min-w-0">
          <div className="flex flex-col shrink-0">
            <span className="text-[8px] sm:text-[9px] text-[var(--hl-muted)] uppercase">Mark</span>
            <span className="text-[var(--foreground)] tabular-nums font-medium">{formatPrice(markPx)}</span>
          </div>
          <div className="flex flex-col shrink-0 hidden sm:flex">
            <span className="text-[9px] text-[var(--hl-muted)] uppercase">Oracle</span>
            <span className="text-[var(--foreground)] tabular-nums font-medium">{formatPrice(oraclePx)}</span>
          </div>
          <div className="flex flex-col shrink-0">
            <span className="text-[8px] sm:text-[9px] text-[var(--hl-muted)] uppercase">24h</span>
            {overview ? (
              <span className={`tabular-nums font-medium ${overview.change24h >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                {overview.change24h >= 0 ? "+" : ""}{overview.change24h.toFixed(2)}%
              </span>
            ) : <span className="text-[var(--hl-muted)]">—</span>}
          </div>
          <div className="flex flex-col shrink-0">
            <span className="text-[8px] sm:text-[9px] text-[var(--hl-muted)] uppercase">Vol</span>
            <span className="text-[var(--foreground)] tabular-nums font-medium">
              ${overview ? (overview.volume24h / 1e6).toFixed(1) + "M" : "—"}
            </span>
          </div>
          <div className="flex flex-col shrink-0 hidden sm:flex">
            <span className="text-[9px] text-[var(--hl-muted)] uppercase">Open Interest</span>
            <span className="text-[var(--foreground)] tabular-nums font-medium">
              ${overview ? (overview.openInterest / 1e6).toFixed(2) + "M" : "—"}
            </span>
          </div>
          <div className="flex flex-col shrink-0">
            <span className="text-[8px] sm:text-[9px] text-[var(--hl-muted)] uppercase">Fund</span>
            {overview ? (
              <span className={`tabular-nums font-medium ${overview.fundingRate >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                {(overview.fundingRate * 100).toFixed(4)}%
              </span>
            ) : <span className="text-[var(--hl-muted)]">—</span>}
          </div>

          {/* Portfolio stats — accent-bordered pill, right of funding (desktop only) */}
          {accountInfo && (
            <>
              <div className="w-px h-5 bg-[var(--hl-border)] shrink-0 mx-1 hidden sm:block" />
              <div className="hidden sm:flex items-center gap-3 shrink-0 px-2.5 py-0.5 rounded-md border border-[var(--hl-accent)]/25 bg-[var(--hl-accent)]/[0.04]">
                <div className="flex flex-col">
                  <span className="text-[9px] text-[var(--hl-accent)] uppercase font-medium">Equity</span>
                  <span className="text-[var(--foreground)] tabular-nums font-bold text-[11px]">
                    ${accountInfo.accountValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[9px] text-[var(--hl-accent)] uppercase font-medium">uPnL</span>
                  <span className={`tabular-nums font-bold text-[11px] ${accountInfo.unrealizedPnl >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                    {accountInfo.unrealizedPnl >= 0 ? "+" : ""}${accountInfo.unrealizedPnl.toFixed(2)}
                  </span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[9px] text-[var(--hl-accent)] uppercase font-medium">Margin</span>
                  <span className="text-[var(--foreground)] tabular-nums font-medium text-[11px]">
                    ${accountInfo.totalMarginUsed.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[9px] text-[var(--hl-accent)] uppercase font-medium">Available</span>
                  <span className="text-[var(--foreground)] tabular-nums font-medium text-[11px]">
                    ${accountInfo.withdrawable.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[9px] text-[var(--hl-accent)] uppercase font-medium">Notional</span>
                  <span className="text-[var(--foreground)] tabular-nums font-medium text-[11px]">
                    ${accountInfo.totalNotional.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[9px] text-[var(--hl-accent)] uppercase font-medium">Positions</span>
                  <span className="text-[var(--foreground)] tabular-nums font-medium text-[11px]">
                    {accountInfo.positionCount}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Row 2: Timeframes */}
      <div className="flex items-center border-b border-[var(--hl-border)] px-1.5 sm:px-3 py-0.5 shrink-0 overflow-x-auto scrollbar-none">
        <div className="flex items-center gap-0">
          {(["5m", "15m", "1h", "4h", "12h", "1d", "1w", "1M"] as Interval[]).map(i => (
            <button
              key={i}
              onClick={() => setInterval(i)}
              className={`px-1.5 sm:px-2 py-0.5 text-[10px] sm:text-[11px] font-medium rounded transition-colors shrink-0 ${
                i === interval
                  ? "text-[var(--foreground)] bg-[var(--hl-surface)]"
                  : "text-[var(--hl-muted)] hover:text-[var(--foreground)]"
              }`}
            >
              {i === "1M" ? "1m" : i}
            </button>
          ))}
        </div>
        {/* SMA + Heatmap toggles */}
        <div className="flex items-center ml-1.5 sm:ml-3 border-l border-[var(--hl-border)] pl-1.5 sm:pl-3 gap-1 sm:gap-1.5 shrink-0">
          <button
            onClick={toggleSMAs}
            className={`px-1.5 sm:px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
              smasOn ? "bg-[var(--hl-accent)] text-[var(--background)]" : "text-[var(--hl-muted)] hover:text-[var(--foreground)]"
            }`}
          >
            SMA
          </button>
          <button
            onClick={() => setShowHeatmap(prev => !prev)}
            className={`px-1.5 sm:px-2 py-0.5 text-[10px] font-medium rounded transition-colors shrink-0 ${
              showHeatmap ? "bg-orange-500/80 text-white" : "text-[var(--hl-muted)] hover:text-[var(--foreground)]"
            }`}
            title={showHeatmap ? "Hide Liquidation Heatmap" : "Show Liquidation Heatmap"}
          >
            <span className="sm:hidden">HM</span>
            <span className="hidden sm:inline">Heatmap</span>
          </button>
        </div>
      </div>

      {/* Chart area with left toolbar */}
      <div className="flex-1 min-h-0 flex">
        {/* Left-side drawing toolbar (TradingView style) — hidden on mobile */}
        <div className="hidden sm:flex flex-col items-center gap-0.5 py-2 px-1 border-r border-[var(--hl-border)] bg-[var(--background)] shrink-0" style={{ width: 32 }}>
          {/* Cross / Cursor — deselect all drawing tools (TV style) */}
          <button
            onClick={() => { setDrawingTool("none"); setPendingDrawing(null); }}
            className={`p-1 rounded transition-colors ${drawingTool === "none" ? "bg-[var(--hl-surface)] text-[var(--hl-accent)]" : "text-[var(--hl-muted)] hover:text-[var(--foreground)]"}`}
            title="Crosshair — view chart"
          >
            <svg width="20" height="20" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.6">
              <line x1="14" y1="2" x2="14" y2="26" />
              <line x1="2" y1="14" x2="26" y2="14" />
            </svg>
          </button>

          <div className="w-5 border-t border-[var(--hl-border)] my-1" />

          {/* Trend Line — diagonal line with endpoint circles (TV style) */}
          <button
            onClick={() => { setDrawingTool(drawingTool === "trendline" ? "none" : "trendline"); setPendingDrawing(null); }}
            className={`p-1 rounded transition-colors ${drawingTool === "trendline" ? "bg-[var(--hl-surface)] text-[var(--hl-accent)]" : "text-[var(--hl-muted)] hover:text-[var(--foreground)]"}`}
            title="Trend Line"
          >
            <svg width="20" height="20" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.6">
              <circle cx="6" cy="22" r="2" fill="currentColor" stroke="none" />
              <circle cx="22" cy="6" r="2" fill="currentColor" stroke="none" />
              <line x1="7" y1="21" x2="21" y2="7" />
            </svg>
          </button>

          {/* Horizontal Line — dashed line spanning full width (TV style) */}
          <button
            onClick={() => { setDrawingTool(drawingTool === "hline" ? "none" : "hline"); setPendingDrawing(null); }}
            className={`p-1 rounded transition-colors ${drawingTool === "hline" ? "bg-[var(--hl-surface)] text-[var(--hl-accent)]" : "text-[var(--hl-muted)] hover:text-[var(--foreground)]"}`}
            title="Horizontal Line"
          >
            <svg width="20" height="20" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.6">
              <line x1="2" y1="14" x2="26" y2="14" strokeDasharray="3 2" />
              <line x1="4" y1="14" x2="24" y2="14" />
            </svg>
          </button>

          {/* Horizontal Ray — horizontal line extending right from click point */}
          <button
            onClick={() => { setDrawingTool(drawingTool === "hray" ? "none" : "hray"); setPendingDrawing(null); }}
            className={`p-1 rounded transition-colors ${drawingTool === "hray" ? "bg-[var(--hl-surface)] text-[var(--hl-accent)]" : "text-[var(--hl-muted)] hover:text-[var(--foreground)]"}`}
            title="Horizontal Ray"
          >
            <svg width="20" height="20" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.6">
              <circle cx="4" cy="14" r="2" fill="currentColor" stroke="none" />
              <line x1="5" y1="14" x2="26" y2="14" />
              <polyline points="22,11 26,14 22,17" strokeWidth="1.4" strokeLinejoin="round" fill="none" />
            </svg>
          </button>

          {/* Ray — line with one endpoint circle and arrow tip (TV style) */}
          <button
            onClick={() => { setDrawingTool(drawingTool === "ray" ? "none" : "ray"); setPendingDrawing(null); }}
            className={`p-1 rounded transition-colors ${drawingTool === "ray" ? "bg-[var(--hl-surface)] text-[var(--hl-accent)]" : "text-[var(--hl-muted)] hover:text-[var(--foreground)]"}`}
            title="Ray"
          >
            <svg width="20" height="20" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.6">
              <circle cx="6" cy="20" r="2" fill="currentColor" stroke="none" />
              <line x1="7" y1="19" x2="26" y2="8" />
              <polyline points="22,7 26,8 24,12" strokeWidth="1.4" strokeLinejoin="round" fill="none" />
            </svg>
          </button>

          <div className="w-5 border-t border-[var(--hl-border)] my-1" />

          {/* Magnet / Snap to candle — horseshoe magnet (TV style) */}
          <button
            onClick={() => setMagnetMode(prev => !prev)}
            className={`p-1 rounded transition-colors ${magnetMode ? "bg-[var(--hl-surface)] text-[var(--hl-accent)]" : "text-[var(--hl-muted)] hover:text-[var(--foreground)]"}`}
            title={magnetMode ? "Magnet On — snapping to candle OHLC" : "Magnet Off — click to enable snap"}
          >
            <svg width="20" height="20" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M7 5v7a7 7 0 0 0 14 0V5" strokeLinecap="round" />
              <line x1="4" y1="5" x2="10" y2="5" strokeLinecap="round" />
              <line x1="18" y1="5" x2="24" y2="5" strokeLinecap="round" />
              <line x1="4" y1="9" x2="10" y2="9" strokeLinecap="round" />
              <line x1="18" y1="9" x2="24" y2="9" strokeLinecap="round" />
            </svg>
          </button>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Clear drawings — trash icon (TV style) */}
          {drawings.length > 0 && (
            <button
              onClick={clearDrawings}
              className="p-1 rounded text-[var(--hl-muted)] hover:text-[var(--hl-red)] transition-colors"
              title="Clear all drawings"
            >
              <svg width="20" height="20" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M6 8h16" strokeLinecap="round" />
                <path d="M8 8v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8" />
                <path d="M11 6h6" strokeLinecap="round" />
                <line x1="12" y1="12" x2="12" y2="18" />
                <line x1="16" y1="12" x2="16" y2="18" />
              </svg>
            </button>
          )}
        </div>

        {/* Chart */}
        <div className="flex-1 min-w-0">
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
            liquidationBands={showHeatmap ? liquidationBands : undefined}
            drawings={drawings}
            pendingDrawing={pendingDrawing}
            drawingTool={drawingTool}
            magnetMode={magnetMode}
            enabledSMAs={enabledSMAs}
            smaColors={SMA_COLORS}
            onDrawingClick={(time, rawPrice) => {
              if (drawingTool === "none") return;
              // Magnet mode: snap price to nearest candle OHLC
              let price = rawPrice;
              if (magnetMode && chartData.length > 0) {
                let bestDist = Infinity;
                for (const c of chartData) {
                  for (const p of [c.open, c.high, c.low, c.close]) {
                    const dist = Math.abs(p - rawPrice);
                    if (dist < bestDist) { bestDist = dist; price = p; }
                  }
                }
              }
              if (drawingTool === "hline" || drawingTool === "hray") {
                drawingCounter.current++;
                addDrawing({
                  id: `d_${drawingCounter.current}`,
                  type: drawingTool,
                  p1: { time, price },
                  color: "var(--hl-green)",
                });
                setDrawingTool("none");
              } else if (drawingTool === "trendline" || drawingTool === "ray") {
                if (!pendingDrawing) {
                  setPendingDrawing({ type: drawingTool, p1: { time, price }, color: "var(--hl-green)" });
                } else {
                  drawingCounter.current++;
                  addDrawing({
                    id: `d_${drawingCounter.current}`,
                    type: drawingTool,
                    p1: pendingDrawing.p1!,
                    p2: { time, price },
                    color: "var(--hl-green)",
                  });
                  setPendingDrawing(null);
                  setDrawingTool("none");
                }
              }
            }}
            onDrawingHover={(time, rawPrice) => {
              if (pendingDrawing && pendingDrawing.p1) {
                let price = rawPrice;
                if (magnetMode && chartData.length > 0) {
                  let bestDist = Infinity;
                  for (const c of chartData) {
                    for (const p of [c.open, c.high, c.low, c.close]) {
                      const dist = Math.abs(p - rawPrice);
                      if (dist < bestDist) { bestDist = dist; price = p; }
                    }
                  }
                }
                setPendingDrawing(prev => prev ? { ...prev, p2: { time, price } } : null);
              }
            }}
            onRemoveDrawing={removeDrawing}
          />
        )}
        </div>
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
  address?: string;
  accountValue?: number;
}

function CandlestickChart({ candles, oiCandles, formatTime, formatPrice, walls, currentPrice, whaleAlerts = [], topTraderFills = [], liquidationBands, drawings = [], pendingDrawing, drawingTool = "none", magnetMode = false, enabledSMAs = new Set(), smaColors = {}, onDrawingClick, onDrawingHover, onRemoveDrawing }: {
  candles: CandleData[];
  oiCandles: { time: number; open: number; high: number; low: number; close: number; bullish: boolean }[];
  formatTime: (t: number) => string;
  formatPrice: (p: number) => string;
  walls?: { side: string; price: number; size: number; multiplier: number }[] | null;
  currentPrice?: number;
  whaleAlerts?: WhaleAlert[];
  topTraderFills?: TopTraderFillData[];
  liquidationBands?: LiquidationBand[];
  drawings?: DrawingLine[];
  pendingDrawing?: Partial<DrawingLine> | null;
  drawingTool?: DrawingTool;
  magnetMode?: boolean;
  enabledSMAs?: Set<number>;
  smaColors?: Record<number, string>;
  onDrawingClick?: (time: number, price: number) => void;
  onDrawingHover?: (time: number, price: number) => void;
  onRemoveDrawing?: (id: string) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [mouseY, setMouseY] = useState<number | null>(null); // raw SVG Y for free crosshair
  const [countdown, setCountdown] = useState(""); // candle close countdown
  const [whalePopup, setWhalePopup] = useState<{ isBuy: boolean; price: number; name: string; size: number; address?: string; accountValue?: number; time: number; screenX: number; screenY: number } | null>(null);
  const [visibleCount, setVisibleCount] = useState(60);
  const [offset, setOffset] = useState(0); // 0 = latest candles visible at right edge
  const [priceZoom, setPriceZoom] = useState(1); // 1 = auto-fit, >1 = zoomed in
  const [pricePanOffset, setPricePanOffset] = useState(0); // vertical pan in price units
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; startOffset: number; startPricePan: number } | null>(null);
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
    // Show at most 60 candles initially, but never more than 30% of total
    // so there's always plenty of room to scroll back in time
    const initial = Math.min(60, Math.max(minVisible, Math.floor(total * 0.3)));
    setVisibleCount(initial);
    // Start with negative offset to show padding to the right of the latest candle
    setOffset(-RIGHT_PAD_CANDLES);
    setPriceZoom(1);
    setPricePanOffset(0);
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
        // Allow dragging freely — no forced clamping to keep candles on screen
        const minOff = -next + 2; // can scroll far right (almost all empty)
        setOffset(o => Math.max(minOff, Math.min(Math.max(0, totalCandles - 2), o)));
        return next;
      });
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [maxVisible, totalCandles]);

  // Touch interactions: 1-finger pan, 2-finger pinch-to-zoom
  const touchRef = useRef<{
    startX: number; startY: number; startOffset: number; startPricePan: number;
    pinchDist?: number; pinchVisible?: number;
  } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const getTouchDist = (t: TouchList) => {
      if (t.length < 2) return 0;
      const dx = t[1].clientX - t[0].clientX;
      const dy = t[1].clientY - t[0].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        // Single finger — pan
        touchRef.current = {
          startX: e.touches[0].clientX,
          startY: e.touches[0].clientY,
          startOffset: offset,
          startPricePan: pricePanOffset,
        };
        e.preventDefault();
      } else if (e.touches.length === 2) {
        // Two fingers — pinch zoom
        touchRef.current = {
          startX: (e.touches[0].clientX + e.touches[1].clientX) / 2,
          startY: (e.touches[0].clientY + e.touches[1].clientY) / 2,
          startOffset: offset,
          startPricePan: pricePanOffset,
          pinchDist: getTouchDist(e.touches),
          pinchVisible: visibleCount,
        };
        e.preventDefault();
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!touchRef.current) return;
      e.preventDefault();

      if (e.touches.length === 2 && touchRef.current.pinchDist) {
        // Pinch zoom
        const newDist = getTouchDist(e.touches);
        const scale = touchRef.current.pinchDist / newDist; // spread = zoom in (fewer candles)
        const newVisible = Math.max(minVisible, Math.min(maxVisible,
          Math.round((touchRef.current.pinchVisible || 60) * scale)
        ));
        setVisibleCount(newVisible);
      } else if (e.touches.length === 1) {
        // Pan
        const rect = el.getBoundingClientRect();
        const pxPerCandle = rect.width / visibleCount;
        const dx = e.touches[0].clientX - touchRef.current.startX;
        const candleDelta = Math.round(dx / pxPerCandle);
        const maxOff = Math.max(0, totalCandles - 2);
        const minOff = -visibleCount + 2;
        setOffset(Math.max(minOff, Math.min(maxOff, touchRef.current.startOffset + candleDelta)));
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length === 0) {
        touchRef.current = null;
      } else if (e.touches.length === 1 && touchRef.current?.pinchDist) {
        // Went from 2 fingers to 1 — restart as single-finger pan
        touchRef.current = {
          startX: e.touches[0].clientX,
          startY: e.touches[0].clientY,
          startOffset: offset,
          startPricePan: pricePanOffset,
        };
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);

    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [offset, pricePanOffset, visibleCount, totalCandles, minVisible, maxVisible]);

  // Convert mouse position to time/price coordinates for drawings
  const mouseToCoords = useCallback((e: React.MouseEvent): { time: number; price: number } | null => {
    if (!svgRef.current || !candles.length) return null;
    const rect = svgRef.current.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * containerSize.w;
    const svgY = ((e.clientY - rect.top) / rect.height) * containerSize.h;
    // Use current domain — will be set after data slice
    return { time: svgX, price: svgY }; // raw SVG coords, converted later
  }, [containerSize, candles.length]);

  // Pan with mouse drag on chart area, Y-zoom on price axis
  // Use window-level listeners so dragging continues outside the chart bounds
  const handleWindowMouseMove = useCallback((e: MouseEvent) => {
    if (!svgRef.current) return;

    // Y-axis drag for price zoom
    if (yDragRef.current) {
      const dy = e.clientY - yDragRef.current.startY;
      const sensitivity = 0.005;
      const newZoom = Math.max(0.3, Math.min(5, yDragRef.current.startZoom - dy * sensitivity));
      setPriceZoom(newZoom);
      return;
    }

    // X+Y axis drag for panning
    if (!dragRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const pxPerCandle = rect.width / visibleCount;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    const candleDelta = Math.round(dx / pxPerCandle);
    const maxOff = Math.max(0, totalCandles - 2);
    const minOff = -visibleCount + 2;
    setOffset(Math.max(minOff, Math.min(maxOff, dragRef.current.startOffset + candleDelta)));
    const pricePxRatio = rect.height * 0.65;
    const priceDelta = (dy / pricePxRatio) * 1;
    setPricePanOffset(dragRef.current.startPricePan + priceDelta);
  }, [visibleCount, totalCandles]);

  const handleWindowMouseUp = useCallback(() => {
    dragRef.current = null;
    yDragRef.current = null;
    window.removeEventListener("mousemove", handleWindowMouseMove);
    window.removeEventListener("mouseup", handleWindowMouseUp);
  }, [handleWindowMouseMove]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!svgRef.current) return;
    setWhalePopup(null);
    const rect = svgRef.current.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * containerSize.w;

    // In drawing mode, don't start dragging — let onClick handle it
    if (drawingTool !== "none" && svgX <= containerSize.w - 70) {
      e.preventDefault();
      return;
    }

    if (svgX > containerSize.w - 70) {
      yDragRef.current = { startY: e.clientY, startZoom: priceZoom };
    } else {
      dragRef.current = { startX: e.clientX, startY: e.clientY, startOffset: offset, startPricePan: pricePanOffset };
    }
    // Attach to window so drag continues outside chart
    window.addEventListener("mousemove", handleWindowMouseMove);
    window.addEventListener("mouseup", handleWindowMouseUp);
    e.preventDefault();
  }, [offset, priceZoom, pricePanOffset, drawingTool, containerSize, handleWindowMouseMove, handleWindowMouseUp]);

  // React handler for SVG hover effects (not drag — drag uses window listeners)
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    // Only handle hover when NOT dragging (drag is handled by window listener)
    if (dragRef.current || yDragRef.current) return;
  }, []);

  const handleMouseUp = useCallback(() => {
    dragRef.current = null;
    yDragRef.current = null;
  }, []);

  // Cleanup window listeners on unmount
  useEffect(() => {
    return () => {
      window.removeEventListener("mousemove", handleWindowMouseMove);
      window.removeEventListener("mouseup", handleWindowMouseUp);
    };
  }, [handleWindowMouseMove, handleWindowMouseUp]);

  // Visible slice: offset is from the RIGHT (0 = latest at edge, negative = padding right)
  // When offset < 0, we still show latest candles but leave empty space on right
  const effectiveOffset = Math.max(0, offset);
  const rightPadding = offset < 0 ? -offset : 0; // empty candle-widths on the right
  const sliceEnd = totalCandles - effectiveOffset;
  const sliceStart = Math.max(0, sliceEnd - (visibleCount - rightPadding));
  const data = candles.slice(sliceStart, sliceEnd);
  const hasOI = oiCandles.length > 0;

  // Match OI candles to price candles by timestamp.
  // Build an array the same length as `data` with OI candle or null per slot.
  let visibleOI: (typeof oiCandles[number] | null)[] = [];
  if (hasOI && data.length > 0) {
    const dur = data.length > 1 ? data[1].time - data[0].time : 3600_000;
    const halfDur = dur / 2;
    // Index OI candles by bucket key for O(1) lookup — try multiple snap points
    const oiByTime = new Map<number, typeof oiCandles[number]>();
    for (const oc of oiCandles) {
      // Snap OI time to the same bucket grid as price candles
      const key = Math.floor(oc.time / dur) * dur;
      oiByTime.set(key, oc);
      // Also index by rounded key in case of slight misalignment
      const keyRound = Math.round(oc.time / dur) * dur;
      if (!oiByTime.has(keyRound)) oiByTime.set(keyRound, oc);
    }
    visibleOI = data.map(d => {
      const key = Math.floor(d.time / dur) * dur;
      return oiByTime.get(key) ?? oiByTime.get(key + dur) ?? oiByTime.get(key - dur) ?? null;
    });
  }

  // Price domain — apply Y-axis zoom and vertical pan
  const rawPriceMin = data.length > 0 ? Math.min(...data.map(c => c.low)) : 0;
  const rawPriceMax = data.length > 0 ? Math.max(...data.map(c => c.high)) : 1;
  const rawPad = (rawPriceMax - rawPriceMin) * 0.04 || 1;
  const rawRange = rawPriceMax - rawPriceMin + rawPad * 2;
  const midPrice = (rawPriceMin + rawPriceMax) / 2;
  const halfRange = ((rawPriceMax - rawPriceMin) / 2 + rawPad) / priceZoom;
  // Apply vertical pan: pricePanOffset is normalized (0-1 range maps to full price range)
  const panAmount = pricePanOffset * rawRange;
  const domainMin = midPrice - halfRange + panAmount;
  const domainMax = midPrice + halfRange + panAmount;

  const maxVol = data.length > 0 ? Math.max(...data.map(c => c.volume)) : 0;
  // Hide volume section if >70% of visible candles have 0 volume (e.g. older monthly data)
  const volCandlesWithData = data.filter(c => c.volume > 0).length;
  const hasVolume = volCandlesWithData > data.length * 0.3;

  // OI domain
  const oiPresent = visibleOI.filter((c): c is NonNullable<typeof c> => c !== null);
  let oiMin = 0, oiMax = 0;
  if (oiPresent.length > 0) {
    oiMin = Math.min(...oiPresent.map(c => c.low));
    oiMax = Math.max(...oiPresent.map(c => c.high));
    const oiPad = (oiMax - oiMin) * 0.1 || 1;
    oiMin -= oiPad;
    oiMax += oiPad;
  }

  // Layout — SVG viewBox matches container pixel size (no stretching)
  const W = containerSize.w, H = containerSize.h;
  const ML = 0, MR = 70, MT = 8, MB = 20;
  const volH = hasVolume ? 60 : 0;
  // Need at least 5 matched OI candles to show the panel (avoids sparse display after restart)
  const showOI = oiPresent.length >= 5;
  const oiH = showOI ? 80 : 0;
  const priceH = H - MT - MB - volH - oiH;
  const chartW = W - ML - MR;

  const hovered = hover !== null && hover < data.length ? data[hover] : null;
  const hoveredOI = hover !== null && hover < visibleOI.length ? visibleOI[hover] ?? null : null;

  // Compute SMA lines from the full candle dataset (not just visible slice)
  // We compute over candles and then slice to visible range
  const smaLines = useMemo(() => {
    if (enabledSMAs.size === 0) return [];
    return [...enabledSMAs].map(period => {
      const values: (number | null)[] = [];
      for (let i = 0; i < candles.length; i++) {
        if (i < period - 1) { values.push(null); continue; }
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += candles[j].close;
        values.push(sum / period);
      }
      // Slice to visible range
      const sliced = values.slice(sliceStart, sliceEnd);
      return { period, color: smaColors[period] || "#888", values: sliced };
    });
  }, [candles, enabledSMAs, smaColors, sliceStart, sliceEnd]);

  // Size candles based on total visible slots (data + right padding)
  const totalSlots = data.length + rightPadding;
  const candleW = chartW / totalSlots;
  const bodyW = Math.max(candleW * 0.65, 2);

  const priceY = (p: number) => MT + (1 - (p - domainMin) / (domainMax - domainMin)) * priceH;
  const yToPrice = (y: number) => domainMax - ((y - MT) / priceH) * (domainMax - domainMin);
  const timeToX = (t: number) => {
    if (!data.length) return ML;
    const dur = data.length > 1 ? data[1].time - data[0].time : 3600_000;
    return ML + ((t - data[0].time) / dur) * candleW + candleW / 2;
  };
  const xToTime = (x: number) => {
    if (!data.length) return 0;
    const dur = data.length > 1 ? data[1].time - data[0].time : 3600_000;
    return data[0].time + ((x - ML - candleW / 2) / candleW) * dur;
  };

  // Handle drawing click on SVG
  const handleDrawingClick = useCallback((e: React.MouseEvent) => {
    if (drawingTool === "none" || !onDrawingClick || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * W;
    const svgY = ((e.clientY - rect.top) / rect.height) * H;
    if (svgX > W - MR || svgY > MT + priceH) return; // only on price area
    const price = yToPrice(svgY);
    const time = xToTime(svgX);
    onDrawingClick(time, price);
  }, [drawingTool, onDrawingClick, W, H, MR, MT, priceH, yToPrice, xToTime]);

  const volY = (v: number) => MT + priceH + volH - (maxVol > 0 ? (v / maxVol) * (volH - 4) : 0);
  const oiY = (val: number) => {
    const oiTop = MT + priceH + volH;
    return oiTop + (1 - (val - oiMin) / (oiMax - oiMin)) * oiH;
  };

  // Candle duration + countdown timer
  const candleDuration = data.length > 1 ? data[1].time - data[0].time : 3600_000;

  useEffect(() => {
    if (!data.length) return;
    const lastCandle = data[data.length - 1];
    const closeTime = lastCandle.time + candleDuration;

    const tick = () => {
      const remaining = closeTime - Date.now();
      if (remaining <= 0) { setCountdown("00:00"); return; }
      const h = Math.floor(remaining / 3600_000);
      const m = Math.floor((remaining % 3600_000) / 60_000);
      const s = Math.floor((remaining % 60_000) / 1000);
      if (h > 0) setCountdown(`${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`);
      else setCountdown(`${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [data.length > 0 ? data[data.length - 1].time : 0, candleDuration]);

  if (!candles.length) {
    return <div className="flex items-center justify-center h-full text-[var(--hl-muted)] text-[12px]">No data</div>;
  }

  // Map top trader fills to candle indices for chart dots
  // Visible time range
  const visibleStart = data[0].time;
  const visibleEnd = data[data.length - 1].time + candleDuration;

  const whaleMarkers: { candleIdx: number; isBuy: boolean; price: number; name: string; size: number; address?: string; accountValue?: number; time: number }[] = [];
  if (data.length >= 2) {
    // Merge top trader fills + whale alerts into unified markers
    // Allow multiple markers per candle (grouped & stacked in rendering)
    const MIN_FILL_SIZE = 10_000; // Only show fills >= $10K
    const fills = topTraderFills.filter(f => f.time >= visibleStart && f.time < visibleEnd && f.sizeUsd >= MIN_FILL_SIZE);

    for (const fill of fills) {
      for (let i = 0; i < data.length; i++) {
        if (fill.time >= data[i].time && fill.time < data[i].time + candleDuration) {
          whaleMarkers.push({
            candleIdx: i,
            isBuy: fill.side === "buy",
            price: fill.price,
            name: fill.trader,
            size: fill.sizeUsd,
            address: fill.address,
            accountValue: fill.accountValue,
            time: fill.time,
          });
          break;
        }
      }
    }

    // Also include whale alerts (may overlap with fills — rendering dedupes per candle)
    const alerts = whaleAlerts.filter(a => a.detectedAt >= visibleStart && a.detectedAt < visibleEnd);
    for (const alert of alerts) {
      for (let i = 0; i < data.length; i++) {
        if (alert.detectedAt >= data[i].time && alert.detectedAt < data[i].time + candleDuration) {
          whaleMarkers.push({
            candleIdx: i,
            isBuy: alert.eventType === "opened_long" || alert.eventType === "increased_long" || alert.eventType === "closed_short",
            price: alert.price,
            name: alert.whaleName,
            size: alert.positionValueUsd,
            address: alert.whaleAddress,
            accountValue: alert.accountValue,
            time: alert.detectedAt,
          });
          break;
        }
      }
    }
  }

  // Y-axis ticks for price
  const priceTicks = 6;
  const priceStep = (domainMax - domainMin) / priceTicks;

  // X-axis labels — fewer on narrow screens to prevent overlap
  const xLabelCount = W < 500 ? 3 : W < 700 ? 4 : 6;
  const xLabelInterval = Math.max(Math.floor(data.length / xLabelCount), 1);

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

      {/* Whale trade popup */}
      {whalePopup && (
        <div className="fixed inset-0 z-40" onClick={() => setWhalePopup(null)}>
          <div
            className="absolute bg-[var(--background)] border border-[var(--hl-border)] rounded-lg shadow-2xl p-3 w-[220px]"
            style={{ left: Math.min(whalePopup.screenX - 110, window.innerWidth - 230), top: Math.max(whalePopup.screenY - 160, 8) }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-2">
              <span className={`text-[11px] font-bold ${whalePopup.isBuy ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                {whalePopup.isBuy ? "BUY" : "SELL"}
              </span>
              <button onClick={() => setWhalePopup(null)} className="text-[var(--hl-muted)] hover:text-[var(--foreground)] text-[14px] leading-none">&times;</button>
            </div>
            <div className="space-y-1.5 text-[11px]">
              <div className="flex justify-between">
                <span className="text-[var(--hl-muted)]">Trader</span>
                <span className="text-[var(--foreground)] font-medium">{whalePopup.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--hl-muted)]">Size</span>
                <span className="text-[var(--foreground)] font-medium tabular-nums">
                  ${whalePopup.size >= 1_000_000 ? `${(whalePopup.size / 1e6).toFixed(2)}M` : `${(whalePopup.size / 1e3).toFixed(1)}K`}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--hl-muted)]">Price</span>
                <span className="text-[var(--foreground)] font-medium tabular-nums">${formatPrice(whalePopup.price)}</span>
              </div>
              {whalePopup.accountValue && (
                <div className="flex justify-between">
                  <span className="text-[var(--hl-muted)]">Account</span>
                  <span className="text-[var(--foreground)] font-medium tabular-nums">
                    ${whalePopup.accountValue >= 1_000_000 ? `${(whalePopup.accountValue / 1e6).toFixed(2)}M` : `${(whalePopup.accountValue / 1e3).toFixed(0)}K`}
                  </span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-[var(--hl-muted)]">Time</span>
                <span className="text-[var(--foreground)] tabular-nums text-[10px]">
                  {new Date(whalePopup.time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
              {whalePopup.address && (
                <div className="pt-1 border-t border-[var(--hl-border)]">
                  <a
                    href={`https://app.hyperliquid.xyz/explorer/address/${whalePopup.address}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] text-[var(--hl-accent)] hover:underline"
                  >
                    View on Explorer &rarr;
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div ref={containerRef} className="flex-1 min-h-0 overflow-hidden" style={{ cursor: drawingTool !== "none" ? "crosshair" : dragRef.current ? "grabbing" : yDragRef.current ? "ns-resize" : "crosshair", touchAction: "none" }}>
        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          onMouseDown={handleMouseDown}
          onClick={(e) => {
            if (drawingTool !== "none") handleDrawingClick(e);
          }}
          onMouseMove={(e) => {
            handleMouseMove(e);
            // Drawing hover preview
            if (drawingTool !== "none" && onDrawingHover && svgRef.current) {
              const rect = svgRef.current.getBoundingClientRect();
              const svgX = ((e.clientX - rect.left) / rect.width) * W;
              const svgY = ((e.clientY - rect.top) / rect.height) * H;
              if (svgX <= W - MR && svgY <= MT + priceH) {
                onDrawingHover(xToTime(svgX), yToPrice(svgY));
              }
            }
            // Hover detection — only when not dragging
            if (!dragRef.current && !yDragRef.current && svgRef.current) {
              const rect = svgRef.current.getBoundingClientRect();
              const svgX = ((e.clientX - rect.left) / rect.width) * W;
              const svgY = ((e.clientY - rect.top) / rect.height) * H;
              // Track raw mouse Y for free crosshair
              if (svgY >= MT && svgY <= MT + priceH) {
                setMouseY(svgY);
              }
              if (drawingTool === "none") {
                // Change cursor when over price axis
                if (svgX > W - MR) {
                  (e.currentTarget.parentElement as HTMLElement).style.cursor = "ns-resize";
                } else {
                  (e.currentTarget.parentElement as HTMLElement).style.cursor = "crosshair";
                }
              }
              const idx = Math.floor((svgX - ML) / candleW);
              if (idx >= 0 && idx < data.length) setHover(idx);
              else setHover(null);
            }
          }}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => { setHover(null); setMouseY(null); }}
          onDoubleClick={() => { if (drawingTool === "none") { setVisibleCount(60); setOffset(0); setPriceZoom(1); setPricePanOffset(0); } }}
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

          {/* Current price line + countdown */}
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
              {/* Candle close countdown */}
              {countdown && (
                <>
                  <rect x={W - MR} y={priceY(currentPrice) + 10} width={MR - 2} height={14} rx={2} fill="var(--hl-surface)" stroke="var(--hl-border)" strokeWidth={0.5} />
                  <text x={W - MR + 4} y={priceY(currentPrice) + 21} fill="var(--hl-muted)" fontSize={9} fontFamily="monospace">
                    {countdown}
                  </text>
                </>
              )}
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

          {/* Liquidation heatmap overlay — colored bands behind candles */}
          {liquidationBands && liquidationBands.length > 0 && (() => {
            // Filter to bands that overlap the visible price range
            const visible = liquidationBands.filter(b =>
              b.priceHigh >= domainMin && b.priceLow <= domainMax &&
              (b.longLiqValue > 0 || b.shortLiqValue > 0)
            );
            if (!visible.length) return null;
            const maxVal = Math.max(...visible.map(b => Math.max(b.longLiqValue, b.shortLiqValue)));
            if (maxVal === 0) return null;
            return visible.map((band, i) => {
              const yTop = priceY(Math.min(band.priceHigh, domainMax));
              const yBot = priceY(Math.max(band.priceLow, domainMin));
              const h = Math.max(yBot - yTop, 2);
              const totalVal = band.longLiqValue + band.shortLiqValue;
              const intensity = totalVal / maxVal;
              // Blue (low) → Yellow (high) intensity gradient
              const r = Math.round(100 + intensity * 155);
              const g = Math.round(160 + intensity * 70);
              const b = Math.round(255 - intensity * 255);
              const opacity = 0.06 + intensity * 0.42;
              const label = band.longLiqValue > 0 && band.shortLiqValue > 0
                ? `Long $${(band.longLiqValue / 1e6).toFixed(1)}M + Short $${(band.shortLiqValue / 1e6).toFixed(1)}M`
                : band.longLiqValue > 0
                ? `Long liqs $${(band.longLiqValue / 1e6).toFixed(1)}M`
                : `Short liqs $${(band.shortLiqValue / 1e6).toFixed(1)}M`;
              return (
                <rect
                  key={`liq-${i}`}
                  x={ML}
                  y={yTop}
                  width={chartW}
                  height={h}
                  fill={`rgba(${r}, ${g}, ${b}, ${opacity})`}
                  rx={1}
                >
                  <title>{`$${band.priceLow.toFixed(0)}–$${band.priceHigh.toFixed(0)}: ${label} (${band.traderCount} traders)`}</title>
                </rect>
              );
            });
          })()}

          {/* User drawings */}
          {drawings.map(d => {
            if (d.type === "hline" || d.type === "hray") {
              const y = priceY(d.p1.price);
              if (y < MT || y > MT + priceH) return null;
              const startX = d.type === "hray" ? timeToX(d.p1.time) : ML;
              return (
                <g key={d.id}>
                  <line x1={startX} y1={y} x2={W - MR} y2={y}
                    stroke={d.color} strokeWidth={1} strokeDasharray={d.type === "hline" ? "6 3" : "none"} />
                  <text x={W - MR + 4} y={y + 3} fill={d.color} fontSize={9} fontFamily="monospace">
                    {formatPrice(d.p1.price)}
                  </text>
                  {d.type === "hray" && <circle cx={startX} cy={y} r={3} fill={d.color} opacity={0.7} />}
                  {/* Delete button */}
                  <circle cx={startX + 8} cy={y} r={5} fill="var(--hl-surface)" stroke={d.color} strokeWidth={0.8}
                    style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); onRemoveDrawing?.(d.id); }} />
                  <text x={startX + 5} y={y + 3} fill={d.color} fontSize={8} style={{ cursor: "pointer", pointerEvents: "none" }}>×</text>
                </g>
              );
            }
            if ((d.type === "trendline" || d.type === "ray") && d.p2) {
              const x1 = timeToX(d.p1.time);
              const y1 = priceY(d.p1.price);
              const x2 = timeToX(d.p2.time);
              const y2 = priceY(d.p2.price);
              // For ray, extend to chart edge
              let ex2 = x2, ey2 = y2;
              if (d.type === "ray" && x2 !== x1) {
                const slope = (y2 - y1) / (x2 - x1);
                ex2 = x2 > x1 ? W - MR : ML;
                ey2 = y1 + slope * (ex2 - x1);
              }
              return (
                <g key={d.id}>
                  <line x1={x1} y1={y1} x2={ex2} y2={ey2}
                    stroke={d.color} strokeWidth={1.2} />
                  <circle cx={x1} cy={y1} r={3} fill={d.color} opacity={0.7} />
                  <circle cx={x2} cy={y2} r={3} fill={d.color} opacity={0.7} />
                  {/* Delete button at midpoint */}
                  <circle cx={(x1+x2)/2} cy={(y1+y2)/2} r={5} fill="var(--hl-surface)" stroke={d.color} strokeWidth={0.8}
                    style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); onRemoveDrawing?.(d.id); }} />
                  <text x={(x1+x2)/2 - 3} y={(y1+y2)/2 + 3} fill={d.color} fontSize={8} style={{ cursor: "pointer", pointerEvents: "none" }}>×</text>
                </g>
              );
            }
            return null;
          })}

          {/* Pending drawing preview */}
          {pendingDrawing?.p1 && pendingDrawing?.p2 && (
            <line
              x1={timeToX(pendingDrawing.p1.time)} y1={priceY(pendingDrawing.p1.price)}
              x2={timeToX(pendingDrawing.p2.time)} y2={priceY(pendingDrawing.p2.price)}
              stroke="var(--hl-green)" strokeWidth={1} strokeDasharray="4 3" opacity={0.6}
            />
          )}

          {/* Separator lines */}
          <line x1={ML} y1={MT + priceH} x2={W - MR} y2={MT + priceH} stroke="var(--hl-border)" strokeWidth={0.5} />
          {showOI && (
            <line x1={ML} y1={MT + priceH + volH} x2={W - MR} y2={MT + priceH + volH} stroke="var(--hl-border)" strokeWidth={0.5} />
          )}

          {/* Volume label */}
          {hasVolume && <text x={4} y={MT + priceH + 12} fill="var(--hl-text)" fontSize={10} fontFamily="monospace">Volume</text>}

          {/* OI label + axis */}
          {showOI && <text x={4} y={MT + priceH + volH + 12} fill="var(--hl-text)" fontSize={10} fontFamily="monospace">Open Interest</text>}
          {showOI && [0, 0.5, 1].map((pct, i) => {
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

          {/* SMA lines */}
          {smaLines.map(sma => {
            const points = sma.values
              .map((v, i) => v !== null ? `${ML + i * candleW + candleW / 2},${priceY(v)}` : null)
              .filter(Boolean);
            if (points.length < 2) return null;
            // Build path segments skipping nulls
            let pathD = "";
            let started = false;
            for (let i = 0; i < sma.values.length; i++) {
              const v = sma.values[i];
              if (v === null) { started = false; continue; }
              const x = ML + i * candleW + candleW / 2;
              const y = priceY(v);
              pathD += started ? `L${x},${y} ` : `M${x},${y} `;
              started = true;
            }
            return (
              <path key={`sma-${sma.period}`} d={pathD} fill="none" stroke={sma.color} strokeWidth={1.2} opacity={0.8} />
            );
          })}

          {/* OI Candlesticks */}
          {showOI && visibleOI.map((c, i) => {
            if (!c || i >= data.length) return null;
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

          {/* OI + Price Divergence markers */}
          {showOI && (() => {
            // Detect divergence: compare OI change vs price change over 3-candle lookback
            const markers: React.ReactNode[] = [];
            const LB = 3; // lookback window
            for (let i = LB; i < data.length; i++) {
              const oi = visibleOI[i];
              const oiPrev = visibleOI[i - LB];
              if (!oi || !oiPrev) continue;

              const priceChange = data[i].close - data[i - LB].close;
              const oiChange = oi.close - oiPrev.close;

              // Both must have meaningful change (>0.5% each)
              const pricePct = Math.abs(priceChange) / data[i - LB].close;
              const oiPct = Math.abs(oiChange) / oiPrev.close;
              if (pricePct < 0.005 || oiPct < 0.005) continue;

              // Divergence: OI rising but price falling, or OI falling but price rising
              const isDiv = (oiChange > 0 && priceChange < 0) || (oiChange < 0 && priceChange > 0);
              if (!isDiv) continue;

              const x = ML + i * candleW + candleW / 2;
              // OI up + price down = bearish divergence (shorts building)
              // OI down + price up = bullish divergence (longs closing, weak rally)
              const isBearish = oiChange > 0 && priceChange < 0;
              const color = isBearish ? "var(--hl-red)" : "var(--hl-green)";
              const label = isBearish ? "▼" : "▲";
              const y = priceY(data[i].low) + 14;

              markers.push(
                <g key={`div-${i}`} opacity={0.8}>
                  <text x={x} y={y} textAnchor="middle" fill={color} fontSize={9} fontWeight="bold">
                    {label}
                  </text>
                  <title>
                    {isBearish ? "Bearish divergence: OI rising while price falling (shorts building)" : "Bullish divergence: OI falling while price rising (weak hands closing)"}
                  </title>
                </g>
              );
            }
            return markers;
          })()}

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
            const R = 5;
            const spacing = R * 2 + 10;
            byCandle.forEach((markers, candleIdx) => {
              const candle = data[candleIdx];
              markers.sort((a, b) => b.size - a.size);
              const capped = markers.slice(0, 3);
              const baseY = priceY(candle.high) - 18; // well above the wick
              capped.forEach((m, j) => {
                const x = ML + candleIdx * candleW + candleW / 2;
                const y = baseY - j * spacing;
                const color = m.isBuy ? "var(--hl-green)" : "var(--hl-red)";
                const emoji = m.size >= 5_000_000 ? "\uD83D\uDC0B" : "\uD83D\uDC33"; // 🐋 (big whale) or 🐳 (whale)
                elements.push(
                  <g key={`whale-${candleIdx}-${j}`} style={{ cursor: "pointer" }} onClick={(e) => {
                    e.stopPropagation();
                    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                    const svgScaleX = rect.width / W;
                    const svgScaleY = rect.height / H;
                    setWhalePopup({
                      isBuy: m.isBuy, price: m.price, name: m.name, size: m.size,
                      address: m.address, accountValue: m.accountValue, time: m.time,
                      screenX: rect.left + x * svgScaleX,
                      screenY: rect.top + y * svgScaleY,
                    });
                  }}>
                    {/* Buy/sell colored ring */}
                    <circle cx={x} cy={y} r={R + 2} fill="none" stroke={color} strokeWidth={1.5} opacity={0.9} />
                    <circle cx={x} cy={y} r={R + 3} fill="none" stroke={color} strokeWidth={0.5} opacity={0.3} />
                    {/* Hit area */}
                    <circle cx={x} cy={y} r={R + 6} fill="transparent" />
                    {/* Emoji */}
                    <text x={x} y={y} textAnchor="middle" dominantBaseline="central" fontSize={m.size >= 5_000_000 ? 10 : 9} style={{ pointerEvents: "none" }}>{emoji}</text>
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
              <text key={`x-${i}`} x={x} y={H - 4} fill="var(--foreground)" fontSize={W < 500 ? 9 : 11} textAnchor="middle" fontFamily="monospace">
                {formatTime(c.time)}
              </text>
            );
          })}

          {/* Crosshair */}
          {hover !== null && !dragRef.current && (
            (() => {
              // Determine horizontal crosshair Y position
              let crossY = mouseY;
              if (magnetMode && hovered) {
                // Magnet ON: snap to nearest OHLC value (body + wicks)
                const rawPrice = mouseY !== null ? yToPrice(mouseY) : hovered.close;
                let bestDist = Infinity;
                let bestPrice = hovered.close;
                for (const p of [hovered.open, hovered.high, hovered.low, hovered.close]) {
                  const dist = Math.abs(p - rawPrice);
                  if (dist < bestDist) { bestDist = dist; bestPrice = p; }
                }
                crossY = priceY(bestPrice);
              }
              const crossPrice = crossY !== null ? yToPrice(crossY) : null;
              return (
                <>
                  <line
                    x1={ML + hover * candleW + candleW / 2} y1={0}
                    x2={ML + hover * candleW + candleW / 2} y2={H - MB}
                    stroke="var(--hl-muted)" strokeWidth={0.5} strokeDasharray="2 2"
                  />
                  {crossY !== null && (
                    <>
                      <line
                        x1={ML} y1={crossY} x2={W - MR} y2={crossY}
                        stroke="var(--hl-muted)" strokeWidth={0.5} strokeDasharray="2 2"
                      />
                      {/* Price label on right axis */}
                      <rect x={W - MR} y={crossY - 8} width={MR - 2} height={16} rx={2} fill="var(--hl-surface)" stroke="var(--hl-border)" strokeWidth={0.5} />
                      <text x={W - MR + 4} y={crossY + 4} fill="var(--foreground)" fontSize={10} fontFamily="monospace">
                        {formatPrice(crossPrice!)}
                      </text>
                    </>
                  )}
                </>
              );
            })()
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
