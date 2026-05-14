"use client";

/**
 * Predictions prototype — single-market view (BTC daily binary).
 *
 * What's REAL:
 *  - Live BTC mark price from /info `allMids` (polled every 3s)
 *  - 24h of 15m candles from /info `candleSnapshot` → drawn as the probability river
 *  - YES probability is computed live from BTC mark vs strike using a simple
 *    GBM-implied formula (24h-realized vol × √(time-to-settle / 24h)). When BTC
 *    moves, the probability moves.
 *  - Time-to-settle is computed from now → next 23:59 UTC.
 *
 * What's SYNTHETIC (to swap when HIP-4 endpoint ships):
 *  - YES/NO order book — derived from synthetic YES with depth scaled by recent BTC volume
 *  - Whale tape — placeholder rows; will swap to existing whale-feed filtered to this market
 *  - Sharp/square — placeholder; existing HLOne classifier doesn't yet ingest HIP-4 outcome flow
 *  - Trade execution — UI-only, no order placement
 *
 * Access: route is unlinked from main nav. Open via /predict?preview=1 on the
 * predict-prototype branch (Vercel preview URL).
 */

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

const HL_INFO = "https://api.hyperliquid.xyz/info";
const HL_WS = "wss://api.hyperliquid.xyz/ws";

// HIP-4 outcome markets are live. HL encodes outcome shares in
// allMids / l2Book / recentTrades as "#<outcome><side>" (side 0 = YES, 1 = NO).
// The active outcome ID rolls each daily settle (06:00 UTC), so we DON'T
// hardcode it — we discover it live from outcomeMeta on every mount.
const yesCoinFor = (outcome: number) => `#${outcome}0`;

// ─── synthetic-market math ──────────────────────────────────────────────────
// GBM implied prob that mark crosses strike by time T given annualised vol σ.
function impliedYesProb(
  mark: number,
  strike: number,
  hoursToSettle: number,
  annualVol = 0.65, // BTC realized vol ballpark
): number {
  if (hoursToSettle <= 0) return mark >= strike ? 0.99 : 0.01;
  const T = hoursToSettle / (365 * 24);
  const sigmaT = annualVol * Math.sqrt(T);
  if (sigmaT < 1e-6) return mark >= strike ? 0.99 : 0.01;
  // log-distance / sigma×√t, then 1 - Φ(z) for "will exceed"
  const z = Math.log(strike / mark) / sigmaT;
  const cdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
  return Math.max(0.01, Math.min(0.99, 1 - cdf(z)));
}
// Abramowitz & Stegun erf
function erf(x: number) {
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return sign * y;
}

// next 23:59 UTC → ms timestamp
function nextSettleUtc(): number {
  const now = new Date();
  const settle = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 0),
  );
  if (settle.getTime() <= now.getTime()) {
    settle.setUTCDate(settle.getUTCDate() + 1);
  }
  return settle.getTime();
}

function fmtCountdown(ms: number) {
  if (ms <= 0) return "00:00:00";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

interface Candle {
  t: number;
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
}

interface BookLevel {
  px: string;
  sz: string;
  n: number;
}
interface HyperOddTrade {
  px: string;
  sz: string;
  side: string;
  time: number;
  coin?: string;
  tid?: number;
}
interface HyperOddState {
  mark: number | null;
  prevDayMark: number | null;
  openInterest: number;
  dayVol: number;
  bids: BookLevel[];
  asks: BookLevel[];
  trades: HyperOddTrade[];
  wsConnected: boolean;
  // HIP-4 metadata parsed from outcomeMeta description
  hip4Outcome: number | null; // the current live binary outcome ID
  hip4Coin: string | null;    // computed YES coin name e.g. "#250"
  hip4Strike: number | null;
  hip4ExpiryMs: number | null;
  hip4Underlying: string | null;
  // 24h of probability-river candles for the live YES coin
  marketCandles: Candle[];
}

interface CompareData {
  kalshi: {
    available: boolean;
    matchedStrike?: number;
    requestedStrike: number;
    yesBid?: number;
    yesAsk?: number;
    yesMid?: number;
    last?: number;
    openInterest?: number;
    closeTime?: string;
    ticker?: string;
    eventTicker?: string;
    error?: string;
  };
  polymarket: {
    available: boolean;
    matchedStrike?: number;
    requestedStrike: number;
    yesPrice?: number;
    eventTitle?: string;
    marketQuestion?: string;
    eventEndDate?: string;
    eventSlug?: string;
    marketSlug?: string;
    eventVolume24h?: number;
    error?: string;
  };
  fetchedAt: number;
}

// ─── component ─────────────────────────────────────────────────────────────
export default function PredictPage() {
  const params = useSearchParams();
  const preview = params?.get("preview") === "1";

  const [btcMark, setBtcMark] = useState<number | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [now, setNow] = useState(0);
  const [stake, setStake] = useState("250");
  const [side, setSide] = useState<"yes" | "no">("yes");
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [limitPx, setLimitPx] = useState<string>("");

  const [compare, setCompare] = useState<CompareData | null>(null);
  const [hyperodd, setHyperodd] = useState<HyperOddState>({
    mark: null,
    prevDayMark: null,
    openInterest: 0,
    dayVol: 0,
    bids: [],
    asks: [],
    trades: [],
    wsConnected: false,
    hip4Outcome: null,
    hip4Coin: null,
    hip4Strike: null,
    hip4ExpiryMs: null,
    hip4Underlying: null,
    marketCandles: [],
  });

  // poll live BTC mark — used as the underlying reference for the settle target widget
  useEffect(() => {
    let cancelled = false;
    const fetchMark = async () => {
      try {
        const res = await fetch(HL_INFO, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "allMids" }),
        });
        if (!res.ok) return;
        const data = await res.json();
        const mark = parseFloat(data.BTC ?? data.btc ?? "0");
        if (!cancelled && mark > 0) setBtcMark(mark);
      } catch {
        /* ignore */
      }
    };
    fetchMark();
    const id = setInterval(fetchMark, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Strike is whatever the live HIP-4 market reports.
  const strike = hyperodd.hip4Strike;

  // fetch 24h of 15m candles once (refresh every 60s)
  useEffect(() => {
    let cancelled = false;
    const fetchCandles = async () => {
      try {
        const end = Date.now();
        const start = end - 24 * 60 * 60 * 1000;
        const res = await fetch(HL_INFO, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "candleSnapshot",
            req: { coin: "BTC", interval: "15m", startTime: start, endTime: end },
          }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as Candle[];
        if (!cancelled && Array.isArray(data)) setCandles(data);
      } catch {
        /* ignore */
      }
    };
    fetchCandles();
    const id = setInterval(fetchCandles, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // ticking clock for countdown — first interval tick (delay 0) sets initial value
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // ── Step 1: discover the current live HIP-4 binary on mount ──────
  // The active outcome ID rolls daily (06:00 UTC), so we MUST query
  // outcomeMeta first and pick whichever outcome currently has
  // class:priceBinary in its description.
  useEffect(() => {
    let cancelled = false;

    const parseHip4Desc = (desc: string) => {
      const parts = Object.fromEntries(
        desc.split("|").map((p) => {
          const [k, v] = p.split(":");
          return [k, v];
        }),
      );
      const expiryStr = parts.expiry as string | undefined;
      let expiryMs: number | null = null;
      if (expiryStr) {
        const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(expiryStr);
        if (m) expiryMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
      }
      return {
        strike: parts.targetPrice ? parseFloat(parts.targetPrice) : null,
        underlying: parts.underlying ?? null,
        expiryMs,
      };
    };

    const fetchOutcomeMeta = async () => {
      try {
        const res = await fetch(HL_INFO, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "outcomeMeta" }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          outcomes: { outcome: number; description: string }[];
        };
        const binary = (data.outcomes ?? []).find((o) =>
          (o.description ?? "").includes("priceBinary"),
        );
        if (!binary || cancelled) return;
        const parsed = parseHip4Desc(binary.description);
        setHyperodd((s) => ({
          ...s,
          hip4Outcome: binary.outcome,
          hip4Coin: yesCoinFor(binary.outcome),
          hip4Strike: parsed.strike,
          hip4ExpiryMs: parsed.expiryMs,
          hip4Underlying: parsed.underlying,
        }));
      } catch { /* ignore */ }
    };

    fetchOutcomeMeta();
    // Re-fetch every 60s so a daily rollover during a long session is picked up.
    const id = setInterval(fetchOutcomeMeta, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // ── Step 2: once we know the coin, subscribe + poll its data ─────
  const hip4Coin = hyperodd.hip4Coin;
  useEffect(() => {
    if (!hip4Coin) return;
    let cancelled = false;
    let ws: WebSocket | null = null;

    const fetchMark = async () => {
      try {
        const res = await fetch(HL_INFO, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "allMids" }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as Record<string, string>;
        const yes = data[hip4Coin];
        if (yes && !cancelled) setHyperodd((s) => ({ ...s, mark: parseFloat(yes) }));
      } catch { /* ignore */ }
    };

    const fetchTrades = async () => {
      try {
        const res = await fetch(HL_INFO, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "recentTrades", coin: hip4Coin }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as HyperOddTrade[];
        if (cancelled || !Array.isArray(data)) return;
        // Keep up to 100 — we'll filter to the chart window + pick biggest
        // notionals for the whale icons.
        setHyperodd((s) => ({ ...s, trades: data.slice(0, 100) }));
      } catch { /* ignore */ }
    };

    const fetchCandles = async () => {
      try {
        const end = Date.now();
        const start = end - 24 * 60 * 60 * 1000;
        const res = await fetch(HL_INFO, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "candleSnapshot",
            req: { coin: hip4Coin, interval: "15m", startTime: start, endTime: end },
          }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as Candle[];
        if (cancelled || !Array.isArray(data)) return;
        setHyperodd((s) => ({ ...s, marketCandles: data }));
      } catch { /* ignore */ }
    };

    // Also pull the L2 book once via REST so the page renders something
    // immediately, before the WS connects.
    const fetchBookOnce = async () => {
      try {
        const res = await fetch(HL_INFO, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "l2Book", coin: hip4Coin }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as { coin?: string; levels?: BookLevel[][] };
        const levels = data?.levels ?? [[], []];
        if (cancelled) return;
        setHyperodd((s) => ({
          ...s,
          bids: (levels[0] as BookLevel[]) ?? [],
          asks: (levels[1] as BookLevel[]) ?? [],
        }));
      } catch { /* ignore */ }
    };

    fetchMark();
    fetchTrades();
    fetchCandles();
    fetchBookOnce();
    const markId = setInterval(fetchMark, 3000);
    const tradeId = setInterval(fetchTrades, 5000);
    const candleId = setInterval(fetchCandles, 60_000);

    // WS for live L2 book + trade stream — both subscribed on the same socket.
    // The trades channel is what gives us real trade-flow-over-time for the
    // chart whales (otherwise recentTrades only returns the last ~30s).
    const connectWs = () => {
      if (cancelled) return;
      try {
        ws = new WebSocket(HL_WS);
        ws.onopen = () => {
          ws?.send(
            JSON.stringify({
              method: "subscribe",
              subscription: { type: "l2Book", coin: hip4Coin },
            }),
          );
          ws?.send(
            JSON.stringify({
              method: "subscribe",
              subscription: { type: "trades", coin: hip4Coin },
            }),
          );
          if (!cancelled) setHyperodd((s) => ({ ...s, wsConnected: true }));
        };
        ws.onmessage = (ev) => {
          if (cancelled) return;
          try {
            const msg = JSON.parse(ev.data);
            if (msg.channel === "l2Book" && msg.data?.coin === hip4Coin) {
              const levels = msg.data.levels ?? [[], []];
              setHyperodd((s) => ({
                ...s,
                bids: (levels[0] as BookLevel[]) ?? [],
                asks: (levels[1] as BookLevel[]) ?? [],
              }));
            } else if (msg.channel === "trades" && Array.isArray(msg.data)) {
              // append new trades — they arrive as arrays of trade objects.
              // Cap accumulated state at 500 entries to avoid memory bloat.
              const incoming = (msg.data as HyperOddTrade[]).filter(
                (t) => t && t.coin === hip4Coin,
              );
              if (incoming.length > 0) {
                setHyperodd((s) => {
                  // Dedupe by `tid` — WS may resend trades on reconnect
                  const tids = new Set(s.trades.map((t) => (t as unknown as { tid?: number }).tid));
                  const newOnes = incoming.filter(
                    (t) => !tids.has((t as unknown as { tid?: number }).tid),
                  );
                  if (newOnes.length === 0) return s;
                  // Newest first, capped at 500
                  const merged = [...newOnes, ...s.trades].slice(0, 500);
                  return { ...s, trades: merged };
                });
              }
            }
          } catch { /* ignore */ }
        };
        ws.onclose = () => {
          if (!cancelled) {
            setHyperodd((s) => ({ ...s, wsConnected: false }));
            setTimeout(connectWs, 3000);
          }
        };
        ws.onerror = () => ws?.close();
      } catch {
        if (!cancelled) setTimeout(connectWs, 3000);
      }
    };
    connectWs();

    return () => {
      cancelled = true;
      clearInterval(markId);
      clearInterval(tradeId);
      clearInterval(candleId);
      if (ws) ws.close();
    };
  }, [hip4Coin]);

  // poll Kalshi + Polymarket comparison every 8s once strike is known
  useEffect(() => {
    if (strike == null) return;
    let cancelled = false;
    const fetchCompare = async () => {
      try {
        const res = await fetch(`/api/predict/compare?strike=${strike}`);
        if (!res.ok) return;
        const data = (await res.json()) as CompareData;
        if (!cancelled) setCompare(data);
      } catch {
        /* ignore */
      }
    };
    fetchCompare();
    const id = setInterval(fetchCompare, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [strike]);

  // settle ts comes from the live HIP-4 expiry (parsed from outcomeMeta);
  // falls back to next 23:59 UTC until that loads.
  const settleTs = useMemo(() => {
    if (hyperodd.hip4ExpiryMs != null) return hyperodd.hip4ExpiryMs;
    return now > 0 ? nextSettleUtc() : 0;
  }, [hyperodd.hip4ExpiryMs, now]);
  const hoursToSettle = (settleTs - now) / (60 * 60 * 1000);

  // current YES probability (live)
  const yesProb = useMemo(() => {
    if (btcMark == null || strike == null) return 0.5;
    return impliedYesProb(btcMark, strike, hoursToSettle);
  }, [btcMark, strike, hoursToSettle]);

  const yesCents = Math.round(yesProb * 100);
  const noCents = 100 - yesCents;

  // Real market probability series — from #200 candles. This is the actual YES
  // price history of the live HIP-4 outcome contract.
  const marketProbSeries = useMemo(() => {
    if (!hyperodd.marketCandles.length) return [] as { x: number; p: number }[];
    return hyperodd.marketCandles.map((c) => ({ x: c.t, p: parseFloat(c.c) }));
  }, [hyperodd.marketCandles]);

  // Fair-value reference — what σ√t says YES should be, given BTC's actual price path.
  const fairProbSeries = useMemo(() => {
    if (!candles.length || strike == null) return [] as { x: number; p: number }[];
    const settle = settleTs;
    return candles.map((c) => {
      const candleEnd = c.t + 15 * 60 * 1000;
      const hrs = Math.max(0.1, (settle - candleEnd) / (60 * 60 * 1000));
      const close = parseFloat(c.c);
      return { x: c.t, p: impliedYesProb(close, strike, hrs) };
    });
  }, [candles, strike, settleTs]);

  // Use the real market series as the primary river when available, fall back
  // to fair-value if HIP-4 candles haven't loaded yet.
  const probSeries = marketProbSeries.length > 0 ? marketProbSeries : fairProbSeries;

  // Standard order-entry math. For YES side: buying at the best ask (market)
  // or at the user's limit. For NO: 1 - ask (since NO price + YES price = $1).
  // Use the HIP-4 live mark if order is "market", else the limit price.
  const liveMark = hyperodd.mark ?? yesCents / 100;
  const liveYesAsk = hyperodd.asks[0] ? parseFloat(hyperodd.asks[0].px) : liveMark;
  const liveYesBid = hyperodd.bids[0] ? parseFloat(hyperodd.bids[0].px) : liveMark;
  const effectiveYesPx =
    orderType === "limit" && parseFloat(limitPx) > 0
      ? parseFloat(limitPx) / 100
      : side === "yes"
        ? liveYesAsk
        : liveYesBid; // buying NO = selling YES, so fill at the bid
  const userPriceFraction = side === "yes" ? effectiveYesPx : 1 - effectiveYesPx;
  const stakeNum = parseFloat(stake) || 0;
  const shares = userPriceFraction > 0 ? stakeNum / userPriceFraction : 0;
  const maxPayout = shares;
  const profit = maxPayout - stakeNum;

  if (!preview) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8 text-center">
        <div className="max-w-md">
          <h1 className="text-2xl font-bold mb-3">Predictions · prototype</h1>
          <p className="text-[var(--hl-muted)] text-sm leading-relaxed">
            HIP-4 outcome markets aren&apos;t live on the public API yet, so this route is staging-only.
            Append <code className="text-[var(--hl-accent)]">?preview=1</code> to view the prototype.
          </p>
        </div>
      </div>
    );
  }

  const distance = btcMark && strike ? strike - btcMark : 0;
  const distancePct = btcMark && strike ? (distance / btcMark) * 100 : 0;

  // ─── render ────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen text-[var(--foreground)]" style={{ background: "var(--background)" }}>
      <style jsx>{`
        .panel { background: var(--hl-surface); border: 1px solid var(--hl-border); }
        .ptitle { font-size: 11px; font-weight: 500; color: var(--hl-accent); text-transform: uppercase; letter-spacing: 0.6px; }
        .psub { font-size: 10px; color: var(--hl-muted); }
        .cellL { font-size: 9px; color: var(--hl-muted); text-transform: uppercase; letter-spacing: 0.5px; }
        .mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-variant-numeric: tabular-nums; }
        .badge-c { padding: 2px 7px; border-radius: 3px; font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; background: rgba(0,240,255,0.08); color: var(--hl-accent); }
        .badge-l { padding: 2px 7px; border-radius: 3px; font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; background: rgba(248,113,113,0.1); color: var(--hl-red); }
        .badge-l::before { content: "● "; }
        .badge-d { padding: 2px 7px; border-radius: 3px; font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; background: rgba(245,165,36,0.12); color: var(--hl-yellow); }
      `}</style>

      {/* LIVE banner */}
      <div
        className="max-w-[1440px] mx-auto px-4 py-1.5 flex items-center gap-3 text-[11px]"
        style={{ background: "rgba(74,222,128,0.06)", borderBottom: "1px solid rgba(74,222,128,0.2)" }}
      >
        <span
          className="mono font-bold"
          style={{ color: "var(--hl-green)", letterSpacing: 0.6, fontSize: 10 }}
        >
          ● LIVE · HIP-4 MAINNET
        </span>
        <span style={{ color: "var(--hl-text)" }}>
          Book + trades + 24h chart pulled live from the real HIP-4 outcome market{" "}
          <code className="mono" style={{ color: "var(--hl-accent)" }}>{hyperodd.hip4Coin ?? "loading…"}</code> on HL mainnet. Trade
          execution still disabled — prototype is a reader.
        </span>
        <span
          className="ml-auto mono text-[10px]"
          style={{ color: hyperodd.wsConnected ? "var(--hl-green)" : "var(--hl-muted)" }}
        >
          {hyperodd.wsConnected ? "● ws live" : "○ ws connecting…"}
        </span>
      </div>

      {/* market strip */}
      <div className="max-w-[1440px] mx-auto px-4 py-3 border-b" style={{ borderColor: "var(--hl-border)" }}>
        <div className="flex items-center gap-3 mb-2 flex-wrap">
          <span className="badge-c">Crypto · Binary · Daily</span>
          {btcMark ? <span className="badge-l">Live</span> : <span className="badge-d">Loading mark…</span>}
          <span className="badge-c">HIP-4 · live mainnet</span>
          <h1 className="text-[17px] font-semibold tracking-tight">
            Will BTC close above ${strike?.toLocaleString() ?? "…"} today?
          </h1>
          <div className="ml-auto flex gap-2">
            <button className="text-[11px] px-3 py-1 rounded" style={{ background: "var(--hl-surface)", border: "1px solid var(--hl-border)", color: "var(--hl-text)" }}>★ Watch</button>
            <button className="text-[11px] px-3 py-1 rounded" style={{ background: "var(--hl-surface)", border: "1px solid var(--hl-border)", color: "var(--hl-text)" }}>Resolution rules</button>
          </div>
        </div>

        <div className="flex items-stretch flex-wrap text-[13px]">
          <Stat label="YES" value={`${yesCents}¢`} cls="text-[var(--hl-green)]" />
          <Stat label="NO" value={`${noCents}¢`} cls="text-[var(--hl-red)]" />
          <Stat label="BTC mark" value={btcMark ? `$${btcMark.toLocaleString(undefined, { maximumFractionDigits: 1 })}` : "—"} cls="" />
          <Stat label="Strike" value={strike ? `$${strike.toLocaleString()}` : "—"} cls="" />
          <Stat label="Distance" value={btcMark ? `${distance >= 0 ? "+" : ""}$${Math.abs(distance).toFixed(0)} (${distancePct >= 0 ? "+" : ""}${distancePct.toFixed(2)}%)` : "—"} cls={distance < 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-yellow)]"} />
          <Stat label="Settles" value={fmtCountdown(settleTs - now)} cls="text-[var(--hl-yellow)]" />
        </div>

        <div
          className="mt-2 px-3 py-2 flex items-center gap-3 text-[11px]"
          style={{ background: "rgba(245,165,36,0.06)", border: "1px solid rgba(245,165,36,0.18)", borderRadius: 4 }}
        >
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--hl-yellow)", boxShadow: "0 0 10px var(--hl-yellow)" }} />
          <span>
            <b className="mono">BTC mark</b> on HyperCore: <b className="mono">{btcMark ? `$${btcMark.toFixed(2)}` : "…"}</b>
          </span>
          <span style={{ color: "var(--hl-muted)" }}>→</span>
          <span>
            {distance > 0
              ? <>needs <b className="mono" style={{ color: "var(--hl-yellow)" }}>+${distance.toFixed(0)} ({distancePct.toFixed(2)}%)</b> to settle <b style={{ color: "var(--hl-green)" }}>YES</b></>
              : <>currently <b className="mono" style={{ color: "var(--hl-green)" }}>${Math.abs(distance).toFixed(0)} above</b> strike — must hold for <b style={{ color: "var(--hl-green)" }}>YES</b></>}
          </span>
          <span className="ml-auto" style={{ color: "var(--hl-muted)" }}>
            Implied prob: <b className="mono" style={{ color: "var(--hl-green)" }}>{(yesProb * 100).toFixed(1)}%</b> · σ·√t at 65% annual vol
          </span>
        </div>

        {/* Compare strip — HLOne implied vs HL testnet (HyperOdd) vs Kalshi vs Polymarket */}
        <CompareStrip yesCents={yesCents} compare={compare} strike={strike} hyperodd={hyperodd} now={now} />
      </div>

      {/* main grid */}
      <main className="max-w-[1440px] mx-auto px-4 py-3 grid gap-3" style={{ gridTemplateColumns: "1fr 320px", alignItems: "start" }}>
        <div className="flex flex-col gap-3 min-w-0">
          <RiverChart
            probSeries={probSeries}
            btcCandles={candles}
            btcMark={btcMark}
            strike={strike}
            settleTs={settleTs}
            now={now}
            yesCents={yesCents}
            kalshiCents={compare?.kalshi.available && compare.kalshi.last != null ? Math.round(compare.kalshi.last * 100) : null}
            kalshiStrike={compare?.kalshi.matchedStrike ?? null}
            polyCents={compare?.polymarket.available && compare.polymarket.yesPrice != null ? Math.round(compare.polymarket.yesPrice * 100) : null}
            polyStrike={compare?.polymarket.matchedStrike ?? null}
            trades={hyperodd.trades}
          />
          <LiveOrderBook hyperodd={hyperodd} yesCents={yesCents} now={now} />
        </div>

        <div className="flex flex-col gap-3 min-w-0">
          <TradePanel
            yesCents={yesCents}
            noCents={noCents}
            stake={stake}
            setStake={setStake}
            side={side}
            setSide={setSide}
            orderType={orderType}
            setOrderType={setOrderType}
            limitPx={limitPx}
            setLimitPx={setLimitPx}
            liveYesBid={liveYesBid}
            liveYesAsk={liveYesAsk}
            effectiveYesPx={effectiveYesPx}
            shares={shares}
            maxPayout={maxPayout}
            profit={profit}
          />
          <div className="panel">
            <div className="px-3 py-2 flex items-center" style={{ borderBottom: "1px solid var(--hl-border)" }}>
              <span className="ptitle">Your position</span>
              <span className="psub ml-auto">on this market</span>
            </div>
            <div className="p-3 text-center text-[11px]" style={{ color: "var(--hl-muted)" }}>
              No position. Drag the dot on the chart to set a price.
            </div>
          </div>
          <div className="panel">
            <div className="px-3 py-2 flex items-center" style={{ borderBottom: "1px solid var(--hl-border)" }}>
              <span className="ptitle">Disclosure</span>
            </div>
            <div className="p-3 text-[11px] leading-relaxed" style={{ color: "var(--hl-muted)" }}>
              <b style={{ color: "var(--hl-green)" }}>HIP-4 went live on mainnet.</b> First market:{" "}
              <code className="mono" style={{ color: "var(--hl-accent)" }}>{hyperodd.hip4Coin ?? "loading…"}</code> — &quot;BTC closes above
              ${hyperodd.hip4Strike?.toLocaleString() ?? "—"} by{" "}
              {hyperodd.hip4ExpiryMs ? new Date(hyperodd.hip4ExpiryMs).toUTCString().slice(0, 22) : "—"} UTC&quot;.
              <br /><br />
              <b style={{ color: "var(--foreground)" }}>Real:</b> live YES mark, full L2 book (20 levels each side), 24h candle history, recent trades, Kalshi BTC daily, Polymarket strike-ladder, BTC mark.
              <br />
              <b style={{ color: "var(--foreground)" }}>Computed:</b> HLOne fair-value (σ√t at 65% annual vol vs live BTC) — shown for comparison.
              <br />
              <b style={{ color: "var(--foreground)" }}>Disabled:</b> trade execution.
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

// ─── small components ──────────────────────────────────────────────────────
function Stat({ label, value, cls }: { label: string; value: string; cls: string }) {
  return (
    <div className="px-3 border-r last:border-r-0 first:pl-0" style={{ borderColor: "var(--hl-border)" }}>
      <div className="cellL">{label}</div>
      <div className={`mono text-[14px] font-semibold ${cls}`}>{value}</div>
    </div>
  );
}

function RiverChart({
  probSeries,
  btcCandles,
  btcMark,
  strike,
  settleTs,
  now,
  yesCents,
  kalshiCents,
  kalshiStrike,
  polyCents,
  polyStrike,
  trades,
}: {
  probSeries: { x: number; p: number }[];
  btcCandles: Candle[];
  btcMark: number | null;
  strike: number | null;
  settleTs: number;
  now: number;
  yesCents: number;
  kalshiCents: number | null;
  kalshiStrike: number | null;
  polyCents: number | null;
  polyStrike: number | null;
  trades: HyperOddTrade[];
}) {
  const W = 800;
  const H = 360;

  // X-axis spans the contract's actual lifetime: 24h ending at settleTs.
  // This way the chart reads as "open → settle" and an in-progress market
  // shows a clear NOW marker, not a half-empty canvas.
  const tMin = settleTs - 24 * 60 * 60 * 1000;
  const tMax = settleTs;

  // BTC y-axis: centered on strike, ±$1500 — covers ~2% daily moves cleanly.
  const btcRange = 1500;
  const btcYMin = strike != null ? strike - btcRange : 80000;
  const btcYMax = strike != null ? strike + btcRange : 82000;
  const btcToY = (price: number) => {
    const t = (price - btcYMin) / (btcYMax - btcYMin);
    return H - Math.max(0, Math.min(1, t)) * H;
  };

  const points = useMemo(() => {
    if (!probSeries.length || !Number.isFinite(tMin) || tMax <= tMin) return "";
    return probSeries
      .map((d) => {
        const x = ((d.x - tMin) / (tMax - tMin)) * W;
        const y = H - d.p * H;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [probSeries, tMin, tMax]);

  const btcPoints = useMemo(() => {
    if (!btcCandles.length || strike == null) return "";
    return btcCandles
      .filter((c) => c.t >= tMin && c.t <= tMax)
      .map((c) => {
        const x = ((c.t - tMin) / (tMax - tMin)) * W;
        const y = btcToY(parseFloat(c.c));
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [btcCandles, strike, tMin, tMax]);

  const areaPath = useMemo(() => {
    if (!points) return "";
    const pts = points.split(" ");
    return `M ${pts[0]} L ${pts.slice(1).join(" L ")} L ${pts[pts.length - 1].split(",")[0]},${H} L ${pts[0].split(",")[0]},${H} Z`;
  }, [points]);

  // Where "now" lands on the chart
  const nowX = now > 0 ? ((now - tMin) / (tMax - tMin)) * W : null;
  // strike line in BTC scale → at exactly the middle of the chart (y = H/2 by construction)
  const strikeY = H / 2;

  const endY = H - (yesCents / 100) * H;
  const kalshiY = kalshiCents != null ? H - (kalshiCents / 100) * H : null;
  const polyY = polyCents != null ? H - (polyCents / 100) * H : null;

  // ── Whales — aggregate same-direction trades within 30s buckets so the
  //    chart doesn't pile a dozen tiny prints on the same pixel. Plot the
  //    biggest 5 aggregates. Buy YES = green border, sell = red.
  const whales = useMemo(() => {
    if (!trades.length) return [] as { x: number; y: number; usd: number; px: number; side: string; count: number }[];
    const inWindow = trades.filter((t) => t.time >= tMin && t.time <= tMax);
    // bucket: same side + same 30s window → aggregate
    type Agg = { tSum: number; pxSum: number; szSum: number; usd: number; count: number; side: string };
    const buckets = new Map<string, Agg>();
    for (const t of inWindow) {
      const px = parseFloat(t.px);
      const sz = parseFloat(t.sz);
      const bucketKey = `${t.side}:${Math.floor(t.time / 30000)}`;
      const usd = px * sz;
      const b = buckets.get(bucketKey);
      if (b) {
        b.tSum += t.time;
        b.pxSum += px;
        b.szSum += sz;
        b.usd += usd;
        b.count += 1;
      } else {
        buckets.set(bucketKey, { tSum: t.time, pxSum: px, szSum: sz, usd, count: 1, side: t.side });
      }
    }
    const aggs = [...buckets.values()]
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 5);
    return aggs.map((a) => {
      const t = a.tSum / a.count;
      const px = a.pxSum / a.count;
      return {
        x: ((t - tMin) / (tMax - tMin)) * W,
        y: H - px * H,
        usd: a.usd,
        px,
        side: a.side,
        count: a.count,
      };
    });
  }, [trades, tMin, tMax]);
  const maxWhaleUsd = whales.reduce((m, w) => Math.max(m, w.usd), 1);

  return (
    <div className="panel" style={{ minHeight: 480 }}>
      <div className="px-3 py-2 flex items-center" style={{ borderBottom: "1px solid var(--hl-border)" }}>
        <span className="ptitle">Probability river</span>
        <span className="psub ml-3">live · computed from BTC mark vs strike</span>
        <div className="ml-auto flex gap-1 text-[10px]" style={{ color: "var(--hl-muted)" }}>
          <button className="px-2 py-0.5 rounded" style={{ background: "var(--hl-surface-hover)", color: "var(--hl-accent)" }}>24H</button>
        </div>
      </div>
      <div className="p-3 flex flex-col">
        <div className="relative" style={{ height: 360 }}>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "calc(100% - 32px)", height: "100%", display: "block" }}>
            <defs>
              <linearGradient id="rgrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#4ade80" stopOpacity="0.28" />
                <stop offset="100%" stopColor="#4ade80" stopOpacity="0" />
              </linearGradient>
            </defs>
            <line x1="0" y1="0" x2={W} y2="0" stroke="#1a2428" />
            <line x1="0" y1={H * 0.25} x2={W} y2={H * 0.25} stroke="#1a2428" strokeDasharray="2,4" />
            <line x1="0" y1={H * 0.5} x2={W} y2={H * 0.5} stroke="#1a2428" strokeDasharray="2,4" />
            <line x1="0" y1={H * 0.75} x2={W} y2={H * 0.75} stroke="#1a2428" strokeDasharray="2,4" />
            <line x1="0" y1={H} x2={W} y2={H} stroke="#1a2428" />
            {/* BTC price line — drawn first so it sits behind the probability river */}
            {btcPoints && (
              <polyline
                fill="none"
                stroke="#f5a524"
                strokeWidth="1.8"
                strokeDasharray="0"
                opacity="0.75"
                points={btcPoints}
              />
            )}

            {/* Strike reference (horizontal line at strike on BTC scale = middle of chart) */}
            {strike != null && (
              <>
                <line
                  x1="0"
                  y1={strikeY}
                  x2={W}
                  y2={strikeY}
                  stroke="#f5a524"
                  strokeWidth="1"
                  strokeDasharray="4,4"
                  opacity="0.35"
                />
              </>
            )}

            {points && <path d={areaPath} fill="url(#rgrad)" />}
            {points && <polyline fill="none" stroke="#4ade80" strokeWidth="2.4" points={points} />}

            {/* NOW vertical line */}
            {nowX != null && nowX > 0 && nowX < W && (
              <>
                <line
                  x1={nowX}
                  y1="0"
                  x2={nowX}
                  y2={H}
                  stroke="#e4f0f4"
                  strokeWidth="1"
                  strokeDasharray="3,3"
                  opacity="0.35"
                />
              </>
            )}

            {/* Kalshi + Polymarket reference lines removed — they were
                confusing without inline labels. Cross-venue values now live
                only in the bottom legend with their matched strikes. */}
          </svg>

          {/* ── Trade-flow icons — aggregated within 30s buckets so we don't
                pile dozens of $5 prints on one pixel. Bigger circle = more $$. ── */}
          {whales.map((w, i) => {
            const isBuy = w.side === "B" || w.side === "buy";
            const sizeFactor = Math.min(1, w.usd / maxWhaleUsd);
            const px = 14 + sizeFactor * 14; // 14-28px diameter
            const usdStr = w.usd >= 1000 ? `$${(w.usd / 1000).toFixed(1)}K` : `$${w.usd.toFixed(0)}`;
            const countSuffix = w.count > 1 ? `×${w.count}` : "";
            return (
              <div
                key={i}
                className="absolute"
                style={{
                  left: `${(w.x / W) * 100}%`,
                  top: `${(w.y / H) * 100}%`,
                  transform: "translate(-50%, -50%)",
                  width: px,
                  height: px,
                  borderRadius: "50%",
                  background: "var(--background)",
                  border: `2px solid ${isBuy ? "var(--hl-green)" : "var(--hl-red)"}`,
                  boxShadow: `0 0 ${8 + sizeFactor * 12}px ${
                    isBuy ? "rgba(74,222,128,0.4)" : "rgba(248,113,113,0.4)"
                  }`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 9 + sizeFactor * 4,
                  zIndex: 3,
                  cursor: "pointer",
                }}
                title={`${isBuy ? "BUY" : "SELL"} YES · ${w.count} trade${w.count > 1 ? "s" : ""} @ ~${(w.px * 100).toFixed(1)}¢ · total ${usdStr}`}
              >
                🐋
                <div
                  className="absolute mono"
                  style={{
                    top: "100%",
                    left: "50%",
                    transform: "translateX(-50%)",
                    marginTop: 2,
                    fontSize: 9,
                    fontWeight: 700,
                    color: isBuy ? "var(--hl-green)" : "var(--hl-red)",
                    background: "var(--hl-surface)",
                    padding: "1px 5px",
                    borderRadius: 2,
                    border: `1px solid ${isBuy ? "var(--hl-green)" : "var(--hl-red)"}`,
                    whiteSpace: "nowrap",
                    pointerEvents: "none",
                  }}
                >
                  {isBuy ? "+" : "−"}{usdStr}{countSuffix}
                </div>
              </div>
            );
          })}

          {/* ── Big inline labels at the right end of EACH line ─────────── */}
          {/* YES probability endpoint label (green) */}
          {nowX != null && (
            <div
              className="absolute mono"
              style={{
                left: `${(nowX / W) * 100}%`,
                top: `${(endY / H) * 100}%`,
                transform: "translate(8px, -50%)",
                background: "var(--hl-green)",
                color: "#001d0c",
                padding: "3px 8px",
                borderRadius: 3,
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: 0.3,
                whiteSpace: "nowrap",
                pointerEvents: "none",
                zIndex: 5,
                boxShadow: "0 0 10px rgba(74,222,128,0.5)",
              }}
            >
              YES · {yesCents}¢
            </div>
          )}
          {/* BTC mark endpoint label (orange) */}
          {nowX != null && btcMark != null && (
            <div
              className="absolute mono"
              style={{
                left: `${(nowX / W) * 100}%`,
                top: `${(btcToY(btcMark) / H) * 100}%`,
                transform: "translate(8px, -50%)",
                background: "var(--hl-yellow)",
                color: "#1d0606",
                padding: "3px 8px",
                borderRadius: 3,
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: 0.3,
                whiteSpace: "nowrap",
                pointerEvents: "none",
                zIndex: 5,
                boxShadow: "0 0 10px rgba(245,165,36,0.5)",
              }}
            >
              BTC · ${btcMark.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </div>
          )}

          {/* RIGHT y-axis — probability (green) */}
          <div
            className="absolute right-0 top-0 bottom-4 flex flex-col justify-between items-end mono"
            style={{ width: 32, fontSize: 10, color: "var(--hl-muted)", padding: "2px 6px", pointerEvents: "none" }}
          >
            <span style={{ color: "var(--hl-green)" }}>100¢</span>
            <span>75¢</span>
            <span>50¢</span>
            <span>25¢</span>
            <span style={{ color: "var(--hl-green)" }}>0¢</span>
          </div>

          {/* LEFT y-axis — BTC price (orange) — labelled at strike ±$1500 */}
          {strike != null && (
            <div
              className="absolute left-0 top-0 bottom-4 flex flex-col justify-between mono"
              style={{ width: 60, fontSize: 9, color: "var(--hl-yellow)", padding: "2px 4px", pointerEvents: "none", opacity: 0.7 }}
            >
              <span>${(strike + 1500).toLocaleString()}</span>
              <span>${(strike + 750).toLocaleString()}</span>
              <span style={{ color: "var(--hl-yellow)", fontWeight: 700 }}>${strike.toLocaleString()} ◀ strike</span>
              <span>${(strike - 750).toLocaleString()}</span>
              <span>${(strike - 1500).toLocaleString()}</span>
            </div>
          )}

          {/* NOW label above the vertical line */}
          {nowX != null && nowX > 30 && nowX < W - 30 && (
            <div
              className="absolute mono"
              style={{
                left: `${(nowX / W) * 100}%`,
                top: 4,
                transform: "translateX(-50%)",
                fontSize: 9,
                color: "var(--foreground)",
                background: "var(--hl-surface)",
                padding: "1px 6px",
                borderRadius: 2,
                border: "1px solid var(--hl-border)",
                pointerEvents: "none",
                letterSpacing: 0.4,
              }}
            >
              NOW
            </div>
          )}

          {/* x-axis — contract lifetime: open → settle */}
          <div
            className="absolute bottom-0 flex justify-between mono"
            style={{
              left: strike != null ? 60 : 0,
              right: 32,
              height: 16,
              fontSize: 9,
              color: "var(--hl-muted)",
              paddingTop: 4,
              borderTop: "1px solid var(--hl-border)",
            }}
          >
            <span>open · 06:00 UTC</span>
            <span>−18h</span>
            <span>−12h</span>
            <span>−6h</span>
            <span>settle ▶</span>
          </div>

          {/* Conviction thumb + arc removed — order entry uses standard limit/market panel */}

          {/* Kalshi label on the right edge */}
          {kalshiCents != null && kalshiY != null && (
            <div
              className="absolute mono"
              style={{
                right: 0, top: `${(kalshiY / H) * 100}%`,
                padding: "2px 6px", background: "var(--hl-yellow)", color: "var(--background)",
                fontSize: 9, fontWeight: 700, borderRadius: 2,
                transform: "translateY(-50%)", whiteSpace: "nowrap", pointerEvents: "none", zIndex: 4,
              }}
              title={kalshiStrike ? `Kalshi @ $${kalshiStrike.toLocaleString()} strike` : "Kalshi"}
            >
              KALSHI {kalshiCents}¢
            </div>
          )}

          {/* Polymarket label on the right edge */}
          {polyCents != null && polyY != null && (
            <div
              className="absolute mono"
              style={{
                right: 0, top: `${(polyY / H) * 100}%`,
                padding: "2px 6px", background: "var(--hl-purple)", color: "white",
                fontSize: 9, fontWeight: 700, borderRadius: 2,
                transform: "translateY(-50%)", whiteSpace: "nowrap", pointerEvents: "none", zIndex: 4,
              }}
              title={polyStrike ? `Polymarket @ $${polyStrike.toLocaleString()} strike` : "Polymarket"}
            >
              POLY {polyCents}¢
            </div>
          )}

          {/* HIP-4 horizontal label removed — the green river IS the HIP-4 mark; no need for a separate horizontal line. */}
        </div>

        <div className="flex flex-wrap gap-4 mt-2 pt-2 text-[10px] items-center" style={{ borderTop: "1px solid var(--hl-border)", color: "var(--hl-muted)" }}>
          <span className="inline-flex items-center gap-1.5">
            <span style={{ width: 18, height: 3, background: "var(--hl-green)", display: "inline-block", borderRadius: 1 }}></span>
            <b style={{ color: "var(--hl-green)" }}>YES probability</b> <span style={{ color: "var(--hl-muted)" }}>· right axis 0¢-100¢</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span style={{ width: 18, height: 3, background: "var(--hl-yellow)", display: "inline-block", borderRadius: 1, opacity: 0.85 }}></span>
            <b style={{ color: "var(--hl-yellow)" }}>BTC price</b> <span style={{ color: "var(--hl-muted)" }}>· left axis $</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span style={{ fontSize: 12 }}>🐋</span>
            <b>trade flow</b> <span style={{ color: "var(--hl-muted)" }}>· green=buy YES · red=sell · 30s buckets</span>
          </span>
          {kalshiCents != null && kalshiStrike != null && (
            <span className="inline-flex items-center gap-1">
              Kalshi <b className="mono" style={{ color: "var(--hl-yellow)" }}>{kalshiCents}¢</b>
              <span style={{ color: "var(--hl-muted)" }}>@ ${kalshiStrike.toLocaleString()}</span>
            </span>
          )}
          {polyCents != null && polyStrike != null && (
            <span className="inline-flex items-center gap-1">
              Polymarket <b className="mono" style={{ color: "var(--hl-purple)" }}>{polyCents}¢</b>
              <span style={{ color: "var(--hl-muted)" }}>@ ${polyStrike.toLocaleString()}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function LiveOrderBook({ hyperodd, yesCents, now }: { hyperodd: HyperOddState; yesCents: number; now: number }) {
  const hasBook = hyperodd.bids.length > 0 || hyperodd.asks.length > 0;
  const markCents = hyperodd.mark != null ? Math.round(hyperodd.mark * 100) : null;
  const bestBid = hyperodd.bids[0] ? parseFloat(hyperodd.bids[0].px) : null;
  const bestAsk = hyperodd.asks[0] ? parseFloat(hyperodd.asks[0].px) : null;
  const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;

  const allLevels = [...hyperodd.bids.slice(0, 10), ...hyperodd.asks.slice(0, 10)];
  const maxSize = allLevels.reduce((m, l) => Math.max(m, parseFloat(l.sz)), 0.001);

  return (
    <div className="panel">
      <div className="px-3 py-2 flex items-center gap-3" style={{ borderBottom: "1px solid var(--hl-border)" }}>
        <span className="ptitle">Order book</span>
        <span className="psub">
          live · <span className="mono">{hyperodd.hip4Coin ?? "loading…"}</span> · HIP-4 mainnet · YES side
        </span>
        <div className="ml-auto flex gap-3 text-[10px]" style={{ color: "var(--hl-muted)" }}>
          {markCents != null && (
            <span>
              Mark <b className="mono" style={{ color: "var(--hl-green)" }}>{markCents}¢</b>
            </span>
          )}
          {hyperodd.openInterest > 0 && (
            <span>
              OI <b className="mono">{hyperodd.openInterest.toFixed(2)}</b>
            </span>
          )}
          {hyperodd.dayVol > 0 && (
            <span>
              24h vol <b className="mono">${hyperodd.dayVol.toFixed(0)}</b>
            </span>
          )}
        </div>
      </div>

      {!hasBook ? (
        <div className="grid" style={{ gridTemplateColumns: "1fr 80px 1fr" }}>
          <div
            className="flex items-center justify-center p-6 text-[11px] text-center"
            style={{ color: "var(--hl-muted)", borderRight: "1px solid var(--hl-border)", minHeight: 200 }}
          >
            <div>
              <div style={{ marginBottom: 6 }}>No bids resting</div>
              <div style={{ fontSize: 10 }}>
                Book momentarily empty.<br />Will repopulate on next quote.
              </div>
            </div>
          </div>
          <div
            className="flex flex-col items-center justify-center py-2 mono"
            style={{
              background: "var(--hl-surface-hover)",
              borderLeft: "1px solid var(--hl-border)",
              borderRight: "1px solid var(--hl-border)",
            }}
          >
            <span style={{ fontSize: 18, fontWeight: 700 }}>{markCents != null ? `${markCents}¢` : "—"}</span>
            <span className="cellL" style={{ marginTop: 2 }}>mark</span>
            {hyperodd.prevDayMark != null && (
              <span className="cellL" style={{ marginTop: 6 }}>prev {Math.round(hyperodd.prevDayMark * 100)}¢</span>
            )}
            <span className="cellL" style={{ marginTop: 4, color: "var(--hl-yellow)" }}>HL implied {yesCents}¢</span>
          </div>
          <div
            className="flex items-center justify-center p-6 text-[11px] text-center"
            style={{ color: "var(--hl-muted)", borderLeft: "1px solid var(--hl-border)" }}
          >
            <div>
              <div style={{ marginBottom: 6 }}>No asks resting</div>
              <div style={{ fontSize: 10 }}>
                Book momentarily empty.<br />Will repopulate on next quote.
              </div>
            </div>
          </div>
          {/* trades tape */}
          <div style={{ gridColumn: "1 / -1", borderTop: "1px solid var(--hl-border)" }}>
            <div className="px-3 py-1.5 cellL" style={{ borderBottom: "1px solid var(--hl-border)" }}>
              Recent trades · live testnet
            </div>
            {hyperodd.trades.length === 0 ? (
              <div className="px-3 py-3 text-[11px]" style={{ color: "var(--hl-muted)" }}>
                No trades yet. (Last 24h: 0)
              </div>
            ) : (
              <div>
                {hyperodd.trades.slice(0, 6).map((t, i) => {
                  const isBuy = t.side === "B" || t.side === "buy";
                  const px = parseFloat(t.px);
                  const sz = parseFloat(t.sz);
                  const ago = Math.max(0, Math.floor((now - t.time) / 1000));
                  const agoStr =
                    ago < 60 ? `${ago}s` : ago < 3600 ? `${Math.floor(ago / 60)}m` : `${Math.floor(ago / 3600)}h`;
                  return (
                    <div
                      key={t.time + "-" + i}
                      className="grid items-center px-3 py-1 mono text-[11px]"
                      style={{ gridTemplateColumns: "60px 60px 1fr 60px", borderBottom: "1px solid var(--hl-border)" }}
                    >
                      <span style={{ color: isBuy ? "var(--hl-green)" : "var(--hl-red)", fontWeight: 600 }}>
                        {isBuy ? "BUY" : "SELL"}
                      </span>
                      <span style={{ color: isBuy ? "var(--hl-green)" : "var(--hl-red)" }}>
                        {(px * 100).toFixed(1)}¢
                      </span>
                      <span style={{ color: "var(--hl-text)" }}>{sz.toFixed(2)}</span>
                      <span className="text-right" style={{ color: "var(--hl-muted)" }}>
                        {agoStr} ago
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: "1fr 80px 1fr" }}>
          <LiveObSide rows={hyperodd.bids.slice(0, 10).map((l) => ({ px: parseFloat(l.px), size: parseFloat(l.sz) }))} side="bid" maxSize={maxSize} />
          <div
            className="flex flex-col items-center justify-center py-2 mono"
            style={{
              background: "var(--hl-surface-hover)",
              borderLeft: "1px solid var(--hl-border)",
              borderRight: "1px solid var(--hl-border)",
            }}
          >
            <span style={{ fontSize: 18, fontWeight: 700 }}>{markCents != null ? `${markCents}¢` : "—"}</span>
            <span className="cellL" style={{ marginTop: 2 }}>mark</span>
            {spread != null && (
              <span style={{ fontSize: 11, color: "var(--hl-yellow)", marginTop: 4 }}>
                spread {(spread * 100).toFixed(2)}¢
              </span>
            )}
          </div>
          <LiveObSide rows={hyperodd.asks.slice(0, 10).map((l) => ({ px: parseFloat(l.px), size: parseFloat(l.sz) }))} side="ask" maxSize={maxSize} />
        </div>
      )}
    </div>
  );
}

function LiveObSide({
  rows,
  side,
  maxSize,
}: {
  rows: { px: number; size: number }[];
  side: "bid" | "ask";
  maxSize: number;
}) {
  return (
    <div className="flex flex-col">
      <div
        className="grid px-3 py-1 cellL gap-2"
        style={{ gridTemplateColumns: "1fr 1fr 1fr 1.6fr", borderBottom: "1px solid var(--hl-border)" }}
      >
        <span>{side === "bid" ? "Bid (¢)" : "Ask (¢)"}</span>
        <span className="text-right">Size</span>
        <span className="text-right">Total</span>
        <span>Depth</span>
      </div>
      {rows.map((r, i) => {
        const pct = (r.size / maxSize) * 100;
        const totalUsd = r.size * r.px;
        return (
          <div
            key={i}
            className="grid items-center px-3 py-0.5 mono relative gap-2"
            style={{ gridTemplateColumns: "1fr 1fr 1fr 1.6fr", fontSize: 11 }}
          >
            <span
              className="absolute top-0 right-0 h-full"
              style={{
                width: `${pct}%`,
                background: side === "bid" ? "var(--hl-green)" : "var(--hl-red)",
                opacity: 0.05,
                zIndex: 1,
              }}
            />
            <span className="relative z-10 font-semibold" style={{ color: side === "bid" ? "var(--hl-green)" : "var(--hl-red)" }}>
              {(r.px * 100).toFixed(1)}
            </span>
            <span className="relative z-10 text-right">{r.size.toFixed(2)}</span>
            <span className="relative z-10 text-right" style={{ color: "var(--hl-text)" }}>${totalUsd.toFixed(2)}</span>
            <div className="relative z-10" style={{ height: 6, background: "rgba(122,154,164,0.06)", borderRadius: 1, overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  width: `${pct}%`,
                  background: side === "bid" ? "var(--hl-green)" : "var(--hl-red)",
                  opacity: 0.5,
                  marginLeft: side === "bid" ? "auto" : 0,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Synthetic order book + ObSide removed — replaced by LiveOrderBook + LiveObSide which read real testnet data.

function TradePanel({
  yesCents,
  noCents,
  stake,
  setStake,
  side,
  setSide,
  orderType,
  setOrderType,
  limitPx,
  setLimitPx,
  liveYesBid,
  liveYesAsk,
  effectiveYesPx,
  shares,
  maxPayout,
  profit,
}: {
  yesCents: number;
  noCents: number;
  stake: string;
  setStake: (s: string) => void;
  side: "yes" | "no";
  setSide: (s: "yes" | "no") => void;
  orderType: "market" | "limit";
  setOrderType: (t: "market" | "limit") => void;
  limitPx: string;
  setLimitPx: (s: string) => void;
  liveYesBid: number;
  liveYesAsk: number;
  effectiveYesPx: number;
  shares: number;
  maxPayout: number;
  profit: number;
}) {
  const fillPriceCents = side === "yes" ? effectiveYesPx * 100 : (1 - effectiveYesPx) * 100;
  const bestForSide = side === "yes" ? liveYesAsk * 100 : (1 - liveYesBid) * 100;
  const slippageBps =
    orderType === "limit" && parseFloat(limitPx) > 0
      ? Math.abs(fillPriceCents - bestForSide) * 100 // bps approx
      : 0;

  return (
    <div className="panel">
      <div className="px-3 py-2 flex items-center" style={{ borderBottom: "1px solid var(--hl-border)" }}>
        <span className="ptitle">Order entry</span>
        <span className="psub ml-auto">
          best bid {(liveYesBid * 100).toFixed(1)}¢ · ask {(liveYesAsk * 100).toFixed(1)}¢
        </span>
      </div>
      <div className="p-3 flex flex-col gap-2">

        {/* YES / NO side */}
        <div className="grid grid-cols-2 gap-1 p-1" style={{ background: "var(--background)", border: "1px solid var(--hl-border)" }}>
          <button
            onClick={() => setSide("yes")}
            className="py-2 text-[11px] font-bold flex flex-col items-center"
            style={{
              background: side === "yes" ? "rgba(74,222,128,0.12)" : "transparent",
              color: side === "yes" ? "var(--hl-green)" : "var(--hl-muted)",
              borderRadius: 2,
            }}
          >
            BUY YES
            <span className="mono text-[14px]">{yesCents}¢</span>
          </button>
          <button
            onClick={() => setSide("no")}
            className="py-2 text-[11px] font-bold flex flex-col items-center"
            style={{
              background: side === "no" ? "rgba(248,113,113,0.12)" : "transparent",
              color: side === "no" ? "var(--hl-red)" : "var(--hl-muted)",
              borderRadius: 2,
            }}
          >
            BUY NO
            <span className="mono text-[14px]">{noCents}¢</span>
          </button>
        </div>

        {/* Market / Limit toggle */}
        <div className="grid grid-cols-2 gap-1 p-1" style={{ background: "var(--background)", border: "1px solid var(--hl-border)" }}>
          <button
            onClick={() => setOrderType("market")}
            className="py-1.5 text-[10px] font-semibold"
            style={{
              background: orderType === "market" ? "var(--hl-surface-hover)" : "transparent",
              color: orderType === "market" ? "var(--foreground)" : "var(--hl-muted)",
              borderRadius: 2,
            }}
          >
            MARKET
          </button>
          <button
            onClick={() => setOrderType("limit")}
            className="py-1.5 text-[10px] font-semibold"
            style={{
              background: orderType === "limit" ? "var(--hl-surface-hover)" : "transparent",
              color: orderType === "limit" ? "var(--foreground)" : "var(--hl-muted)",
              borderRadius: 2,
            }}
          >
            LIMIT
          </button>
        </div>

        {/* Limit price input — only when limit selected */}
        {orderType === "limit" && (
          <div className="flex items-center gap-2 px-2 py-1.5" style={{ background: "var(--background)", border: "1px solid var(--hl-border)" }}>
            <span className="cellL">Limit ¢</span>
            <input
              type="text"
              value={limitPx}
              placeholder={side === "yes" ? (liveYesAsk * 100).toFixed(1) : ((1 - liveYesBid) * 100).toFixed(1)}
              onChange={(e) => setLimitPx(e.target.value.replace(/[^\d.]/g, ""))}
              className="flex-1 min-w-0 bg-transparent border-none outline-none mono text-right text-[16px] font-semibold"
              style={{ color: "var(--foreground)" }}
            />
            <span className="mono text-[10px]" style={{ color: "var(--hl-muted)" }}>¢ per share</span>
          </div>
        )}

        {/* Size input */}
        <div className="flex items-center gap-2 px-2 py-1.5" style={{ background: "var(--background)", border: "1px solid var(--hl-border)" }}>
          <span className="cellL">Size</span>
          <input
            type="text"
            value={stake}
            onChange={(e) => setStake(e.target.value.replace(/[^\d.]/g, ""))}
            className="flex-1 min-w-0 bg-transparent border-none outline-none mono text-right text-[16px] font-semibold"
            style={{ color: "var(--foreground)" }}
          />
          <span className="mono text-[10px]" style={{ color: "var(--hl-muted)" }}>USDH</span>
        </div>

        <div className="grid grid-cols-4 gap-1">
          {["$25", "$100", "$250", "Max"].map((q) => (
            <button
              key={q}
              onClick={() => setStake(q === "Max" ? "1000" : q.replace("$", ""))}
              className="py-1 text-[10px]"
              style={{ background: "var(--background)", border: "1px solid var(--hl-border)", color: "var(--hl-text)" }}
            >
              {q}
            </button>
          ))}
        </div>

        {/* Summary */}
        <div className="px-2 py-2" style={{ background: "var(--background)", border: "1px solid var(--hl-border)" }}>
          <SumRow l={orderType === "market" ? "Avg fill" : "Limit price"} v={`${fillPriceCents.toFixed(1)}¢`} />
          <SumRow l="Shares" v={shares.toFixed(0)} />
          {orderType === "limit" && slippageBps > 0 && (
            <SumRow l="Distance from best" v={`${Math.abs(fillPriceCents - bestForSide).toFixed(2)}¢`} cls="text-[var(--hl-muted)]" />
          )}
          <SumRow l="Profit if win" v={`+$${profit.toFixed(2)}`} cls="text-[var(--hl-green)]" />
          <SumRow l="Max payout" v={`$${maxPayout.toFixed(2)}`} total />
        </div>

        <button
          className="py-2.5 text-[13px] font-bold tracking-wide"
          style={{ background: side === "yes" ? "var(--hl-green)" : "var(--hl-red)", color: "#001d0c", border: "none" }}
          onClick={() => alert("Execution wiring lands in the next iteration. Order shape is final.")}
        >
          {orderType === "market"
            ? `${side === "yes" ? "Buy YES" : "Buy NO"} @ market`
            : `${side === "yes" ? "Buy YES" : "Buy NO"} @ ${parseFloat(limitPx || "0").toFixed(1)}¢`
          }
        </button>
        <div className="text-[9px] text-center tracking-wide" style={{ color: "var(--hl-muted)" }}>
          Execution disabled in prototype · settles 06:00 UTC tomorrow
        </div>
      </div>
    </div>
  );
}

function CompareStrip({
  yesCents,
  compare,
  strike,
  hyperodd,
  now,
}: {
  yesCents: number;
  compare: CompareData | null;
  strike: number | null;
  hyperodd: HyperOddState;
  now: number;
}) {
  // Freshness — how long ago was the cross-venue compare data fetched?
  const ageMs = compare ? Math.max(0, now - compare.fetchedAt) : null;
  const ageStr = ageMs == null
    ? "—"
    : ageMs < 1000
      ? "<1s"
      : ageMs < 60_000
        ? `${Math.floor(ageMs / 1000)}s`
        : `${Math.floor(ageMs / 60_000)}m`;
  const k = compare?.kalshi;
  const kalshiCents = k?.available && k.last != null ? Math.round(k.last * 100) : null;
  const kalshiBid = k?.yesBid != null ? Math.round(k.yesBid * 100) : null;
  const kalshiAsk = k?.yesAsk != null ? Math.round(k.yesAsk * 100) : null;

  const p = compare?.polymarket;
  const polyCents = p?.available && p.yesPrice != null ? Math.round(p.yesPrice * 100) : null;

  const hyperoddCents = hyperodd.mark != null ? Math.round(hyperodd.mark * 100) : null;

  // max divergence across all venues
  const gaps: number[] = [];
  if (kalshiCents != null) gaps.push(yesCents - kalshiCents);
  if (polyCents != null) gaps.push(yesCents - polyCents);
  if (hyperoddCents != null) gaps.push(yesCents - hyperoddCents);
  const maxAbs = gaps.reduce((m, g) => (Math.abs(g) > Math.abs(m) ? g : m), 0);
  const isEdge = Math.abs(maxAbs) >= 3 && gaps.length > 0;

  return (
    <div
      className="mt-2 px-3 py-2 grid gap-3 text-[11px]"
      style={{
        background: "rgba(0,240,255,0.04)",
        border: "1px solid rgba(0,240,255,0.18)",
        borderRadius: 4,
        gridTemplateColumns: "auto 1fr 1fr 1fr 1fr auto",
        alignItems: "center",
      }}
    >
      <span className="cellL flex items-center gap-1.5" style={{ color: "var(--hl-accent)", fontWeight: 600, letterSpacing: 0.6 }}>
        Cross-venue
        <span
          className="mono"
          style={{
            fontSize: 9,
            color: ageMs != null && ageMs < 15_000 ? "var(--hl-green)" : "var(--hl-muted)",
            fontWeight: 400,
            letterSpacing: 0,
            textTransform: "none",
          }}
        >
          {compare ? `· ${ageStr} ago` : "· loading…"}
        </span>
      </span>

      {/* HLOne implied */}
      <div className="flex items-baseline gap-2 px-2 border-l" style={{ borderColor: "var(--hl-border)" }}>
        <span style={{ color: "var(--hl-muted)", fontSize: 10 }}>HLOne implied</span>
        <span className="mono font-bold" style={{ color: "var(--hl-green)", fontSize: 14 }}>{yesCents}¢</span>
        {strike && <span style={{ color: "var(--hl-muted)", fontSize: 10 }}>@ ${strike.toLocaleString()}</span>}
      </div>

      {/* HIP-4 LIVE — the real on-chain market */}
      <div className="flex items-baseline gap-2 px-2 border-l" style={{ borderColor: "var(--hl-border)" }}>
        <span style={{ color: "var(--hl-muted)", fontSize: 10 }}>HIP-4 live</span>
        {hyperoddCents != null ? (
          <>
            <span className="mono font-bold" style={{ color: "var(--hl-accent)", fontSize: 14 }}>{hyperoddCents}¢</span>
            <span style={{ color: "var(--hl-muted)", fontSize: 10 }} title={hyperodd.hip4Coin ?? "loading…"}>
              {hyperodd.hip4Coin ?? "loading…"}
            </span>
          </>
        ) : (
          <span style={{ color: "var(--hl-muted)", fontSize: 11 }}>loading…</span>
        )}
      </div>

      {/* Kalshi */}
      <div className="flex items-baseline gap-2 px-2 border-l" style={{ borderColor: "var(--hl-border)" }}>
        <span style={{ color: "var(--hl-muted)", fontSize: 10 }}>Kalshi</span>
        {kalshiCents != null ? (
          <>
            <span className="mono font-bold" style={{ color: "var(--hl-yellow)", fontSize: 14 }}>{kalshiCents}¢</span>
            {kalshiBid != null && kalshiAsk != null && (
              <span className="mono" style={{ color: "var(--hl-muted)", fontSize: 10 }}>{kalshiBid}/{kalshiAsk}</span>
            )}
            {k?.matchedStrike && (
              <span style={{ color: "var(--hl-muted)", fontSize: 10 }}>@ ${k.matchedStrike.toLocaleString()}</span>
            )}
          </>
        ) : (
          <span style={{ color: "var(--hl-muted)", fontSize: 11 }}>{k?.error ? "unavailable" : "loading…"}</span>
        )}
      </div>

      {/* Polymarket */}
      <div className="flex items-baseline gap-2 px-2 border-l" style={{ borderColor: "var(--hl-border)" }}>
        <span style={{ color: "var(--hl-muted)", fontSize: 10 }}>Polymarket</span>
        {polyCents != null ? (
          <>
            <span className="mono font-bold" style={{ color: "var(--hl-purple)", fontSize: 14 }}>{polyCents}¢</span>
            {p?.matchedStrike && (
              <span style={{ color: "var(--hl-muted)", fontSize: 10 }}>@ ${p.matchedStrike.toLocaleString()}</span>
            )}
            {p?.eventVolume24h && p.eventVolume24h > 0 && (
              <span style={{ color: "var(--hl-muted)", fontSize: 10 }}>vol ${(p.eventVolume24h / 1000).toFixed(0)}K</span>
            )}
            {p?.eventSlug && (
              <a
                href={`https://polymarket.com/event/${p.eventSlug}`}
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--hl-muted)", fontSize: 10, textDecoration: "underline" }}
              >
                ↗
              </a>
            )}
          </>
        ) : (
          <span style={{ color: "var(--hl-muted)", fontSize: 10 }}>{p?.error ? "unavailable" : "loading…"}</span>
        )}
      </div>

      {/* Divergence flag — max gap across venues */}
      <div className="flex items-center gap-2 px-2">
        {gaps.length > 0 ? (
          <>
            <span style={{ color: "var(--hl-muted)", fontSize: 10 }}>max Δ</span>
            <span
              className="mono font-bold"
              style={{
                color: isEdge
                  ? maxAbs > 0
                    ? "var(--hl-green)"
                    : "var(--hl-red)"
                  : "var(--hl-muted)",
                fontSize: 14,
              }}
            >
              {maxAbs >= 0 ? "+" : ""}
              {maxAbs}¢
            </span>
            {isEdge && (
              <span
                className="mono"
                style={{
                  fontSize: 9,
                  padding: "1px 6px",
                  borderRadius: 2,
                  background: "rgba(245,165,36,0.15)",
                  color: "var(--hl-yellow)",
                  fontWeight: 700,
                  letterSpacing: 0.5,
                }}
                title="Mispricing > 3¢ vs at least one venue"
              >
                EDGE
              </span>
            )}
          </>
        ) : (
          <span style={{ color: "var(--hl-muted)", fontSize: 10 }}>—</span>
        )}
      </div>
    </div>
  );
}

function SumRow({ l, v, cls = "", total = false }: { l: string; v: string; cls?: string; total?: boolean }) {
  return (
    <div
      className="flex justify-between"
      style={{
        padding: "2px 0",
        fontSize: total ? 11 : 10,
        marginTop: total ? 4 : 0,
        paddingTop: total ? 6 : 2,
        borderTop: total ? "1px solid var(--hl-border)" : undefined,
      }}
    >
      <span style={{ color: total ? "var(--foreground)" : "var(--hl-muted)", fontWeight: total ? 600 : 400 }}>{l}</span>
      <span className={`mono font-semibold ${cls}`} style={{ color: total && !cls ? "var(--hl-green)" : undefined, fontSize: total ? 12 : 10 }}>{v}</span>
    </div>
  );
}
