"use client";

/**
 * Predictions — single-market view for the live HIP-4 BTC daily binary.
 *
 * Wired to:
 *  - allMids / candleSnapshot / l2Book / recentTrades on HL mainnet
 *  - WS trades stream for live whale flow (server collector + client subscribe)
 *  - Kalshi BTC daily + Polymarket strike-ladder via /api/predict/compare
 *  - placeOrder() in hl-exchange.ts for actual trade execution (1.5 bps builder fee)
 */

import { useEffect, useMemo, useState } from "react";
import { useSafeAccount } from "@/hooks/use-safe-account";

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

/**
 * Translate a UI timeframe selection into HL candle params + chart-window
 * bounds. Lookback is how far back from now the chart shows; interval is
 * the candle granularity (smaller windows want finer candles).
 */
function tfParams(tf: "1H" | "6H" | "24H") {
  switch (tf) {
    case "1H": return { lookbackMs: 1 * 60 * 60 * 1000, interval: "1m" };
    case "6H": return { lookbackMs: 6 * 60 * 60 * 1000, interval: "5m" };
    case "24H":
    default:   return { lookbackMs: 24 * 60 * 60 * 1000, interval: "15m" };
  }
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
    interpolatedYes?: number;
    bracketLowerStrike?: number;
    bracketLowerYes?: number;
    bracketUpperStrike?: number;
    bracketUpperYes?: number;
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
    interpolatedYes?: number;
    bracketLowerStrike?: number;
    bracketLowerYes?: number;
    bracketUpperStrike?: number;
    bracketUpperYes?: number;
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
  // Public route — was gated behind ?preview=1 during prototype, gate dropped
  // for production. Trade execution remains disabled (button shows an alert)
  // until the EIP-712 + builder-fee wiring lands in the next iteration.

  const [btcMark, setBtcMark] = useState<number | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [now, setNow] = useState(0);
  const [stake, setStake] = useState("250");
  const [side, setSide] = useState<"yes" | "no">("yes");
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [limitPx, setLimitPx] = useState<string>("");
  const [showRules, setShowRules] = useState(false);
  const [timeframe, setTimeframe] = useState<"1H" | "6H" | "24H">("24H");
  const [orderStatus, setOrderStatus] = useState<{ kind: "idle" | "pending" | "success" | "error"; message?: string }>({ kind: "idle" });
  const { address, isConnected } = useSafeAccount();
  const [selectedWhale, setSelectedWhale] = useState<{
    side: string;
    sideContext: "yes" | "no"; // which contract these trades happened on
    px: number;
    usd: number;
    count: number;
    time: number;
  } | null>(null);

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

  // BTC candles — granularity + lookback driven by the chart timeframe.
  useEffect(() => {
    let cancelled = false;
    const { lookbackMs, interval } = tfParams(timeframe);
    const fetchCandles = async () => {
      try {
        const end = Date.now();
        const start = end - lookbackMs;
        const res = await fetch(HL_INFO, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "candleSnapshot",
            req: { coin: "BTC", interval, startTime: start, endTime: end },
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
  }, [timeframe]);

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

    const { lookbackMs, interval: tfInterval } = tfParams(timeframe);
    const fetchCandles = async () => {
      try {
        const end = Date.now();
        const start = end - lookbackMs;
        const res = await fetch(HL_INFO, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "candleSnapshot",
            req: { coin: hip4Coin, interval: tfInterval, startTime: start, endTime: end },
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

    // Also pull server-collected trade history. The Railway API has been
    // subscribed to HL's trades WS since boot, so this gives us the FULL
    // history for the current contract (not just the last ~30s).
    const fetchServerTrades = async () => {
      try {
        const res = await fetch(`/api/market/predict-trades?limit=500`);
        if (!res.ok) return;
        const data = (await res.json()) as {
          coin: string | null;
          trades: { coin: string; px: number; sz: number; side: string; time: number; tid: number; hash?: string }[];
        };
        if (cancelled || data.coin !== hip4Coin || !Array.isArray(data.trades)) return;
        setHyperodd((s) => {
          const tids = new Set(s.trades.map((t) => t.tid).filter((x): x is number => x != null));
          const incoming = data.trades
            .filter((t) => t.tid == null || !tids.has(t.tid))
            .map((t) => ({
              coin: t.coin,
              px: String(t.px),
              sz: String(t.sz),
              side: t.side,
              time: t.time,
              tid: t.tid,
            } as HyperOddTrade));
          if (!incoming.length) return s;
          // Merge + sort newest first + cap
          const merged = [...incoming, ...s.trades]
            .sort((a, b) => b.time - a.time)
            .slice(0, 500);
          return { ...s, trades: merged };
        });
      } catch { /* ignore */ }
    };

    fetchMark();
    fetchTrades();
    fetchServerTrades();
    fetchCandles();
    fetchBookOnce();
    const markId = setInterval(fetchMark, 3000);
    const tradeId = setInterval(fetchTrades, 5000);
    const serverTradeId = setInterval(fetchServerTrades, 10_000);
    const candleId = setInterval(fetchCandles, 60_000);

    // WS for live L2 book + trade stream — both subscribed on the same socket.
    // The trades channel is what gives us real trade-flow-over-time for the
    // chart whales (otherwise recentTrades only returns the last ~30s).
    const connectWs = () => {
      if (cancelled) return;
      try {
        ws = new WebSocket(HL_WS);
        // Compute the NO-side coin from the YES coin: "#400" → "#401"
        // The last digit is the side index (0=YES, 1=NO); flip it.
        const yesNum = hip4Coin.slice(1, -1); // outcome ID part
        const hip4CoinNo = `#${yesNum}1`;

        ws.onopen = () => {
          // Book stays on the YES coin (that's what the order book panel shows)
          ws?.send(JSON.stringify({ method: "subscribe", subscription: { type: "l2Book", coin: hip4Coin } }));
          // Subscribe to BOTH YES and NO trade streams so the chart can flip
          // between them based on the user's trade-side selection.
          ws?.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin: hip4Coin } }));
          ws?.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin: hip4CoinNo } }));
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
              // Accept trades from either #N0 (YES) or #N1 (NO) — coin tag
              // is preserved on each trade so the chart can filter by side.
              const incoming = (msg.data as HyperOddTrade[]).filter(
                (t) => t && (t.coin === hip4Coin || t.coin === hip4CoinNo),
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
      clearInterval(serverTradeId);
      clearInterval(candleId);
      if (ws) ws.close();
    };
  }, [hip4Coin, timeframe]);

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

  // σ√t fair value — theoretical YES probability given BTC mark + vol model.
  // Used for the "implied prob" widget and the faded fair-value chart line.
  const yesProb = useMemo(() => {
    if (btcMark == null || strike == null) return 0.5;
    return impliedYesProb(btcMark, strike, hoursToSettle);
  }, [btcMark, strike, hoursToSettle]);
  const fairCents = Math.round(yesProb * 100);

  // The ACTUAL YES price — what the live HIP-4 market is trading at right now.
  // This is what everyday user-facing "YES" displays should use (chart endpoint
  // chip, order entry side toggle, market-strip YES/NO stats). Falls back to
  // fair value until the live mark loads.
  const yesCents =
    hyperodd.mark != null ? Math.round(hyperodd.mark * 100) : fairCents;
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

  const distance = btcMark && strike ? strike - btcMark : 0;
  const distancePct = btcMark && strike ? (distance / btcMark) * 100 : 0;

  // Expiry tier — used to show a warning banner as settle nears. Pin risk
  // and σ√t collapse make the displayed implied prob unreliable in the last
  // hour, especially the last 15 minutes.
  const minsToSettle = settleTs > 0 && now > 0 ? (settleTs - now) / 60_000 : Infinity;
  const expiryTier: "none" | "soon" | "imminent" =
    minsToSettle <= 0 ? "none" : minsToSettle <= 15 ? "imminent" : minsToSettle <= 60 ? "soon" : "none";
  // How close BTC is to strike, as % of strike (proxy for pin risk severity)
  const strikeProximityPct = btcMark && strike ? Math.abs(distancePct) : Infinity;
  const isPinRisk = expiryTier !== "none" && strikeProximityPct < 0.3;

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
        @keyframes expiry-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.55; }
        }
        .expiry-pulse { animation: expiry-pulse 1.2s ease-in-out infinite; }
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
          HIP-4 outcome market{" "}
          <code className="mono" style={{ color: "var(--hl-accent)" }}>{hyperodd.hip4Coin ?? "loading…"}</code>
        </span>
        <span
          className="ml-auto mono text-[10px]"
          style={{ color: hyperodd.wsConnected ? "var(--hl-green)" : "var(--hl-muted)" }}
        >
          {hyperodd.wsConnected ? "● ws live" : "○ ws connecting…"}
        </span>
      </div>

      {/* Expiry warning — only shown when contract is within 60 min of settle */}
      {expiryTier !== "none" && (
        <div
          className={`max-w-[1440px] mx-auto px-4 py-2 flex items-center gap-3 text-[11px] ${expiryTier === "imminent" ? "expiry-pulse" : ""}`}
          style={{
            background: expiryTier === "imminent" ? "rgba(248,113,113,0.12)" : "rgba(245,165,36,0.1)",
            borderBottom: `1px solid ${expiryTier === "imminent" ? "rgba(248,113,113,0.4)" : "rgba(245,165,36,0.3)"}`,
          }}
        >
          <span
            className="mono font-bold"
            style={{
              color: expiryTier === "imminent" ? "var(--hl-red)" : "var(--hl-yellow)",
              letterSpacing: 0.6,
              fontSize: 10,
            }}
          >
            {expiryTier === "imminent" ? "⚠ EXPIRING NOW" : "⏱ EXPIRING SOON"}
          </span>
          <span style={{ color: "var(--hl-text)" }}>
            Settles in <b className="mono">{fmtCountdown(settleTs - now)}</b>.
            {expiryTier === "imminent"
              ? " Expect pin risk and rapid YES/NO whipsaws as BTC oscillates around the strike. σ-implied prob is no longer meaningful — trust the live order book and recent trades only."
              : " The σ-implied probability becomes unreliable as time decays — use the live HIP-4 mark, not the fair-value reference, for decision-making."}
            {isPinRisk && (
              <span style={{ color: "var(--hl-red)", fontWeight: 600, marginLeft: 8 }}>
                BTC is within {strikeProximityPct.toFixed(2)}% of strike — pin risk active.
              </span>
            )}
          </span>
          <span
            className="ml-auto mono"
            style={{
              color: expiryTier === "imminent" ? "var(--hl-red)" : "var(--hl-yellow)",
              fontSize: 14,
              fontWeight: 700,
            }}
          >
            {fmtCountdown(settleTs - now)}
          </span>
        </div>
      )}

      {/* market strip */}
      <div className="max-w-[1440px] mx-auto px-4 py-3 border-b" style={{ borderColor: "var(--hl-border)" }}>
        <div className="flex items-center gap-4 mb-3 flex-wrap">
          <h1 className="text-[28px] font-bold tracking-tight leading-tight">
            Will BTC close above ${strike?.toLocaleString() ?? "…"} today?
          </h1>
          <div className="ml-auto flex gap-2">
            <button
              onClick={() => setShowRules(true)}
              className="text-[11px] px-3 py-1 rounded"
              style={{ background: "var(--hl-surface)", border: "1px solid var(--hl-border)", color: "var(--hl-text)" }}
            >
              Resolution rules
            </button>
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
          <span
            className="ml-auto"
            style={{
              color: "var(--hl-muted)",
              opacity: expiryTier === "imminent" ? 0.4 : 1,
              textDecoration: expiryTier === "imminent" ? "line-through" : "none",
            }}
            title={
              expiryTier === "imminent"
                ? "Unreliable — σ√t collapses to ~0 near expiry. Trust the live HIP-4 mark instead."
                : undefined
            }
          >
            Implied prob: <b className="mono" style={{ color: "var(--hl-green)" }}>{(yesProb * 100).toFixed(1)}%</b> · σ·√t at 65% annual vol (theory; market is {yesCents}%)
          </span>
        </div>

        {/* Compare strip — HLOne implied vs HL testnet (HyperOdd) vs Kalshi vs Polymarket */}
        <CompareStrip fairCents={fairCents} compare={compare} strike={strike} hyperodd={hyperodd} now={now} />
      </div>

      {/* main grid */}
      <main className="max-w-[1440px] mx-auto px-4 py-3 grid gap-3" style={{ gridTemplateColumns: "1fr 320px", alignItems: "start" }}>
        <div className="flex flex-col gap-3 min-w-0">
          <RiverChart
            timeframe={timeframe}
            setTimeframe={setTimeframe}
            probSeries={probSeries}
            fairProbSeries={marketProbSeries.length > 0 && expiryTier !== "imminent" ? fairProbSeries : []}
            btcCandles={candles}
            marketCandles={hyperodd.marketCandles}
            btcMark={btcMark}
            strike={strike}
            settleTs={settleTs}
            now={now}
            yesCents={yesCents}
            kalshiCents={
              compare?.kalshi.available
                ? compare.kalshi.interpolatedYes != null
                  ? Math.round(compare.kalshi.interpolatedYes * 100)
                  : compare.kalshi.last != null
                    ? Math.round(compare.kalshi.last * 100)
                    : null
                : null
            }
            polyCents={
              compare?.polymarket.available
                ? compare.polymarket.interpolatedYes != null
                  ? Math.round(compare.polymarket.interpolatedYes * 100)
                  : compare.polymarket.yesPrice != null
                    ? Math.round(compare.polymarket.yesPrice * 100)
                    : null
                : null
            }
            trades={hyperodd.trades}
            hip4Coin={hyperodd.hip4Coin}
            tradeSide={side}
            onWhaleClick={setSelectedWhale}
            limitOrderCents={
              orderType === "limit" && parseFloat(limitPx) > 0
                ? side === "yes"
                  ? parseFloat(limitPx)
                  : 100 - parseFloat(limitPx)
                : null
            }
            limitOrderSide={orderType === "limit" && parseFloat(limitPx) > 0 ? side : null}
            limitOrderTypedCents={orderType === "limit" && parseFloat(limitPx) > 0 ? parseFloat(limitPx) : null}
          />
          <LiveOrderBook hyperodd={hyperodd} fairCents={fairCents} now={now} />
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
            orderStatus={orderStatus}
            onSubmit={async () => {
              if (!isConnected || !address) {
                setOrderStatus({ kind: "error", message: "Connect wallet first" });
                return;
              }
              if (!hyperodd.hip4Outcome) {
                setOrderStatus({ kind: "error", message: "Market not loaded yet" });
                return;
              }
              // YES side → outcome side 0 ("#<outcome>0"); NO → side 1.
              const sideIdx = side === "yes" ? 0 : 1;
              const asset = `#${hyperodd.hip4Outcome}${sideIdx}`;
              // HL outcome shares are priced 0..1; user types cents.
              const lpx = parseFloat(limitPx);
              const limitPrice =
                orderType === "limit" && Number.isFinite(lpx) && lpx > 0
                  ? lpx / 100
                  : undefined;

              setOrderStatus({ kind: "pending" });
              try {
                const [wagmiCore, exchange, wagmiConfig] = await Promise.all([
                  import("@wagmi/core"),
                  import("@/lib/hl-exchange"),
                  import("@/config/wagmi"),
                ]);
                const walletClient = await wagmiCore.getWalletClient(wagmiConfig.config);
                if (!walletClient) throw new Error("Wallet client not available");

                // Ensure agent wallet (one-time MetaMask popup if not approved)
                const agentResult = await exchange.ensureAgent(walletClient, address as `0x${string}`);
                if (agentResult.error || !agentResult.agentKey) {
                  throw new Error(agentResult.error || "Agent setup failed");
                }

                // Ensure builder fee approval (one-time popup)
                const builderApproved = await exchange.checkBuilderApproval(address as string);
                if (!builderApproved) {
                  const approval = await exchange.approveBuilderFee(walletClient, address as `0x${string}`);
                  if (!approval.success) throw new Error(approval.error || "Builder fee approval failed");
                }

                const res = await exchange.placeOrder(
                  agentResult.agentKey,
                  address as `0x${string}`,
                  {
                    asset,
                    isBuy: true, // always buying YES or NO shares (HL outcome model)
                    size: Math.max(1, Math.floor(shares)),
                    orderType,
                    limitPrice,
                    slippageBps: orderType === "market" ? 200 : undefined,
                  },
                );
                if (res.success) {
                  setOrderStatus({
                    kind: "success",
                    message: `Filled ${res.filledSize ?? "?"} @ ${res.avgPrice ?? "?"}¢`,
                  });
                } else {
                  setOrderStatus({ kind: "error", message: res.error ?? "Order failed" });
                }
              } catch (err) {
                setOrderStatus({
                  kind: "error",
                  message: err instanceof Error ? err.message : "Order threw",
                });
              }
            }}
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
              <b style={{ color: "var(--foreground)" }}>Trading:</b> live via your connected wallet · 1.5 bps builder fee · settles to USDH at expiry.
            </div>
          </div>
        </div>
      </main>

      {/* Resolution rules modal */}
      {showRules && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
          onClick={() => setShowRules(false)}
        >
          <div
            className="max-w-[600px] w-full p-6 text-[13px] leading-relaxed"
            style={{ background: "var(--hl-surface)", border: "1px solid var(--hl-border)", color: "var(--foreground)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-baseline mb-4">
              <h2 className="text-[18px] font-bold tracking-tight">Resolution rules</h2>
              <button
                onClick={() => setShowRules(false)}
                className="ml-auto text-[20px] leading-none"
                style={{ color: "var(--hl-muted)" }}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3" style={{ color: "var(--hl-text)" }}>
              <p>
                <b style={{ color: "var(--foreground)" }}>Question:</b> Will BTC close above ${strike?.toLocaleString() ?? "—"} at{" "}
                {hyperodd.hip4ExpiryMs ? new Date(hyperodd.hip4ExpiryMs).toUTCString() : "06:00 UTC"}?
              </p>
              <p>
                <b style={{ color: "var(--foreground)" }}>Settlement source:</b> BTC mark price on HyperCore (Hyperliquid&apos;s on-chain
                spot index). YES pays out $1 if the mark at expiry is strictly greater than the strike; otherwise NO pays out $1.
              </p>
              <p>
                <b style={{ color: "var(--foreground)" }}>Contract:</b>{" "}
                <code className="mono" style={{ color: "var(--hl-accent)" }}>{hyperodd.hip4Coin ?? "—"}</code> (HIP-4 outcome share,
                outcome ID {hyperodd.hip4Outcome ?? "—"}). YES shares trade on the order book; price is in cents of $1 payout.
              </p>
              <p>
                <b style={{ color: "var(--foreground)" }}>Collateral:</b> USDH. Fully collateralised — no liquidations, no funding.
                Maximum loss is your stake.
              </p>
              <p>
                <b style={{ color: "var(--foreground)" }}>Rollover:</b> A new daily binary opens automatically at settle. The new
                contract&apos;s strike is set by HL based on the prevailing BTC mark; this prototype detects the rollover via{" "}
                <code className="mono">outcomeMeta</code> and resubscribes within ~60s.
              </p>
              <p style={{ fontSize: 11, color: "var(--hl-muted)", paddingTop: 8, borderTop: "1px solid var(--hl-border)", marginTop: 12 }}>
                See the{" "}
                <a
                  href="https://hyperliquid.gitbook.io/hyperliquid-docs"
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "var(--hl-accent)", textDecoration: "underline" }}
                >
                  HL docs ↗
                </a>{" "}
                for the full HIP-4 spec.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Whale-details modal — click any 🐋 icon on the chart */}
      {selectedWhale && (() => {
        const w = selectedWhale;
        const isBuy = w.side === "B" || w.side === "buy";
        const usdStr = w.usd >= 1000 ? `$${(w.usd / 1000).toFixed(2)}K` : `$${w.usd.toFixed(2)}`;
        const shares = (w.usd / w.px).toFixed(0);
        const dt = new Date(w.time);
        const timeStr = dt.toUTCString();
        const minutesAgo = Math.max(0, Math.floor((now - w.time) / 60_000));
        const agoStr = minutesAgo < 60 ? `${minutesAgo}m ago` : `${(minutesAgo / 60).toFixed(1)}h ago`;
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
            onClick={() => setSelectedWhale(null)}
          >
            <div
              className="max-w-[440px] w-full p-5 text-[13px]"
              style={{ background: "var(--hl-surface)", border: `1px solid ${isBuy ? "var(--hl-green)" : "var(--hl-red)"}`, color: "var(--foreground)" }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-baseline gap-2 mb-4">
                <span style={{ fontSize: 22 }}>🐋</span>
                <h2 className="text-[16px] font-bold tracking-tight">
                  <span style={{ color: isBuy ? "var(--hl-green)" : "var(--hl-red)" }}>
                    {isBuy ? `BUY ${w.sideContext.toUpperCase()}` : `SELL ${w.sideContext.toUpperCase()}`}
                  </span>
                </h2>
                <button
                  onClick={() => setSelectedWhale(null)}
                  className="ml-auto text-[20px] leading-none"
                  style={{ color: "var(--hl-muted)" }}
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>

              <div className="space-y-2.5">
                <Row label="Total notional" value={usdStr} cls={isBuy ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"} big />
                <Row label="Average price" value={`${(w.px * 100).toFixed(1)}¢ / share`} />
                <Row label="Shares traded" value={`${shares} (~$1 max each)`} />
                <Row label="Trade count in bucket" value={`${w.count} fill${w.count > 1 ? "s" : ""}`} />
                <Row label="Time" value={`${agoStr}`} sub={timeStr.slice(0, 22)} />
                <Row
                  label="Settles"
                  value={hyperodd.hip4ExpiryMs ? new Date(hyperodd.hip4ExpiryMs).toUTCString().slice(0, 22) : "—"}
                />
                <Row
                  label="Contract"
                  value={hyperodd.hip4Coin ?? "—"}
                  sub={strike ? `BTC > $${strike.toLocaleString()}` : undefined}
                />
              </div>

              <p style={{ fontSize: 11, color: "var(--hl-muted)", paddingTop: 10, borderTop: "1px solid var(--hl-border)", marginTop: 14, lineHeight: 1.5 }}>
                This is an aggregate of all trades on the same side within a 60-second bucket. Individual fill detail (wallet addresses, tx hashes) coming next &mdash; they&apos;re being collected on the API right now.
              </p>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function Row({ label, value, sub, cls = "", big = false }: { label: string; value: string; sub?: string; cls?: string; big?: boolean }) {
  return (
    <div className="flex justify-between items-baseline" style={{ borderBottom: "1px dashed var(--hl-border)", paddingBottom: 6 }}>
      <span style={{ color: "var(--hl-muted)" }}>{label}</span>
      <span className="text-right">
        <span className={`mono ${big ? "text-[16px] font-bold" : "font-semibold"} ${cls}`}>{value}</span>
        {sub && <span style={{ display: "block", fontSize: 10, color: "var(--hl-muted)" }}>{sub}</span>}
      </span>
    </div>
  );
}

// ─── small components ──────────────────────────────────────────────────────
/**
 * Inline gap chip — shows e.g. "−11% vs HIP-4" in muted (small) or coloured
 * (significant) styling. Used in the cross-venue strip to make each
 * comparator's distance from the actual market obvious without jargon.
 */
function GapChip({ gap, suffix, title }: { gap: number | null; suffix: string; title?: string }) {
  if (gap == null) return null;
  const abs = Math.abs(gap);
  const isSignificant = abs >= 3;
  const color = !isSignificant
    ? "var(--hl-muted)"
    : gap < 0
      ? "var(--hl-green)"  // venue cheaper than HIP-4 → buy YES there
      : "var(--hl-red)";   // venue richer than HIP-4 → buy YES at HIP-4
  return (
    <span
      className="mono"
      style={{
        color,
        fontSize: 10,
        fontWeight: isSignificant ? 700 : 500,
        opacity: abs < 1 ? 0.5 : 1,
      }}
      title={title ?? `Distance from the live HIP-4 mark, in percentage points. ${gap < 0 ? "Negative = this " + suffix + " venue is cheaper than HIP-4." : "Positive = this " + suffix + " venue is richer than HIP-4."}`}
    >
      {gap >= 0 ? "+" : ""}
      {gap}% vs HIP-4
    </span>
  );
}

function Stat({ label, value, cls }: { label: string; value: string; cls: string }) {
  return (
    <div className="px-3 border-r last:border-r-0 first:pl-0" style={{ borderColor: "var(--hl-border)" }}>
      <div className="cellL">{label}</div>
      <div className={`mono text-[14px] font-semibold ${cls}`}>{value}</div>
    </div>
  );
}

function RiverChart({
  timeframe,
  setTimeframe,
  probSeries,
  fairProbSeries,
  btcCandles,
  marketCandles,
  btcMark,
  strike,
  settleTs,
  now,
  yesCents,
  kalshiCents,
  polyCents,
  trades,
  hip4Coin,
  tradeSide,
  onWhaleClick,
  limitOrderCents,
  limitOrderSide,
  limitOrderTypedCents,
}: {
  timeframe: "1H" | "6H" | "24H";
  setTimeframe: (tf: "1H" | "6H" | "24H") => void;
  probSeries: { x: number; p: number }[];
  fairProbSeries: { x: number; p: number }[];
  btcCandles: Candle[];
  marketCandles: Candle[];
  btcMark: number | null;
  strike: number | null;
  settleTs: number;
  now: number;
  yesCents: number;
  kalshiCents: number | null;
  polyCents: number | null;
  trades: HyperOddTrade[];
  hip4Coin: string | null;  // e.g. "#400" — used to derive the NO coin "#401"
  tradeSide: "yes" | "no";  // filters whales to the side the user is trading
  onWhaleClick: (w: { side: string; sideContext: "yes" | "no"; px: number; usd: number; count: number; time: number }) => void;
  limitOrderCents: number | null;       // in YES-space (for line position)
  limitOrderSide: "yes" | "no" | null;
  limitOrderTypedCents: number | null;  // raw user input (for chip text)
}) {
  const W = 800;
  const H = 420; // bumped from 360 to give whales more vertical room

  // X-axis spans the contract's actual lifetime: 24h ending at settleTs.
  // This way the chart reads as "open → settle" and an in-progress market
  // shows a clear NOW marker, not a half-empty canvas.
  // Chart x-window driven by the active timeframe.
  //  - 24H: full contract lifetime (settleTs−24h → settleTs). Familiar
  //    "open → settle" framing with NOW marker.
  //  - 1H / 6H: zoom to the last N hours ending at NOW. Better for active
  //    in-session reads.
  const tMin =
    timeframe === "24H"
      ? settleTs - 24 * 60 * 60 * 1000
      : (now > 0 ? now : Date.now()) - tfParams(timeframe).lookbackMs;
  const tMax =
    timeframe === "24H"
      ? settleTs
      : now > 0 ? now : Date.now();

  // BTC y-axis: auto-fit to the actual BTC range in the visible window
  // (was a fixed ±$1500 around strike, which clipped when BTC moved past
  // those bounds — the BTC endpoint chip rendered as a half-clipped box
  // at the chart's top edge). Always includes strike + live mark with 8%
  // padding so nothing sits flush against the edge.
  const { btcYMin, btcYMax, strikeY } = useMemo(() => {
    const prices: number[] = [];
    for (const c of btcCandles) {
      if (c.t < tMin || c.t > tMax) continue;
      const p = parseFloat(c.c);
      if (Number.isFinite(p)) prices.push(p);
    }
    if (btcMark != null) prices.push(btcMark);
    if (strike != null) prices.push(strike);
    const min = prices.length ? Math.min(...prices) : (strike ?? 80000) - 1500;
    const max = prices.length ? Math.max(...prices) : (strike ?? 80000) + 1500;
    const span = Math.max(800, max - min);
    const pad = Math.max(150, span * 0.08);
    const yMin = min - pad;
    const yMax = max + pad;
    const sY = strike != null ? H - ((strike - yMin) / (yMax - yMin)) * H : H / 2;
    return { btcYMin: yMin, btcYMax: yMax, strikeY: sY };
  }, [btcCandles, btcMark, strike, tMin, tMax]);
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

  // Faded σ√t reference — what the YES probability "should" be at each
  // moment given BTC's actual price path + a 65% annual-vol assumption.
  // The gap to the real market river IS the trade signal: when the real
  // market sits well above fair value, sellers are getting a premium;
  // below means buyers are. Auto-cleared in the imminent expiry tier
  // (page caller zeroes the prop) since the math blows up near settle.
  const fairPoints = useMemo(() => {
    if (!fairProbSeries.length || !Number.isFinite(tMin) || tMax <= tMin) return "";
    return fairProbSeries
      .map((d) => {
        const x = ((d.x - tMin) / (tMax - tMin)) * W;
        const y = H - d.p * H;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [fairProbSeries, tMin, tMax]);

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
  // strikeY is computed above in the BTC y-axis memo (now that the axis
  // auto-fits, strike isn't always at H/2).

  const endY = H - (yesCents / 100) * H;
  // kalshiY/polyY removed — on-chart chips eliminated as duplicate of the
  // cross-venue strip. Refer to compare/legend for those values.

  // ── Whales — HYBRID: candle volume for historical distribution (spans
  //    the full 24h immediately), overlaid with WS-trade buckets for
  //    the recent hour where we have actual per-trade detail. As the
  //    server collector accumulates over days, the "recent" window
  //    naturally widens and the chart shows more fine-grained flow.
  const whales = useMemo(() => {
    type Whale = { x: number; y: number; usd: number; px: number; side: string; count: number; time: number; bucketIdx: number };
    const BUCKET_MS = 15 * 60 * 1000; // 15-min buckets — matches candle cadence

    // Which coin's trades we care about, per the user's trade-side toggle.
    const wantedCoin = hip4Coin && tradeSide === "yes"
      ? hip4Coin
      : hip4Coin
        ? `#${hip4Coin.slice(1, -1)}1`
        : null;

    // Bucket by (time-slot, side). Each (slot, side) pair gets its own
    // whale so a 15-min slot with both buys AND sells produces TWO
    // whales that share the same x-column and stack vertically.
    type Agg = { tSum: number; pxSum: number; usd: number; count: number; side: string; bucketIdx: number };
    const buckets = new Map<string, Agg>();

    for (const t of trades) {
      if (!wantedCoin || t.coin !== wantedCoin) continue;
      if (t.time < tMin || t.time > tMax) continue;
      const px = parseFloat(t.px);
      const sz = parseFloat(t.sz);
      if (!Number.isFinite(px) || !Number.isFinite(sz)) continue;
      const bucketIdx = Math.floor(t.time / BUCKET_MS);
      const key = `${t.side}:${bucketIdx}`;
      const usd = px * sz;
      const b = buckets.get(key);
      if (b) {
        b.tSum += t.time;
        b.pxSum += px;
        b.usd += usd;
        b.count += 1;
      } else {
        buckets.set(key, { tSum: t.time, pxSum: px, usd, count: 1, side: t.side, bucketIdx });
      }
    }

    const raw: Whale[] = [];

    // Trade-derived whales — up to 2 per bucket (one buy + one sell)
    for (const b of buckets.values()) {
      // Center x on bucket midpoint so same-bucket whales share a column
      const bucketCenter = (b.bucketIdx + 0.5) * BUCKET_MS;
      const t = bucketCenter; // collapse to exact bucket midpoint
      const px = b.pxSum / b.count;
      const yesPx = tradeSide === "yes" ? px : 1 - px;
      raw.push({
        x: ((t - tMin) / (tMax - tMin)) * W,
        y: H - yesPx * H,
        usd: b.usd,
        px,
        side: b.side,
        count: b.count,
        time: t,
        bucketIdx: b.bucketIdx,
      });
    }

    // Candle-volume fallback for buckets where the WS has no data.
    // Renders as one whale per slot with the candle's direction (inverted
    // for NO toggle).
    const seenBuckets = new Set([...buckets.values()].map((b) => b.bucketIdx));
    for (const c of marketCandles) {
      if (c.t < tMin || c.t > tMax) continue;
      const bucketIdx = Math.floor(c.t / BUCKET_MS);
      if (seenBuckets.has(bucketIdx)) continue;
      const open = parseFloat(c.o);
      const close = parseFloat(c.c);
      const vol = parseFloat(c.v);
      if (!Number.isFinite(vol) || vol <= 0) continue;
      const avgPx = (open + close) / 2;
      const usd = vol * avgPx;
      const bucketCenter = (bucketIdx + 0.5) * BUCKET_MS;
      const isBullYes = close >= open;
      const isBuyForSide = tradeSide === "yes" ? isBullYes : !isBullYes;
      const yesPx = tradeSide === "yes" ? close : 1 - close;
      raw.push({
        x: ((bucketCenter - tMin) / (tMax - tMin)) * W,
        y: H - yesPx * H,
        usd,
        px: close,
        side: isBuyForSide ? "B" : "A",
        count: Math.round(vol),
        time: bucketCenter,
        bucketIdx,
      });
    }

    // Top 12 by USD globally, then stack within same bucket index.
    const maxUsd = raw.reduce((m, w) => Math.max(m, w.usd), 1);
    const diameterFor = (usd: number) => 14 + Math.min(1, usd / maxUsd) * 14;
    const ranked = raw.sort((a, b) => b.usd - a.usd).slice(0, 12);

    // Group by bucketIdx so same-column whales stack as a vertical line.
    const byBucket = new Map<number, (Whale & { d: number })[]>();
    for (const w of ranked) {
      const d = diameterFor(w.usd);
      const arr = byBucket.get(w.bucketIdx) ?? [];
      arr.push({ ...w, d });
      byBucket.set(w.bucketIdx, arr);
    }
    const placed: (Whale & { d: number })[] = [];
    for (const [, arr] of byBucket) {
      // Biggest in the bucket anchors at the trade's actual price (y);
      // subsequent whales stack vertically upward by one diameter each.
      arr.sort((a, b) => b.usd - a.usd);
      let stackY = arr[0].y;
      for (const w of arr) {
        placed.push({ ...w, y: stackY });
        stackY -= w.d + 2;
      }
    }
    return placed;
  }, [trades, marketCandles, hip4Coin, tMin, tMax, tradeSide]);
  const maxWhaleUsd = whales.reduce((m, w) => Math.max(m, w.usd), 1);

  // ── Volume profile — one thin bar per HIP-4 candle, scaled by the candle's
  //    `v` field. Gives the chart historical-flow context even when individual
  //    trades aren't backfilled (which they can't be — HL doesn't have a
  //    historical trades endpoint, only `recentTrades` + the WS stream).
  const volBars = useMemo(() => {
    if (!marketCandles.length) return [] as { x: number; w: number; h: number; bull: boolean }[];
    const inWindow = marketCandles.filter((c) => c.t >= tMin && c.t <= tMax);
    if (!inWindow.length) return [];
    const maxVol = inWindow.reduce((m, c) => Math.max(m, parseFloat(c.v)), 0.001);
    const candleSpanMs = 15 * 60 * 1000;
    const barWPct = ((candleSpanMs / (tMax - tMin)) * W) * 0.7; // 70% width of candle slot
    return inWindow.map((c) => {
      const vol = parseFloat(c.v);
      const open = parseFloat(c.o);
      const close = parseFloat(c.c);
      const heightPct = Math.max(0.02, vol / maxVol); // min visible
      return {
        x: ((c.t + candleSpanMs / 2 - tMin) / (tMax - tMin)) * W,
        w: Math.max(1, barWPct),
        h: heightPct * 40, // up to 40px tall
        bull: close >= open,
      };
    });
  }, [marketCandles, tMin, tMax]);

  // Limit-order horizontal line position
  const limitY = limitOrderCents != null ? H - (limitOrderCents / 100) * H : null;

  // Depth heatmap removed — in tight markets (e.g. YES at 97¢) the book
  // levels cluster within a few cents and the bands rendered as a fuzzy
  // fringe instead of meaningful walls. The order-book panel below the
  // chart already shows full depth with proper price/size info.

  return (
    <div className="panel" style={{ minHeight: 540 }}>
      <div className="px-3 py-2 flex items-center" style={{ borderBottom: "1px solid var(--hl-border)" }}>
        <span className="ptitle">Probability river</span>
        <span className="psub ml-3">live · computed from BTC mark vs strike</span>
        <div className="ml-auto flex gap-1 text-[10px]" style={{ color: "var(--hl-muted)" }}>
          {(["1H", "6H", "24H"] as const).map((tf) => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              className="px-2 py-0.5 rounded transition-colors"
              style={{
                background: timeframe === tf ? "var(--hl-surface-hover)" : "transparent",
                color: timeframe === tf ? "var(--hl-accent)" : "var(--hl-muted)",
                fontWeight: timeframe === tf ? 600 : 400,
                cursor: "pointer",
              }}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>
      <div className="p-3 flex flex-col">
        {/* The 70px spacer above the chart is a "whale stack zone" — whales
            pushed up by collision avoidance render into this space. The
            chart-canvas div below keeps its original 420px height + positioning,
            so the SVG and all child absolute-positioning math stays unchanged.
            overflow: visible lets whales (when forced very high) render into
            this zone instead of clipping. */}
        <div style={{ height: 70 }} />
        <div className="relative" style={{ height: 420, overflow: "visible" }}>
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
            {/* BTC price line — true orange, so the legend's "orange line = BTC"
                actually matches the colour rendered. */}
            {btcPoints && (
              <polyline
                fill="none"
                stroke="#fb923c"
                strokeWidth="1.8"
                strokeDasharray="0"
                opacity="0.85"
                points={btcPoints}
              />
            )}

            {/* Strike reference — kept yellow (#f5a524) so it's visually distinct
                from the BTC line, and matches the "yellow strike threshold" legend. */}
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
                  opacity="0.4"
                />
              </>
            )}

            {/* Volume bars from HIP-4 candles — sits at the chart bottom,
                coloured by candle direction (close >= open). Tells you where
                flow happened in the last 24h. */}
            {volBars.map((b, i) => (
              <rect
                key={i}
                x={b.x - b.w / 2}
                y={H - b.h - 18}
                width={b.w}
                height={b.h}
                fill={b.bull ? "#4ade80" : "#f87171"}
                opacity="0.4"
              />
            ))}

            {points && <path d={areaPath} fill="url(#rgrad)" />}

            {/* Faded σ√t fair-value reference — what YES "should" be given
                BTC's path. The gap to the real market is the signal. */}
            {fairPoints && (
              <polyline
                fill="none"
                stroke="#a371f7"
                strokeWidth="1.4"
                strokeDasharray="5,4"
                opacity="0.7"
                points={fairPoints}
              />
            )}

            {points && <polyline fill="none" stroke="#4ade80" strokeWidth="2.4" points={points} />}

            {/* NO line — mirror of YES (probabilities sum to 100¢), drawn
                slightly thinner + lower opacity so YES stays the primary read.
                Lets you read the NO price directly without inverting. */}
            {points && (
              <polyline
                fill="none"
                stroke="#f87171"
                strokeWidth="1.6"
                opacity="0.55"
                points={points
                  .split(" ")
                  .map((pt) => {
                    const [x, y] = pt.split(",");
                    // mirror y around the chart's vertical midpoint (H/2)
                    return `${x},${H - parseFloat(y)}`;
                  })
                  .join(" ")}
              />
            )}

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

            {/* Pending limit order line — only shown when user is composing a
                limit order in the panel (not yet placed). Cyan = your price. */}
            {limitY != null && (
              <line
                x1="0"
                y1={limitY}
                x2={W}
                y2={limitY}
                stroke="#00f0ff"
                strokeWidth="1.4"
                strokeDasharray="4,4"
                opacity="0.85"
              />
            )}
          </svg>

          {/* ── Trade-flow icons — icon only, no chip label. Details on hover.
                Bigger circle = more $$. Stacking handled in the whales memo. ── */}
          {whales.map((w, i) => {
            const isBuy = w.side === "B" || w.side === "buy";
            const sizeFactor = Math.min(1, w.usd / maxWhaleUsd);
            const px = 14 + sizeFactor * 14; // 14-28px diameter
            const usdStr = w.usd >= 1000 ? `$${(w.usd / 1000).toFixed(1)}K` : `$${w.usd.toFixed(0)}`;
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
                title={`Click for details · ${isBuy ? "BUY" : "SELL"} ${tradeSide.toUpperCase()} · ${w.count} trade${w.count > 1 ? "s" : ""} @ ~${(w.px * 100).toFixed(1)}¢ · ${usdStr}`}
                onClick={() => onWhaleClick({ side: w.side, sideContext: tradeSide, px: w.px, usd: w.usd, count: w.count, time: w.time })}
              >
                🐋
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
          {/* NO endpoint label (red) — mirrors YES at (100 - yesCents)
              on the right y-axis. */}
          {nowX != null && (
            <div
              className="absolute mono"
              style={{
                left: `${(nowX / W) * 100}%`,
                top: `${((H - endY) / H) * 100}%`,
                transform: "translate(8px, -50%)",
                background: "var(--hl-red)",
                color: "#2a0606",
                padding: "3px 8px",
                borderRadius: 3,
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: 0.3,
                whiteSpace: "nowrap",
                pointerEvents: "none",
                zIndex: 5,
                boxShadow: "0 0 10px rgba(248,113,113,0.5)",
              }}
            >
              NO · {100 - yesCents}¢
            </div>
          )}
          {/* BTC mark endpoint label — true orange (#fb923c) to actually
              match the "orange line = BTC price" legend label. */}
          {nowX != null && btcMark != null && (
            <div
              className="absolute mono"
              style={{
                left: `${(nowX / W) * 100}%`,
                top: `${(btcToY(btcMark) / H) * 100}%`,
                transform: "translate(8px, -50%)",
                background: "#fb923c",
                color: "#1d0606",
                padding: "3px 8px",
                borderRadius: 3,
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: 0.3,
                whiteSpace: "nowrap",
                pointerEvents: "none",
                zIndex: 5,
                boxShadow: "0 0 10px rgba(251,146,60,0.55)",
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

          {/* LEFT y-axis — BTC price (orange labels match the BTC line) with
              the strike row highlighted in yellow to match the strike line. */}
          {strike != null && (
            <div
              className="absolute left-0 top-0 bottom-4 mono"
              style={{ width: 70, fontSize: 9, color: "#fb923c", padding: "2px 4px", pointerEvents: "none", opacity: 0.75 }}
            >
              <span style={{ position: "absolute", top: "0%", left: 4 }}>${Math.round(btcYMax).toLocaleString()}</span>
              <span style={{ position: "absolute", top: "25%", left: 4 }}>${Math.round(btcYMin + (btcYMax - btcYMin) * 0.75).toLocaleString()}</span>
              <span style={{ position: "absolute", top: `${(strikeY / H) * 100}%`, left: 4, color: "var(--hl-yellow)", fontWeight: 700, transform: "translateY(-50%)", opacity: 1 }}>
                ${strike.toLocaleString()} ◀ strike
              </span>
              <span style={{ position: "absolute", top: "75%", left: 4 }}>${Math.round(btcYMin + (btcYMax - btcYMin) * 0.25).toLocaleString()}</span>
              <span style={{ position: "absolute", bottom: 0, left: 4 }}>${Math.round(btcYMin).toLocaleString()}</span>
            </div>
          )}

          {/* NOW chip removed — the dashed vertical line + the "now ▶"
              label in the x-axis convey the same thing without the
              outlined-box artifact the user kept noticing. */}

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
            {timeframe === "24H" ? (
              <>
                <span>open · 06:00 UTC</span>
                <span>−18h</span>
                <span>−12h</span>
                <span>−6h</span>
                <span>settle ▶</span>
              </>
            ) : timeframe === "6H" ? (
              <>
                <span>−6h</span>
                <span>−4h 30m</span>
                <span>−3h</span>
                <span>−1h 30m</span>
                <span>now ▶</span>
              </>
            ) : (
              <>
                <span>−1h</span>
                <span>−45m</span>
                <span>−30m</span>
                <span>−15m</span>
                <span>now ▶</span>
              </>
            )}
          </div>

          {/* Conviction thumb + arc removed — order entry uses standard limit/market panel */}

          {/* Kalshi + Polymarket on-chart chips removed — duplicate with the
              cross-venue strip at top + the legend at bottom. The right edge
              now only has the two primary endpoint chips (YES and BTC) plus
              the optional limit-order chip when composing a limit. */}

          {/* Pending limit-order endpoint label — cyan chip near the right edge
              when a limit is being composed. */}
          {limitY != null && limitOrderCents != null && (
            <div
              className="absolute mono"
              style={{
                right: 32,
                top: `${(limitY / H) * 100}%`,
                transform: "translate(100%, -50%)",
                background: "var(--hl-accent)",
                color: "var(--background)",
                fontSize: 10,
                fontWeight: 800,
                padding: "2px 6px",
                borderRadius: 2,
                whiteSpace: "nowrap",
                pointerEvents: "none",
                zIndex: 4,
                boxShadow: "0 0 8px rgba(0,240,255,0.6)",
              }}
            >
              YOUR LIMIT · {(limitOrderTypedCents ?? limitOrderCents).toFixed(1)}¢ {limitOrderSide?.toUpperCase()}
            </div>
          )}
          {/* HIP-4 horizontal label removed — the green river IS the HIP-4 mark. */}
        </div>

        <div className="flex flex-wrap gap-4 mt-2 pt-2 text-[10px] items-center" style={{ borderTop: "1px solid var(--hl-border)", color: "var(--hl-muted)" }}>
          <span className="inline-flex items-center gap-1.5">
            <span style={{ width: 18, height: 3, background: "var(--hl-green)", display: "inline-block", borderRadius: 1 }}></span>
            <b style={{ color: "var(--hl-green)" }}>YES</b> <span style={{ color: "var(--hl-muted)" }}>· right axis 0¢-100¢</span>
          </span>
          <span className="inline-flex items-center gap-1.5" title="NO is the inverse of YES: NO = 100 − YES. Both sides sum to $1 at settle.">
            <span style={{ width: 18, height: 2, background: "var(--hl-red)", display: "inline-block", borderRadius: 1, opacity: 0.7 }}></span>
            <b style={{ color: "var(--hl-red)" }}>NO</b> <span style={{ color: "var(--hl-muted)" }}>· 100 − YES</span>
          </span>
          <span className="inline-flex items-center gap-1.5" title="What the YES price 'should' be given BTC's path + 65% annual vol. Gap to market = trade signal. Hidden in last 15min when math breaks.">
            <span style={{ display: "inline-flex", gap: 2 }}>
              <span style={{ width: 5, height: 1.5, background: "#a371f7", opacity: 0.7 }}></span>
              <span style={{ width: 5, height: 1.5, background: "#a371f7", opacity: 0.7 }}></span>
            </span>
            <b style={{ color: "#a371f7" }}>σ√t fair value</b> <span style={{ color: "var(--hl-muted)" }}>· reference</span>
          </span>
          <span className="inline-flex items-center gap-1.5" title="Solid orange line — live BTC mark over the last 24h. The underlying that drives the YES probability.">
            <span style={{ width: 20, height: 3, background: "#fb923c", display: "inline-block", borderRadius: 1 }}></span>
            <b style={{ color: "#fb923c" }}>orange line = BTC price</b> <span style={{ color: "var(--hl-muted)" }}>· left axis $</span>
          </span>
          <span className="inline-flex items-center gap-1.5" title="Horizontal dashed YELLOW line at the strike price. BTC above this line at expiry = YES wins.">
            <span style={{ display: "inline-flex", gap: 2 }}>
              <span style={{ width: 5, height: 1.5, background: "var(--hl-yellow)", opacity: 0.55 }}></span>
              <span style={{ width: 5, height: 1.5, background: "var(--hl-yellow)", opacity: 0.55 }}></span>
            </span>
            <b style={{ color: "var(--hl-yellow)", opacity: 0.85 }}>yellow dashed = strike</b> <span style={{ color: "var(--hl-muted)" }}>· settle threshold</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span style={{ display: "inline-flex", gap: 1 }}>
              <span style={{ width: 3, height: 10, background: "var(--hl-green)", opacity: 0.4 }} />
              <span style={{ width: 3, height: 6, background: "var(--hl-red)", opacity: 0.4 }} />
              <span style={{ width: 3, height: 12, background: "var(--hl-green)", opacity: 0.4 }} />
            </span>
            <b>volume bars</b> <span style={{ color: "var(--hl-muted)" }}>· per 15min candle</span>
          </span>
          <span className="inline-flex items-center gap-2" title="Flow for the side you're trading. Toggle YES/NO in the order panel to swap.">
            <span style={{ fontSize: 12 }}>🐋</span>
            <span className="inline-flex items-center gap-1">
              <span style={{ width: 10, height: 10, borderRadius: "50%", border: "2px solid var(--hl-green)", background: "var(--background)", display: "inline-block" }}></span>
              <b style={{ color: "var(--hl-green)" }}>BUY {tradeSide.toUpperCase()}</b>
            </span>
            <span className="inline-flex items-center gap-1">
              <span style={{ width: 10, height: 10, borderRadius: "50%", border: "2px solid var(--hl-red)", background: "var(--background)", display: "inline-block" }}></span>
              <b style={{ color: "var(--hl-red)" }}>SELL {tradeSide.toUpperCase()}</b>
            </span>
            <span style={{ color: "var(--hl-muted)" }}>· flip side to swap</span>
          </span>
          {kalshiCents != null && (
            <span className="inline-flex items-center gap-1" title="Linearly interpolated at HIP-4's strike">
              Kalshi <b className="mono" style={{ color: "var(--hl-yellow)" }}>{kalshiCents}%</b>
              <span style={{ color: "var(--hl-muted)" }}>@ HL strike (interp)</span>
            </span>
          )}
          {polyCents != null && (
            <span className="inline-flex items-center gap-1" title="Linearly interpolated at HIP-4's strike">
              Polymarket <b className="mono" style={{ color: "var(--hl-purple)" }}>{polyCents}%</b>
              <span style={{ color: "var(--hl-muted)" }}>@ HL strike (interp)</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function LiveOrderBook({ hyperodd, fairCents, now }: { hyperodd: HyperOddState; fairCents: number; now: number }) {
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
            <span className="cellL" style={{ marginTop: 4, color: "var(--hl-yellow)" }}>HL implied {fairCents}¢</span>
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
  orderStatus,
  onSubmit,
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
  orderStatus: { kind: "idle" | "pending" | "success" | "error"; message?: string };
  onSubmit: () => void;
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
          style={{
            background: orderStatus.kind === "pending"
              ? "var(--hl-muted)"
              : side === "yes" ? "var(--hl-green)" : "var(--hl-red)",
            color: "#001d0c",
            border: "none",
            cursor: orderStatus.kind === "pending" ? "wait" : "pointer",
            opacity: orderStatus.kind === "pending" ? 0.7 : 1,
          }}
          disabled={orderStatus.kind === "pending"}
          onClick={onSubmit}
        >
          {orderStatus.kind === "pending"
            ? "Placing order…"
            : orderType === "market"
              ? `${side === "yes" ? "Buy YES" : "Buy NO"} @ market`
              : `${side === "yes" ? "Buy YES" : "Buy NO"} @ ${parseFloat(limitPx || "0").toFixed(1)}¢`}
        </button>

        {/* Inline order status */}
        {orderStatus.kind === "success" && (
          <div
            className="text-[10px] px-2 py-1.5"
            style={{
              background: "rgba(74,222,128,0.1)",
              border: "1px solid rgba(74,222,128,0.35)",
              color: "var(--hl-green)",
            }}
          >
            ✓ {orderStatus.message ?? "Order placed"}
          </div>
        )}
        {orderStatus.kind === "error" && (
          <div
            className="text-[10px] px-2 py-1.5"
            style={{
              background: "rgba(248,113,113,0.1)",
              border: "1px solid rgba(248,113,113,0.35)",
              color: "var(--hl-red)",
            }}
          >
            ✗ {orderStatus.message ?? "Order failed"}
          </div>
        )}

        <div className="text-[9px] text-center tracking-wide" style={{ color: "var(--hl-muted)" }}>
          Settles 06:00 UTC tomorrow · 1.5 bps builder fee
        </div>
      </div>
    </div>
  );
}

function CompareStrip({
  fairCents,
  compare,
  strike,
  hyperodd,
  now,
}: {
  fairCents: number;  // σ√t fair value (HLOne implied — what THEORY says)
  compare: CompareData | null;
  strike: number | null;
  hyperodd: HyperOddState;
  now: number;
}) {
  // Freshness — how long ago was the cross-venue compare data fetched?
  // Freshness timer removed — it ticked every second and the changing width
  // of "3s ago" → "12s ago" → "1m ago" caused the cross-venue strip to
  // reflow constantly, jittering the rest of the UI.
  const k = compare?.kalshi;
  // Prefer the interpolated price at HL's strike (apples-to-apples); fall
  // back to the closest actual strike's last trade if interpolation didn't
  // produce a value.
  const kalshiCents =
    k?.available && k.interpolatedYes != null
      ? Math.round(k.interpolatedYes * 100)
      : k?.available && k.last != null
        ? Math.round(k.last * 100)
        : null;
  const kalshiIsInterpolated = k?.interpolatedYes != null;

  const p = compare?.polymarket;
  const polyCents =
    p?.available && p.interpolatedYes != null
      ? Math.round(p.interpolatedYes * 100)
      : p?.available && p.yesPrice != null
        ? Math.round(p.yesPrice * 100)
        : null;
  const polyIsInterpolated = p?.interpolatedYes != null;

  const hyperoddCents = hyperodd.mark != null ? Math.round(hyperodd.mark * 100) : null;

  // ── Edge logic ─────────────────────────────────────────────────────────
  // Anchor: the LIVE HIP-4 market price (the actual thing we're trading).
  // Every other reading is shown as its gap vs HIP-4 live, in percentage
  // points. Two flavours:
  //   1. fairGap = HLOne σ√t fair value vs market — "theory says cheap/rich"
  //      A mean-reversion signal; meaningful, not directly arb-able.
  //   2. kalshiGap / polyGap = same-question venue vs market — cross-venue
  //      arb. If Kalshi YES is 30% while HIP-4 YES is 50%, buy YES on Kalshi
  //      cheaper, hedge on HIP-4. Tradeable (assuming you've got accounts
  //      on both venues + similar settle times).
  //
  // The "best arb" callout picks the largest absolute gap across Kalshi
  // and Polymarket only — HLOne fair is theoretical, not a venue you can
  // trade against. Time-aware threshold: tighter near expiry where pin
  // risk dominates and small noise can produce misleading EDGE flags.
  const fairGap = hyperoddCents != null ? fairCents - hyperoddCents : null;
  const kalshiGap = hyperoddCents != null && kalshiCents != null ? kalshiCents - hyperoddCents : null;
  const polyGap = hyperoddCents != null && polyCents != null ? polyCents - hyperoddCents : null;

  const arbCandidates: { name: string; gap: number; color: string }[] = [];
  if (kalshiGap != null) arbCandidates.push({ name: "Kalshi", gap: kalshiGap, color: "var(--hl-yellow)" });
  if (polyGap != null) arbCandidates.push({ name: "Polymarket", gap: polyGap, color: "var(--hl-purple)" });
  arbCandidates.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  const bestArb = arbCandidates[0];

  // Time-aware threshold — looser near expiry where pin risk creates noise
  const minsToSettleHere = compare ? Math.max(0, (compare.fetchedAt + 0 - now) / 60_000) : 0;
  void minsToSettleHere; // (placeholder if we want to use it later)
  // For now keep threshold simple: 3pp baseline. UI separately dims the
  // arb chip during the imminent expiry tier (handled at page level).
  const edgeThreshold = 3;
  const isArb = bestArb != null && Math.abs(bestArb.gap) >= edgeThreshold;

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
      <span className="cellL" style={{ color: "var(--hl-accent)", fontWeight: 600, letterSpacing: 0.6 }}>
        Cross-venue
      </span>

      {/* HIP-4 LIVE — visual anchor for everything else. */}
      <div
        className="flex items-baseline gap-2 px-2 border-l"
        style={{ borderColor: "var(--hl-border)", boxShadow: "inset 2px 0 0 var(--hl-accent)" }}
      >
        <span style={{ color: "var(--hl-accent)", fontSize: 10, fontWeight: 600 }}>HIP-4 (anchor)</span>
        {hyperoddCents != null ? (
          <>
            <span className="mono font-bold" style={{ color: "var(--hl-accent)", fontSize: 15 }}>{hyperoddCents}%</span>
            <span style={{ color: "var(--hl-muted)", fontSize: 10 }} title={hyperodd.hip4Coin ?? "loading…"}>
              {hyperodd.hip4Coin ?? "loading…"}
            </span>
          </>
        ) : (
          <span style={{ color: "var(--hl-muted)", fontSize: 11 }}>loading…</span>
        )}
      </div>

      {/* HLOne σ√t implied probability — gap is theory-vs-market */}
      <div className="flex items-baseline gap-2 px-2 border-l" style={{ borderColor: "var(--hl-border)" }}>
        <span style={{ color: "var(--hl-muted)", fontSize: 10 }}>Implied prob</span>
        <span className="mono font-bold" style={{ color: "var(--hl-green)", fontSize: 14 }}>{fairCents}%</span>
        <GapChip gap={fairGap} suffix="theory" />
      </div>

      {/* Kalshi — gap is venue-vs-market (tradeable arb) */}
      <div className="flex items-baseline gap-2 px-2 border-l" style={{ borderColor: "var(--hl-border)" }}>
        <span style={{ color: "var(--hl-muted)", fontSize: 10 }}>Kalshi</span>
        {kalshiCents != null ? (
          <>
            <span className="mono font-bold" style={{ color: "var(--hl-yellow)", fontSize: 14 }}>{kalshiCents}%</span>
            <GapChip
              gap={kalshiGap}
              suffix="arb"
              title={
                kalshiIsInterpolated && strike
                  ? `Linearly interpolated at $${strike.toLocaleString()} from Kalshi strikes $${k?.bracketLowerStrike?.toLocaleString() ?? "?"} (${Math.round((k?.bracketLowerYes ?? 0) * 100)}%) and $${k?.bracketUpperStrike?.toLocaleString() ?? "?"} (${Math.round((k?.bracketUpperYes ?? 0) * 100)}%)`
                  : undefined
              }
            />
          </>
        ) : (
          <span style={{ color: "var(--hl-muted)", fontSize: 11 }}>{k?.error ? "unavailable" : "loading…"}</span>
        )}
      </div>

      {/* Polymarket — gap is venue-vs-market (tradeable arb) */}
      <div className="flex items-baseline gap-2 px-2 border-l" style={{ borderColor: "var(--hl-border)" }}>
        <span style={{ color: "var(--hl-muted)", fontSize: 10 }}>Polymarket</span>
        {polyCents != null ? (
          <>
            <span className="mono font-bold" style={{ color: "var(--hl-purple)", fontSize: 14 }}>{polyCents}%</span>
            <GapChip
              gap={polyGap}
              suffix="arb"
              title={
                polyIsInterpolated && strike
                  ? `Linearly interpolated at $${strike.toLocaleString()} from Polymarket strikes $${p?.bracketLowerStrike?.toLocaleString() ?? "?"} (${Math.round((p?.bracketLowerYes ?? 0) * 100)}%) and $${p?.bracketUpperStrike?.toLocaleString() ?? "?"} (${Math.round((p?.bracketUpperYes ?? 0) * 100)}%)`
                  : undefined
              }
            />
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

      {/* Best arb — the largest absolute venue-vs-market gap */}
      <div className="flex items-center gap-2 px-2 border-l" style={{ borderColor: "var(--hl-border)" }}>
        {bestArb != null ? (
          <>
            <span style={{ color: "var(--hl-muted)", fontSize: 10 }}>Best arb</span>
            <span className="mono" style={{ color: bestArb.color, fontSize: 11, fontWeight: 600 }}>{bestArb.name}</span>
            <span
              className="mono font-bold"
              style={{
                color: isArb ? (bestArb.gap < 0 ? "var(--hl-green)" : "var(--hl-red)") : "var(--hl-muted)",
                fontSize: 14,
              }}
              title={
                bestArb.gap < 0
                  ? `${bestArb.name} is ${Math.abs(bestArb.gap)}% CHEAPER than HIP-4 — buy YES on ${bestArb.name}, short YES / buy NO on HIP-4 to hedge.`
                  : `${bestArb.name} is ${bestArb.gap}% MORE EXPENSIVE than HIP-4 — sell YES on ${bestArb.name}, buy YES on HIP-4 to hedge.`
              }
            >
              {bestArb.gap >= 0 ? "+" : ""}
              {bestArb.gap}%
            </span>
            {isArb && (
              <span
                className="mono"
                style={{
                  fontSize: 9,
                  padding: "1px 6px",
                  borderRadius: 2,
                  background: "rgba(245,165,36,0.18)",
                  color: "var(--hl-yellow)",
                  fontWeight: 700,
                  letterSpacing: 0.5,
                }}
                title={`Cross-venue mispricing ≥ ${edgeThreshold}% · settle times differ across venues, so part of the gap is structural, not arb.`}
              >
                ARB
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
