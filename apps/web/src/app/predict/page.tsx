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

import { useEffect, useMemo, useState, type ReactNode } from "react";
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

// ─── HIP-4 priceBucket market ───────────────────────────────────────────────
// A multi-outcome market where N buckets are defined by N-1 thresholds.
// At expiry exactly one bucket settles to $1, the rest to $0 — so the YES
// probabilities sum to ~$1.00 across all named outcomes. Different from the
// binary market in coin layout (3+ outcome IDs instead of 1) and chart
// rendering (stacked area instead of single line).
interface BucketMarket {
  questionId: number;
  underlying: string;       // "BTC"
  expiryMs: number;
  thresholds: number[];     // e.g. [78183, 81374] → 3 buckets
  fallbackOutcome: number | null;
  buckets: BucketLeg[];
}

interface BucketLeg {
  outcomeId: number;
  index: number;            // 0..N-1 — position along the threshold ladder
  label: string;            // "<$78,183" | "$78,183-$81,374" | ">$81,374"
  yesCoin: string;          // "#420"
  noCoin: string;           // "#421"
  // Live state populated by the polling effect.
  yesPrice: number | null;  // 0..1 from allMids
  candles: Candle[];        // YES price history for stacked chart
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

  // Which HIP-4 market the user is viewing: binary YES/NO or multi-bucket
  // (priceBucket question). Tab UI right under the LIVE banner switches
  // between them. Default to binary since most users will know that one.
  const [activeMarket, setActiveMarket] = useState<"binary" | "bucket">("binary");
  const [bucketMarket, setBucketMarket] = useState<BucketMarket | null>(null);

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

  // USDH balance + HIP-4 positions — surfaced in the LIVE banner and the
  // order panels so the user can see "how much can I size" + "do I
  // already hold this market" without leaving the page.
  //
  // - USDH lives in the user's SPOT clearinghouse (spotClearinghouseState).
  // - HIP-4 outcome positions live in the PERP clearinghouse alongside
  //   regular perps — assetPositions[].position.coin is the same "#N0"
  //   / "#N1" coin name the page already tracks.
  const [usdhBalance, setUsdhBalance] = useState<number | null>(null);
  const [hip4Positions, setHip4Positions] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    if (!address) {
      setUsdhBalance(null);
      setHip4Positions(new Map());
      return;
    }
    let cancelled = false;
    // Sticky guards: once we've seen a real balance / position, don't
    // overwrite with 0 / empty on a transient HL hiccup. Without these,
    // every 15s poll that landed during an API blip would briefly wipe
    // the USDH pill in the banner and the order panel's "Current
    // Position" — looked like funds vanishing.
    let hadUsdh = false;
    let hadPositions = false;
    const fetchBalances = async () => {
      try {
        const [spotRes, perpRes] = await Promise.all([
          fetch(HL_INFO, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "spotClearinghouseState", user: address }),
          }),
          fetch(HL_INFO, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "clearinghouseState", user: address }),
          }),
        ]);
        if (cancelled) return;
        if (spotRes.ok) {
          const data = (await spotRes.json()) as { balances?: { coin: string; total: string }[] };
          const balances = data?.balances;
          // If balances missing entirely AND we've previously had a
          // USDH value, that's a hiccup — keep showing the last good.
          if (balances != null) {
            const usdh = balances.find((b) => b.coin === "USDH");
            const v = usdh ? parseFloat(usdh.total) : 0;
            if (v > 0 || !hadUsdh) {
              setUsdhBalance(v);
              if (v > 0) hadUsdh = true;
            }
          }
        }
        if (perpRes.ok) {
          const data = (await perpRes.json()) as {
            assetPositions?: { position: { coin: string; szi: string } }[];
          };
          const map = new Map<string, number>();
          for (const ap of data.assetPositions ?? []) {
            const c = ap.position?.coin;
            if (!c || !/^#\d+[01]$/.test(c)) continue;
            const sz = parseFloat(ap.position.szi);
            if (Number.isFinite(sz) && sz !== 0) map.set(c, sz);
          }
          // Only overwrite when we found something OR we never had any.
          // Empty + previously-had → keep, likely transient blip.
          if (map.size > 0 || !hadPositions) {
            setHip4Positions(map);
            if (map.size > 0) hadPositions = true;
          }
        }
      } catch { /* ignore — sticky preserves last-known-good */ }
    };
    fetchBalances();
    const id = setInterval(fetchBalances, 15_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [address]);

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

    // Parse the description of a priceBucket question. Same delimiter
    // format as the binary one but with `priceThresholds:a,b,...` instead
    // of `targetPrice:X`.
    const parseBucketDesc = (desc: string) => {
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
      const thresholds = (parts.priceThresholds ?? "")
        .split(",")
        .map((s: string) => parseFloat(s))
        .filter((n: number) => Number.isFinite(n));
      return {
        underlying: parts.underlying ?? "BTC",
        thresholds,
        expiryMs,
      };
    };

    // Compose a human-readable label for a bucket given its position in
    // the threshold ladder. e.g. thresholds=[78183, 81374], buckets:
    //   index 0 → "<$78,183"
    //   index 1 → "$78,183-$81,374"
    //   index 2 → ">$81,374"
    const labelForBucket = (idx: number, thresholds: number[]) => {
      const fmt = (n: number) => `$${n.toLocaleString()}`;
      if (idx === 0) return `<${fmt(thresholds[0])}`;
      if (idx === thresholds.length) return `>${fmt(thresholds[thresholds.length - 1])}`;
      return `${fmt(thresholds[idx - 1])} – ${fmt(thresholds[idx])}`;
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
          questions?: { question: number; description: string; namedOutcomes: number[]; fallbackOutcome?: number }[];
        };
        if (cancelled) return;

        // ── Binary market ─────────────────────────────────────────────
        const binary = (data.outcomes ?? []).find((o) =>
          (o.description ?? "").includes("priceBinary"),
        );
        if (binary) {
          const parsed = parseHip4Desc(binary.description);
          setHyperodd((s) => ({
            ...s,
            hip4Outcome: binary.outcome,
            hip4Coin: yesCoinFor(binary.outcome),
            hip4Strike: parsed.strike,
            hip4ExpiryMs: parsed.expiryMs,
            hip4Underlying: parsed.underlying,
          }));
        }

        // ── Bucket market ─────────────────────────────────────────────
        // Question 7 right now is a priceBucket — find any priceBucket
        // question and build its leg list from the named outcomes.
        const bucketQ = (data.questions ?? []).find((q) =>
          (q.description ?? "").includes("priceBucket"),
        );
        if (bucketQ && bucketQ.namedOutcomes?.length) {
          const parsed = parseBucketDesc(bucketQ.description);
          const buckets: BucketLeg[] = bucketQ.namedOutcomes.map((oid, idx) => ({
            outcomeId: oid,
            index: idx,
            label: labelForBucket(idx, parsed.thresholds),
            yesCoin: `#${oid}0`,
            noCoin: `#${oid}1`,
            yesPrice: null,
            candles: [],
          }));
          setBucketMarket((prev) => {
            // Only replace if the underlying market changed (new outcome
            // IDs / new thresholds) — otherwise preserve live price/candle
            // state that the polling effect populated.
            if (
              prev &&
              prev.questionId === bucketQ.question &&
              prev.thresholds.length === parsed.thresholds.length &&
              prev.thresholds.every((t, i) => t === parsed.thresholds[i]) &&
              prev.buckets.length === buckets.length
            ) {
              return prev;
            }
            return {
              questionId: bucketQ.question,
              underlying: parsed.underlying,
              expiryMs: parsed.expiryMs ?? 0,
              thresholds: parsed.thresholds,
              fallbackOutcome: bucketQ.fallbackOutcome ?? null,
              buckets,
            };
          });
        }
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
      // recentTrades is a per-coin endpoint (returns ~last 30s for ONE
      // coin). Fire requests for BOTH the YES and NO coins in parallel,
      // then MERGE into the existing trades buffer using `tid` dedupe —
      // never replace.
      //
      // History: this used to be a single recentTrades(hip4Coin) call
      // whose result REPLACED the buffer. Since hip4Coin is the YES
      // coin only, the every-5s replace would wipe out all the NO
      // trades that the WS subscription had collected, then a 10s
      // serverTrades merge would re-introduce them. That's what made
      // the NO whales at the chart bottom flash on/off every 5s while
      // the YES whales at the top stayed solid.
      const noCoinDerived = `#${hip4Coin.slice(1, -1)}1`;
      try {
        const [yesRes, noRes] = await Promise.all([
          fetch(HL_INFO, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "recentTrades", coin: hip4Coin }),
          }).catch(() => null),
          fetch(HL_INFO, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "recentTrades", coin: noCoinDerived }),
          }).catch(() => null),
        ]);
        if (cancelled) return;
        const incoming: HyperOddTrade[] = [];
        for (const res of [yesRes, noRes]) {
          if (!res || !res.ok) continue;
          const data = (await res.json()) as HyperOddTrade[];
          if (Array.isArray(data)) incoming.push(...data);
        }
        if (incoming.length === 0) return;
        // Merge using tid dedupe, newest first, capped at 500 (same
        // shape as fetchServerTrades below — keeps the chart's whale
        // history coherent across both data sources).
        setHyperodd((s) => {
          const tids = new Set(s.trades.map((t) => t.tid).filter((x): x is number => x != null));
          const fresh = incoming.filter((t) => t.tid == null || !tids.has(t.tid));
          if (!fresh.length) return s;
          const merged = [...fresh, ...s.trades]
            .sort((a, b) => b.time - a.time)
            .slice(0, 500);
          return { ...s, trades: merged };
        });
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

  // ── Bucket market polling: prices via allMids, candles via candleSnapshot.
  //    Runs whenever the bucket coin set changes (daily rollover) and
  //    whenever the user changes the timeframe. We keep this independent
  //    of the binary effect so that switching tabs doesn't tear down the
  //    other market's data — both stay warm in the background.
  const bucketCoinsKey = useMemo(
    () => bucketMarket?.buckets.map((b) => b.yesCoin).join(",") ?? "",
    [bucketMarket],
  );
  useEffect(() => {
    if (!bucketMarket || bucketMarket.buckets.length === 0) return;
    let cancelled = false;
    const yesCoins = bucketMarket.buckets.map((b) => b.yesCoin);

    const fetchMids = async () => {
      try {
        const res = await fetch(HL_INFO, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "allMids" }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as Record<string, string>;
        if (cancelled) return;
        setBucketMarket((prev) => {
          if (!prev) return prev;
          const buckets = prev.buckets.map((b) => {
            const raw = data[b.yesCoin];
            const p = raw != null ? parseFloat(raw) : NaN;
            return { ...b, yesPrice: Number.isFinite(p) ? p : b.yesPrice };
          });
          return { ...prev, buckets };
        });
      } catch { /* ignore */ }
    };

    const { lookbackMs, interval: tfInterval } = tfParams(timeframe);
    const fetchAllCandles = async () => {
      try {
        const end = Date.now();
        const start = end - lookbackMs;
        // Fire all bucket-coin candle fetches in parallel. The HL info
        // endpoint is forgiving of bursts as long as we keep the cadence
        // ≥60s (we run it once per minute below).
        const results = await Promise.all(
          yesCoins.map(async (coin) => {
            try {
              const res = await fetch(HL_INFO, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  type: "candleSnapshot",
                  req: { coin, interval: tfInterval, startTime: start, endTime: end },
                }),
              });
              if (!res.ok) return [coin, [] as Candle[]] as const;
              const data = (await res.json()) as Candle[];
              return [coin, Array.isArray(data) ? data : []] as const;
            } catch {
              return [coin, [] as Candle[]] as const;
            }
          }),
        );
        if (cancelled) return;
        const byCoin = new Map(results);
        setBucketMarket((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            buckets: prev.buckets.map((b) => ({
              ...b,
              candles: byCoin.get(b.yesCoin) ?? b.candles,
            })),
          };
        });
      } catch { /* ignore */ }
    };

    fetchMids();
    fetchAllCandles();
    const midsId = setInterval(fetchMids, 3000);
    const candlesId = setInterval(fetchAllCandles, 60_000);
    return () => {
      cancelled = true;
      clearInterval(midsId);
      clearInterval(candlesId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucketCoinsKey, timeframe]);

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

      {/* LIVE banner — single chunk "● LIVE · HIP-4 MAINNET #600" so
          there's no "HIP-4 MAINNET" + "HIP-4 outcome market" repetition.
          USDH-balance pill removed (it's already shown inside the order
          panel where it's actionable). */}
      <div
        className="max-w-[1440px] mx-auto px-4 py-1.5 flex items-center gap-3 text-[11px]"
        style={{ background: "rgba(74,222,128,0.06)", borderBottom: "1px solid rgba(74,222,128,0.2)" }}
      >
        <span
          className="mono font-bold flex items-center gap-2"
          style={{ color: "var(--hl-green)", letterSpacing: 0.6, fontSize: 10 }}
        >
          <span>● LIVE · HIP-4 MAINNET</span>
          <code className="mono" style={{ color: "var(--hl-accent)", letterSpacing: 0 }}>
            {activeMarket === "binary"
              ? (hyperodd.hip4Coin ?? "loading…")
              : `Q${bucketMarket?.questionId ?? "…"}`}
          </code>
        </span>

        <span
          className="ml-auto mono text-[10px]"
          style={{ color: hyperodd.wsConnected ? "var(--hl-green)" : "var(--hl-muted)" }}
        >
          {hyperodd.wsConnected ? "● ws live" : "○ ws connecting…"}
        </span>
      </div>

      {/* Market-selector tabs — swap between binary (single YES/NO threshold)
          and bucket (multi-outcome range question). Both settle at the same
          06:00 UTC. */}
      <div
        className="max-w-[1440px] mx-auto px-4 pt-3 flex items-center gap-2 text-[12px]"
        style={{ borderBottom: "1px solid var(--hl-border)" }}
      >
        <button
          onClick={() => setActiveMarket("binary")}
          className="px-3 py-1.5 mono font-semibold"
          style={{
            color: activeMarket === "binary" ? "var(--hl-accent)" : "var(--hl-muted)",
            borderBottom: `2px solid ${activeMarket === "binary" ? "var(--hl-accent)" : "transparent"}`,
            marginBottom: -1,
          }}
        >
          Binary · BTC &gt; {strike ? `$${strike.toLocaleString()}` : "$…"}
        </button>
        <button
          onClick={() => setActiveMarket("bucket")}
          className="px-3 py-1.5 mono font-semibold"
          disabled={!bucketMarket}
          style={{
            color: activeMarket === "bucket" ? "var(--hl-accent)" : "var(--hl-muted)",
            borderBottom: `2px solid ${activeMarket === "bucket" ? "var(--hl-accent)" : "transparent"}`,
            marginBottom: -1,
            opacity: bucketMarket ? 1 : 0.4,
            cursor: bucketMarket ? "pointer" : "not-allowed",
          }}
          title={bucketMarket ? "Multi-outcome price-range market" : "Loading…"}
        >
          Buckets {bucketMarket?.buckets.length ? `· ${bucketMarket.buckets.length} ranges` : ""}
        </button>
      </div>

      {/* Expiry warning — only shown when contract is within 60 min of settle */}
      {activeMarket === "binary" && expiryTier !== "none" && (
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

      {/* ── BINARY MARKET (existing UI) ─────────────────────────────────── */}
      {activeMarket === "binary" && <>
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

        {/* BTC settle-target widget removed — distance and BTC mark are
            already in the stats row above; implied-prob line moved into
            the cross-venue strip in place of the Best Arb cell. */}

        {/* Compare strip — HLOne implied vs HL testnet (HyperOdd) vs Kalshi vs Polymarket */}
        <CompareStrip yesProb={yesProb} compare={compare} strike={strike} hyperodd={hyperodd} now={now} expiryTier={expiryTier} />
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
            trades={hyperodd.trades}
            hip4Coin={hyperodd.hip4Coin}
            viewSide={side}
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
            usdhBalance={usdhBalance}
            yesPosition={hyperodd.hip4Coin ? hip4Positions.get(hyperodd.hip4Coin) ?? 0 : 0}
            noPosition={hyperodd.hip4Coin ? hip4Positions.get(`#${hyperodd.hip4Coin.slice(1, -1)}1`) ?? 0 : 0}
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
          {/* Disclosure panel removed — the LIVE banner up top covers
              the essential context. */}
        </div>
      </main>
      </>}

      {/* ── BUCKET MARKET ───────────────────────────────────────────────── */}
      {activeMarket === "bucket" && (
        <BucketMarketView
          market={bucketMarket}
          btcMark={btcMark}
          btcCandles={candles}
          settleTs={settleTs}
          now={now}
          isConnected={isConnected}
          address={address ?? null}
          timeframe={timeframe}
          setTimeframe={setTimeframe}
          usdhBalance={usdhBalance}
          hip4Positions={hip4Positions}
        />
      )}

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
  extraStrikes,
  settleTs,
  now,
  yesCents,
  trades,
  hip4Coin,
  viewSide,
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
  // Extra strike thresholds rendered as additional yellow dashed lines
  // alongside the primary `strike` line. Used by the bucket market view
  // to draw both the lower AND upper boundary of a price range.
  extraStrikes?: { value: number; label?: string }[];
  // Which side the user is currently trading. The chart now SWAPS to
  // match — green YES line/area when "yes", red NO line/area when "no".
  // Without this prop the chart had to show both stacks of whales +
  // the YES line + an explicit NO chip — too much information at once.
  viewSide: "yes" | "no";
  settleTs: number;
  now: number;
  yesCents: number;
  trades: HyperOddTrade[];
  hip4Coin: string | null;  // e.g. "#400" — used to derive the NO coin "#401"
  // tradeSide removed — whales now always render both YES (top stack) and
  // NO (bottom stack), the YES/NO toggle no longer affects the chart.
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
  //  - 1H / 6H: the last N hours ending at NOW, CLAMPED to the contract
  //    open (settleTs − 24h). Without the clamp, picking 6H during the
  //    first 6h of the contract requested data from before the contract
  //    existed, so HIP-4 data only filled the right half of the canvas
  //    while the BTC line (always available) stretched all the way left.
  //    Clamping means the chart always fills its width with real data —
  //    it just compresses to a sub-6h window early in the day.
  const contractOpen = settleTs - 24 * 60 * 60 * 1000;
  const nowSafe = now > 0 ? now : Date.now();
  const tMin =
    timeframe === "24H"
      ? contractOpen
      : Math.max(contractOpen, nowSafe - tfParams(timeframe).lookbackMs);
  const tMax =
    timeframe === "24H"
      ? settleTs
      : nowSafe;

  // BTC y-axis: auto-fit to the actual BTC range in the visible window
  // (was a fixed ±$1500 around strike, which clipped when BTC moved past
  // those bounds — the BTC endpoint chip rendered as a half-clipped box
  // at the chart's top edge). Always includes strike + live mark with 8%
  // padding so nothing sits flush against the edge.
  // Pre-key the extras for the dependency array so the memo recomputes
  // when bucket boundaries change without re-renders forcing every prop
  // to be referentially stable. Using JSON.stringify is fine here — the
  // array is always 0-2 items long.
  const extrasKey = JSON.stringify(extraStrikes ?? []);
  const { btcYMin, btcYMax, strikeY, extraStrikesY } = useMemo(() => {
    const prices: number[] = [];
    for (const c of btcCandles) {
      if (c.t < tMin || c.t > tMax) continue;
      const p = parseFloat(c.c);
      if (Number.isFinite(p)) prices.push(p);
    }
    if (btcMark != null) prices.push(btcMark);
    if (strike != null) prices.push(strike);
    // Extras participate in y-axis fit so both bucket boundaries are
    // always visible (no clipping for ranges where BTC sits well above
    // or below the band).
    if (extraStrikes) for (const e of extraStrikes) if (Number.isFinite(e.value)) prices.push(e.value);
    const min = prices.length ? Math.min(...prices) : (strike ?? 80000) - 1500;
    const max = prices.length ? Math.max(...prices) : (strike ?? 80000) + 1500;
    const span = Math.max(800, max - min);
    const pad = Math.max(150, span * 0.08);
    const yMin = min - pad;
    const yMax = max + pad;
    const sY = strike != null ? H - ((strike - yMin) / (yMax - yMin)) * H : H / 2;
    const extrasY = (extraStrikes ?? []).map((e) => ({
      value: e.value,
      label: e.label,
      y: H - ((e.value - yMin) / (yMax - yMin)) * H,
    }));
    return { btcYMin: yMin, btcYMax: yMax, strikeY: sY, extraStrikesY: extrasY };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [btcCandles, btcMark, strike, tMin, tMax, extrasKey]);
  const btcToY = (price: number) => {
    const t = (price - btcYMin) / (btcYMax - btcYMin);
    return H - Math.max(0, Math.min(1, t)) * H;
  };

  // probSeries comes in YES-space (0..1). When the user is viewing NO,
  // we display 1 - p so the line represents the NO probability at each
  // timestamp. Visually: higher prob = higher on chart (y axis goes up
  // as probability goes up). For NO mode this means the line is a
  // vertical flip of the YES line — when YES is rising, NO is falling.
  const pForDisplay = (p: number) => viewSide === "yes" ? p : 1 - p;

  const points = useMemo(() => {
    if (!probSeries.length || !Number.isFinite(tMin) || tMax <= tMin) return "";
    return probSeries
      .map((d) => {
        const x = ((d.x - tMin) / (tMax - tMin)) * W;
        const y = H - pForDisplay(d.p) * H;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probSeries, tMin, tMax, viewSide]);

  // Faded σ√t reference — what the active-side probability "should" be
  // at each moment given BTC's actual price path + 65% annual-vol. The
  // gap to the real market river IS the trade signal. Same NO-inversion
  // applies so YES theory and NO theory mirror correctly.
  const fairPoints = useMemo(() => {
    if (!fairProbSeries.length || !Number.isFinite(tMin) || tMax <= tMin) return "";
    return fairProbSeries
      .map((d) => {
        const x = ((d.x - tMin) / (tMax - tMin)) * W;
        const y = H - pForDisplay(d.p) * H;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fairProbSeries, tMin, tMax, viewSide]);

  // Side-driven colour theme — green for YES, red for NO. Applied to the
  // probability line, its filled area, and the right-edge chip.
  const sideColor = viewSide === "yes" ? "#4ade80" : "#f87171";
  const sideGradId = viewSide === "yes" ? "rgrad-yes" : "rgrad-no";

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

  // ── Whales — anchored to the chart EDGES, not the price line.
  //    YES trades (coin ending in 0) stack down from the TOP edge.
  //    NO trades (coin ending in 1) stack up from the BOTTOM edge.
  //    Both stacks always visible regardless of the user's YES/NO
  //    trade-side toggle — the toggle now only colours the order panel.
  //    This was a deliberate move away from line-anchored stacks: when
  //    the price moves and the line sits low (e.g. fresh contract still
  //    near 50¢), the line-anchored whales covered the data we wanted to
  //    read most. Pinning them to the chart edges keeps the middle band
  //    clean.
  const whales = useMemo(() => {
    type Whale = {
      x: number;
      y: number;
      usd: number;
      px: number;
      side: string;     // "B" / "A" — colour
      isYes: boolean;   // top stack if true, bottom stack if false
      count: number;
      time: number;
      bucketIdx: number;
    };

    // Bucket size adapts to the visible timeframe so we always get a
    // reasonable number of stack-columns regardless of zoom level.
    const totalMs = tMax - tMin;
    const BUCKET_MS =
      totalMs >= 12 * 60 * 60 * 1000  // 24h-ish view
        ? 30 * 60 * 1000               // → 30-min columns
        : totalMs >= 3 * 60 * 60 * 1000 // 6h-ish view
          ? 10 * 60 * 1000             // → 10-min columns
          : 2 * 60 * 1000;             // 1h view → 2-min columns

    // Coin layout: "#<outcome>0" = YES, "#<outcome>1" = NO. The chart's
    // primary `hip4Coin` is always the YES coin; we derive the NO coin
    // from it and accept trades on EITHER.
    const yesCoin = hip4Coin ?? null;
    const noCoin = hip4Coin ? `#${hip4Coin.slice(1, -1)}1` : null;

    // Bucket by (coin-is-yes, side, bucketIdx) so each (timeslot × side ×
    // contract) gets a separate whale — i.e. a 30-min slot can produce
    // up to FOUR whales (YES buy + YES sell + NO buy + NO sell).
    type Agg = { tSum: number; pxSum: number; usd: number; count: number; side: string; isYes: boolean; bucketIdx: number };
    const buckets = new Map<string, Agg>();

    for (const t of trades) {
      if (!t.coin || (t.coin !== yesCoin && t.coin !== noCoin)) continue;
      if (t.time < tMin || t.time > tMax) continue;
      const px = parseFloat(t.px);
      const sz = parseFloat(t.sz);
      if (!Number.isFinite(px) || !Number.isFinite(sz)) continue;
      const isYes = t.coin === yesCoin;
      const bucketIdx = Math.floor(t.time / BUCKET_MS);
      const key = `${isYes ? "Y" : "N"}:${t.side}:${bucketIdx}`;
      const usd = px * sz;
      const b = buckets.get(key);
      if (b) {
        b.tSum += t.time;
        b.pxSum += px;
        b.usd += usd;
        b.count += 1;
      } else {
        buckets.set(key, { tSum: t.time, pxSum: px, usd, count: 1, side: t.side, isYes, bucketIdx });
      }
    }

    // Helper: convert a bucket centre timestamp to an x pixel position,
    // clamped to the chart's visible width. The "current" bucket's
    // midpoint is in the future (e.g., a 10-min bucket is half-in-future
    // for the first 5 minutes of its life) — without the clamp those
    // whales rendered with x > W, drifting off the right edge of the
    // canvas. Snapping to tMax keeps the freshest bucket pinned to the
    // "now" line where it visually belongs.
    const xForBucketCenter = (bucketCenter: number) => {
      const t = Math.min(bucketCenter, tMax);
      return ((t - tMin) / (tMax - tMin)) * W;
    };

    const raw: Whale[] = [];
    for (const b of buckets.values()) {
      const bucketCenter = (b.bucketIdx + 0.5) * BUCKET_MS;
      // Skip whales whose bucket entirely precedes the visible window —
      // pertinent now that tMin clamps to contract open on 6H/1H views.
      if (bucketCenter < tMin - BUCKET_MS / 2) continue;
      const px = b.pxSum / b.count;
      raw.push({
        x: xForBucketCenter(bucketCenter),
        y: 0,           // filled in by the placement loop below
        usd: b.usd,
        px,
        side: b.side,
        isYes: b.isYes,
        count: b.count,
        time: bucketCenter,
        bucketIdx: b.bucketIdx,
      });
    }

    // Candle-volume fallback — when the WS hasn't captured any trades in
    // a bucket yet, infer flow from the candle's direction. Treated as a
    // YES-side whale (the candle is YES probability), buy/sell from
    // close-vs-open. Useful when the contract just rolled and the trade
    // buffer is sparse.
    const seenYesBuckets = new Set(
      [...buckets.values()].filter((b) => b.isYes).map((b) => b.bucketIdx),
    );
    for (const c of marketCandles) {
      if (c.t < tMin || c.t > tMax) continue;
      const bucketIdx = Math.floor(c.t / BUCKET_MS);
      if (seenYesBuckets.has(bucketIdx)) continue;
      const open = parseFloat(c.o);
      const close = parseFloat(c.c);
      const vol = parseFloat(c.v);
      if (!Number.isFinite(vol) || vol <= 0) continue;
      const avgPx = (open + close) / 2;
      const usd = vol * avgPx;
      const bucketCenter = (bucketIdx + 0.5) * BUCKET_MS;
      raw.push({
        x: xForBucketCenter(bucketCenter),
        y: 0,
        usd,
        px: close,
        side: close >= open ? "B" : "A",
        isYes: true,
        count: Math.round(vol),
        time: bucketCenter,
        bucketIdx,
      });
    }

    // Every whale renders at the SAME diameter so size never affects
    // alignment — USD magnitude is encoded in the outline THICKNESS
    // instead (thicker stroke = bigger trade). Cleaner stack visuals
    // and easier to compare across buckets at a glance.
    const DIAMETER = 20;
    const maxUsd = raw.reduce((m, w) => Math.max(m, w.usd), 1);
    // 1.5px (thin, small trade) → 5px (thick, biggest trade in view).
    // Stored on the whale so the render code can read it without
    // re-deriving from maxUsd.
    const outlineFor = (usd: number) => 1.5 + Math.min(1, usd / maxUsd) * 3.5;

    // Show only the ACTIVE side's whales. Previously rendered both YES
    // (top spacer) and NO (bottom spacer) simultaneously, which doubled
    // the visual load and made the chart noisy. The toggle in the order
    // panel now drives which stack is visible — and they all sit in the
    // single TOP spacer, dropping the bottom one entirely.
    //
    // Ranking: we keep the top-USD trades AND always include the most
    // RECENT trades regardless of USD. Without the recent-set, a small
    // $5 user trade got crowded out by 10 unrelated $500+ whales and
    // the user couldn't see their own fill on the chart. Recent set
    // limited to the last hour and 5 trades per side.
    const showYes = viewSide === "yes";
    const sideTrades = raw.filter((w) => showYes ? w.isYes : !w.isYes);
    const topByUsd = [...sideTrades].sort((a, b) => b.usd - a.usd).slice(0, 25);
    const recentSet = [...sideTrades]
      .filter((w) => nowSafe - w.time < 60 * 60 * 1000) // last hour
      .sort((a, b) => b.time - a.time)
      .slice(0, 5);
    // Merge by bucketIdx-keyed dedupe so we never render the same whale twice.
    const seenKey = new Set<string>();
    const ranked: Whale[] = [];
    for (const w of [...recentSet, ...topByUsd]) {
      const k = `${w.isYes ? "Y" : "N"}:${w.side}:${w.bucketIdx}`;
      if (seenKey.has(k)) continue;
      seenKey.add(k);
      ranked.push(w);
    }

    // Stack pixel layout (relative to chart-canvas top, overflow:visible
    // so we can render in the 70px spacer above):
    //   slot 0 centre = -SPACER_PAD - DIAMETER/2 (just above chart top)
    //   slot 1 centre = slot 0 - SLOT_GAP
    //   …
    const SPACER_PAD = 8;
    const SLOT_GAP = DIAMETER + 2;

    const byBucket = new Map<number, (Whale & { d: number; outline: number })[]>();
    for (const w of ranked) {
      const arr = byBucket.get(w.bucketIdx) ?? [];
      arr.push({ ...w, d: DIAMETER, outline: outlineFor(w.usd) });
      byBucket.set(w.bucketIdx, arr);
    }
    const placed: (Whale & { d: number; outline: number })[] = [];
    for (const arr of byBucket.values()) {
      arr.sort((a, b) => b.usd - a.usd);
      arr.forEach((w, idx) => {
        const y = -SPACER_PAD - DIAMETER / 2 - idx * SLOT_GAP;
        placed.push({ ...w, y });
      });
    }
    return placed;
  }, [trades, marketCandles, hip4Coin, tMin, tMax, viewSide, nowSafe]);
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
    // Bar width must match the ACTUAL candle interval for the selected
    // timeframe. Was hardcoded to 15min, which is correct for 24H view
    // but rendered 3× too wide on 6H (5min candles) and 15× too wide on
    // 1H (1min candles) — bars stacked on top of each other and the
    // bottom strip became unreadable.
    const intervalToMs: Record<string, number> = {
      "1m": 60_000,
      "5m": 5 * 60_000,
      "15m": 15 * 60_000,
      "1h": 60 * 60_000,
    };
    const candleSpanMs = intervalToMs[tfParams(timeframe).interval] ?? 15 * 60_000;
    const barWPct = ((candleSpanMs / (tMax - tMin)) * W) * 0.7; // 70% width of candle slot
    return inWindow.map((c) => {
      const vol = parseFloat(c.v);
      const open = parseFloat(c.o);
      const close = parseFloat(c.c);
      const heightPct = Math.max(0.02, vol / maxVol); // min visible
      // bull = "the active side gained ground in this candle". For YES
      // view that's close > open (probability went up). For NO view it
      // inverts because close > open means YES went up = NO went down.
      const yesGained = close >= open;
      return {
        x: ((c.t + candleSpanMs / 2 - tMin) / (tMax - tMin)) * W,
        w: Math.max(1, barWPct),
        h: heightPct * 40, // up to 40px tall
        bull: viewSide === "yes" ? yesGained : !yesGained,
      };
    });
  }, [marketCandles, tMin, tMax, timeframe, viewSide]);

  // Limit-order horizontal line position
  const limitY = limitOrderCents != null ? H - (limitOrderCents / 100) * H : null;

  // Depth heatmap removed — in tight markets (e.g. YES at 97¢) the book
  // levels cluster within a few cents and the bands rendered as a fuzzy
  // fringe instead of meaningful walls. The order-book panel below the
  // chart already shows full depth with proper price/size info.

  return (
    <div className="panel" style={{ minHeight: 610 }}>
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
        {/* 70px spacer ABOVE the chart — hosts the YES whale stack. The
            chart-canvas div below keeps its original 420px height +
            positioning, so the SVG and all child absolute-positioning math
            stays unchanged. overflow:visible on chart-canvas lets whale
            divs (which the memo positions with negative y) render UP into
            this zone, and equivalent positive y values render DOWN into
            the matching spacer below. */}
        <div style={{ height: 70 }} />
        <div className="relative" style={{ height: 420, overflow: "visible" }}>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "calc(100% - 32px)", height: "100%", display: "block" }}>
            <defs>
              {/* Two gradients so the filled area under the probability line
                  picks the right colour per viewSide. Only one is referenced
                  at any time — the unused one costs ~nothing. */}
              <linearGradient id="rgrad-yes" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#4ade80" stopOpacity="0.28" />
                <stop offset="100%" stopColor="#4ade80" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="rgrad-no" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#f87171" stopOpacity="0.28" />
                <stop offset="100%" stopColor="#f87171" stopOpacity="0" />
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
            {/* Extra strike lines (e.g. the upper bound of a bucket range) —
                same visual treatment as the primary strike so both boundaries
                of a "between $X and $Y" market read as one pair. */}
            {extraStrikesY?.map((e, i) => (
              <line
                key={i}
                x1="0"
                y1={e.y}
                x2={W}
                y2={e.y}
                stroke="#f5a524"
                strokeWidth="1"
                strokeDasharray="4,4"
                opacity="0.4"
              />
            ))}

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

            {points && <path d={areaPath} fill={`url(#${sideGradId})`} />}

            {/* Faded σ√t fair-value reference — what the active side
                "should" be given BTC's path. The gap to the real market
                is the trade signal. */}
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

            {/* Probability line — green for YES view, red for NO view.
                Previously rendered BOTH lines at once (YES solid + NO
                mirror dashed) which was visual noise. Now just one,
                driven by the order-panel toggle. */}
            {points && <polyline fill="none" stroke={sideColor} strokeWidth="2.4" points={points} />}

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

          {/* ── Trade-flow icons — all SAME diameter, outline thickness
                scales with USD. Live in the spacers above (YES) and below
                (NO) the chart canvas, never inside the price band. The
                memo computed w.y as ABSOLUTE PIXELS relative to the
                chart-canvas top edge (negative = above chart, > H = below)
                so we use `top: ${y}px` here, not the old fractional %. */}
          {whales.map((w, i) => {
            const isBuy = w.side === "B" || w.side === "buy";
            const sizeFactor = Math.min(1, w.usd / maxWhaleUsd);
            const px = w.d;
            const usdStr = w.usd >= 1000 ? `$${(w.usd / 1000).toFixed(1)}K` : `$${w.usd.toFixed(0)}`;
            return (
              <div
                key={i}
                className="absolute"
                style={{
                  left: `${(w.x / W) * 100}%`,
                  top: `${w.y}px`,
                  transform: "translate(-50%, -50%)",
                  width: px,
                  height: px,
                  borderRadius: "50%",
                  background: "var(--background)",
                  border: `${w.outline}px solid ${isBuy ? "var(--hl-green)" : "var(--hl-red)"}`,
                  boxShadow: `0 0 ${6 + sizeFactor * 10}px ${
                    isBuy ? "rgba(74,222,128,0.4)" : "rgba(248,113,113,0.4)"
                  }`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 9 + sizeFactor * 4,
                  zIndex: 3,
                  cursor: "pointer",
                }}
                title={`Click for details · ${isBuy ? "BUY" : "SELL"} ${w.isYes ? "YES" : "NO"} · ${w.count} trade${w.count > 1 ? "s" : ""} @ ~${(w.px * 100).toFixed(1)}¢ · ${usdStr}`}
                onClick={() => onWhaleClick({ side: w.side, sideContext: w.isYes ? "yes" : "no", px: w.px, usd: w.usd, count: w.count, time: w.time })}
              >
                🐋
              </div>
            );
          })}

          {/* Active-side endpoint label — green YES chip or red NO chip
              depending on the order-panel toggle. Previously rendered
              BOTH chips simultaneously, which doubled the visual noise
              at the right edge AND cluttered the now-line BTC chip. */}
          {nowX != null && (() => {
            const sideCents = viewSide === "yes" ? yesCents : 100 - yesCents;
            const yPct = viewSide === "yes" ? (endY / H) * 100 : ((H - endY) / H) * 100;
            const bg = viewSide === "yes" ? "var(--hl-green)" : "var(--hl-red)";
            const textColor = viewSide === "yes" ? "#001d0c" : "#2a0606";
            const glow = viewSide === "yes" ? "rgba(74,222,128,0.5)" : "rgba(248,113,113,0.5)";
            return (
              <div
                className="absolute mono"
                style={{
                  left: `${(nowX / W) * 100}%`,
                  top: `${yPct}%`,
                  transform: "translate(8px, -50%)",
                  background: bg,
                  color: textColor,
                  padding: "3px 8px",
                  borderRadius: 3,
                  fontSize: 11,
                  fontWeight: 800,
                  letterSpacing: 0.3,
                  whiteSpace: "nowrap",
                  pointerEvents: "none",
                  zIndex: 5,
                  boxShadow: `0 0 10px ${glow}`,
                }}
              >
                {viewSide === "yes" ? "YES" : "NO"} · {sideCents}¢
              </div>
            );
          })()}
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
                ${strike.toLocaleString()} ◀ {extraStrikesY?.length ? "lower" : "strike"}
              </span>
              {extraStrikesY?.map((e, i) => (
                <span
                  key={i}
                  style={{ position: "absolute", top: `${(e.y / H) * 100}%`, left: 4, color: "var(--hl-yellow)", fontWeight: 700, transform: "translateY(-50%)", opacity: 1 }}
                >
                  ${e.value.toLocaleString()} ◀ {e.label ?? "upper"}
                </span>
              ))}
              <span style={{ position: "absolute", top: "75%", left: 4 }}>${Math.round(btcYMin + (btcYMax - btcYMin) * 0.25).toLocaleString()}</span>
              <span style={{ position: "absolute", bottom: 0, left: 4 }}>${Math.round(btcYMin).toLocaleString()}</span>
            </div>
          )}

          {/* NOW chip removed — the dashed vertical line + the "now ▶"
              label in the x-axis convey the same thing without the
              outlined-box artifact the user kept noticing. */}

          {/* x-axis — actual time-of-day ticks, 5 evenly-spaced across
              the chart. Used to be hard-coded relative labels ("-6h",
              "-4h 30m" etc.) which (a) didn't reflect the contract-open
              clamp on 6H/1H views and (b) made reading "when did this
              trade happen" require mental arithmetic. Now shows HH:MM
              in the browser's local time, with "open" marking contract
              start and "settle ▶"/"now ▶" marking the right edge. */}
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
            {(() => {
              const fmtTime = (ts: number) =>
                new Date(ts).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                });
              const N = 5; // number of ticks
              const ticks: { label: string; ts: number }[] = [];
              for (let i = 0; i < N; i++) {
                const ts = tMin + (i / (N - 1)) * (tMax - tMin);
                ticks.push({ label: fmtTime(ts), ts });
              }
              // Special markers on the bookend ticks
              const isLeftEdgeContractOpen = Math.abs(tMin - contractOpen) < 60_000;
              const isRightEdgeSettle = timeframe === "24H";
              return ticks.map((t, i) => (
                <span key={i}>
                  {i === 0 && isLeftEdgeContractOpen ? `open · ${t.label}`
                    : i === N - 1 && isRightEdgeSettle ? `${t.label} · settle ▶`
                    : i === N - 1 ? `${t.label} · now ▶`
                    : t.label}
                </span>
              ));
            })()}
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

        {/* 70px spacer BELOW the chart — hosts the NO whale stack
            (mirror of the spacer above). overflow:visible on the canvas
            allows the whale divs (y > H) to render down into this area. */}
        <div style={{ height: 70 }} />

        {/* Legend removed — line colors + chip labels at line endpoints
            carry the meaning on the chart itself; cross-venue prices
            live in the strip above. */}
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
  usdhBalance,
  yesPosition,
  noPosition,
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
  // Wallet context — mirrors the HL trading panel pattern of showing
  // "Available to Trade" + "Current Position" right above the size input.
  usdhBalance: number | null;
  yesPosition: number;  // shares held in this market's YES coin (#N0)
  noPosition: number;   // shares held in this market's NO coin (#N1)
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

        {/* Wallet context — mirrors the HL trading panel pattern.
            "Available to Trade" is the USDH balance the user can spend.
            "Current Position" shows shares already held on this market
            (YES or NO depending on the side they're viewing). */}
        <div
          className="flex flex-col text-[11px]"
          style={{ background: "var(--background)", border: "1px solid var(--hl-border)" }}
        >
          <div className="flex items-center justify-between px-2 py-1">
            <span style={{ color: "var(--hl-muted)" }}>Available to Trade</span>
            <span className="mono">
              {usdhBalance == null
                ? "—"
                : `${usdhBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDH`}
            </span>
          </div>
          <div className="flex items-center justify-between px-2 py-1" style={{ borderTop: "1px solid var(--hl-border)" }}>
            <span style={{ color: "var(--hl-muted)" }}>Current Position</span>
            <span className="mono">
              {(() => {
                const pos = side === "yes" ? yesPosition : noPosition;
                const label = side === "yes" ? "YES" : "NO";
                if (!pos) return `0 ${label} shares`;
                return `${pos.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${label} shares`;
              })()}
            </span>
          </div>
        </div>

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
  yesProb,
  compare,
  strike,
  hyperodd,
  now,
  expiryTier,
}: {
  yesProb: number;          // σ√t fair value, exact 0..1 (for display precision)
  compare: CompareData | null;
  strike: number | null;
  hyperodd: HyperOddState;
  now: number;
  expiryTier: "none" | "soon" | "imminent";
}) {
  const [showHelp, setShowHelp] = useState(false);
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

  // ── Gap logic ──────────────────────────────────────────────────────────
  // Anchor: the LIVE HIP-4 market price (the actual thing we're trading).
  // Each cross-venue cell shows its gap vs HIP-4 live in percentage points
  // via <GapChip>. The σ√t Implied prob (theory) lives in its own cell at
  // the end of the strip — no GapChip there because it's a continuous
  // theoretical value, not a discrete venue with an arb opportunity.
  const kalshiGap = hyperoddCents != null && kalshiCents != null ? kalshiCents - hyperoddCents : null;
  const polyGap = hyperoddCents != null && polyCents != null ? polyCents - hyperoddCents : null;
  void now; // freshness timer removed; param kept for parent compat.

  return (
    <div
      className="mt-2 px-3 py-2 grid gap-3 text-[11px]"
      style={{
        background: "rgba(0,240,255,0.04)",
        border: "1px solid rgba(0,240,255,0.18)",
        borderRadius: 4,
        gridTemplateColumns: "auto 1fr 1fr 1fr auto",
        alignItems: "center",
      }}
    >
      <span className="flex items-center gap-1.5">
        <span className="cellL" style={{ color: "var(--hl-accent)", fontWeight: 600, letterSpacing: 0.6 }}>
          Cross-venue
        </span>
        <button
          onClick={() => setShowHelp(true)}
          aria-label="How to read this strip"
          title="How to read this strip"
          className="mono"
          style={{
            width: 16,
            height: 16,
            borderRadius: "50%",
            border: "1px solid var(--hl-accent)",
            color: "var(--hl-accent)",
            background: "transparent",
            fontSize: 10,
            lineHeight: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
          }}
        >
          ?
        </button>
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

      {/* Kalshi — gap is venue-vs-market (tradeable arb) */}
      <div className="flex flex-col px-2 border-l" style={{ borderColor: "var(--hl-border)" }}>
        <div className="flex items-baseline gap-2">
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
        {kalshiCents != null && (
          <InterpBracketSubtitle
            isInterpolated={kalshiIsInterpolated}
            lower={k?.bracketLowerStrike}
            upper={k?.bracketUpperStrike}
            hipStrike={strike}
          />
        )}
      </div>

      {/* Polymarket — gap is venue-vs-market (tradeable arb) */}
      <div className="flex flex-col px-2 border-l" style={{ borderColor: "var(--hl-border)" }}>
        <div className="flex items-baseline gap-2">
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
        {polyCents != null && (
          <InterpBracketSubtitle
            isInterpolated={polyIsInterpolated}
            lower={p?.bracketLowerStrike}
            upper={p?.bracketUpperStrike}
            hipStrike={strike}
          />
        )}
      </div>

      {/* σ√t implied probability — replaces the Best Arb cell. Mirrors
          the old "Implied prob: X% σ·√t at 65% annual vol" line that
          previously lived in the BTC settle-target widget. */}
      <div
        className="flex items-center gap-2 px-2 border-l"
        style={{
          borderColor: "var(--hl-border)",
          opacity: expiryTier === "imminent" ? 0.4 : 1,
          textDecoration: expiryTier === "imminent" ? "line-through" : "none",
        }}
        title={
          expiryTier === "imminent"
            ? "Unreliable — σ√t collapses to ~0 near expiry. Trust the live HIP-4 mark."
            : `Theoretical YES probability from BTC mark vs strike at 65% annualised vol. Market currently prints ${hyperodd.mark != null ? Math.round(hyperodd.mark * 100) : "—"}%.`
        }
      >
        <span style={{ color: "var(--hl-muted)", fontSize: 10 }}>Implied prob</span>
        <span className="mono font-bold" style={{ color: "var(--hl-green)", fontSize: 14 }}>
          {(yesProb * 100).toFixed(1)}%
        </span>
        <span style={{ color: "var(--hl-muted)", fontSize: 10 }}>σ·√t · 65% vol</span>
        {hyperodd.mark != null && (
          <span style={{ color: "var(--hl-muted)", fontSize: 10 }}>
            (mkt {Math.round(hyperodd.mark * 100)}%)
          </span>
        )}
      </div>
      {showHelp && <CompareStripHelp onClose={() => setShowHelp(false)} />}
    </div>
  );
}

// Plain-English explainer for the cross-venue strip. Triggered by the
// "?" button next to "Cross-venue" — opens a modal with what each
// column is, how to read the gap, and what to do with that signal.
function CompareStripHelp({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <div
        className="max-w-[640px] w-full p-6 text-[13px] leading-relaxed"
        style={{ background: "var(--hl-surface)", border: "1px solid var(--hl-border)", color: "var(--foreground)", borderRadius: 4 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline mb-4">
          <h2 className="text-[16px] font-bold tracking-tight">How to read the cross-venue strip</h2>
          <button onClick={onClose} className="ml-auto text-[22px] leading-none" style={{ color: "var(--hl-muted)" }}>×</button>
        </div>

        <p className="mb-3" style={{ color: "var(--hl-text)" }}>
          The strip compares the SAME question — &ldquo;Will BTC settle above $X by today&rsquo;s 06:00 UTC?&rdquo; — across every venue we can pull pricing from. Each number is the current YES probability on that venue. The gaps tell you where the prices disagree.
        </p>

        <div className="grid gap-3">
          <ExplainRow
            color="var(--hl-accent)"
            label="HIP-4 (anchor)"
            body={<>
              The LIVE market on Hyperliquid — the only price you can actually trade. Every other column is shown as <i>its</i> gap vs this one. If HIP-4 says 64%, that&rsquo;s what you pay to buy YES right now.
            </>}
          />
          <ExplainRow
            color="var(--hl-yellow)"
            label="Kalshi"
            body={<>
              Same question on Kalshi (US-regulated prediction market). <code className="mono" style={{ color: "var(--hl-yellow)" }}>+32% vs HIP-4</code> means Kalshi YES is priced 32 percentage points <i>higher</i> than HIP-4 — Kalshi traders think YES is much more likely. Big gaps are potential cross-venue arb: buy on the cheap side, sell on the expensive side, hedge until expiry. Caveat: settle times differ across venues so part of the gap is structural, not free money.
            </>}
          />
          <ExplainRow
            color="var(--hl-purple)"
            label="Polymarket"
            body={<>
              Same question on Polymarket (off-shore crypto-collateralised prediction market). Read the gap the same way as Kalshi. The <code className="mono">↗</code> opens the source market so you can verify.
            </>}
          />
          <ExplainRow
            color="var(--hl-green)"
            label="Implied prob (σ·√t · 65% vol)"
            body={<>
              A THEORETICAL fair value, not a venue. Computed from BTC&rsquo;s current spot + a 65% annualised volatility assumption (basic Black-Scholes / GBM). <code className="mono" style={{ color: "var(--hl-muted)" }}>(mkt 64%)</code> is what HIP-4 actually prints. If implied says 56% and the market says 64%, the market is pricing YES at a premium to &ldquo;fair&rdquo; — a mean-reversion signal. NOT a direct arb (you can&rsquo;t trade theory). Becomes useless in the last ~30 min before settle, where the model collapses to ~0 information.
            </>}
          />
        </div>

        <div className="mt-4 pt-3 text-[11px]" style={{ borderTop: "1px solid var(--hl-border)", color: "var(--hl-muted)" }}>
          <b style={{ color: "var(--hl-text)" }}>Strike alignment.</b> Kalshi and Polymarket rarely list the exact strike HIP-4 trades. We pick the two surrounding strikes from each venue&rsquo;s ladder and linearly interpolate to HIP-4&rsquo;s strike. Every Kalshi/Polymarket cell shows the bracket strikes underneath as &ldquo;$78k–$80k&rdquo; plus a coloured dot for confidence.
        </div>

        <div className="mt-3 text-[11px]" style={{ color: "var(--hl-muted)" }}>
          <b style={{ color: "var(--hl-text)" }}>When the comparison is actually reliable</b>
          <div className="mt-2 grid gap-1" style={{ gridTemplateColumns: "auto 1fr", alignItems: "baseline" }}>
            <span className="flex items-center gap-1.5">
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--hl-green)", boxShadow: "0 0 4px var(--hl-green)" }} />
              <b style={{ color: "var(--hl-text)" }}>Bracket ≤ $1k</b>
            </span>
            <span>Linear local approximation is solid. Gap-vs-HIP-4 reads as real venue mispricing.</span>

            <span className="flex items-center gap-1.5 mt-1">
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--hl-yellow)", boxShadow: "0 0 4px var(--hl-yellow)" }} />
              <b style={{ color: "var(--hl-text)" }}>$1k – $2.5k</b>
            </span>
            <span className="mt-1">Some interpolation error. Headline % is in the right ballpark; treat the gap chip with mild skepticism.</span>

            <span className="flex items-center gap-1.5 mt-1">
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--hl-red)", boxShadow: "0 0 4px var(--hl-red)" }} />
              <b style={{ color: "var(--hl-text)" }}>&gt; $2.5k or HIP-4 outside the bracket</b>
            </span>
            <span className="mt-1">The lognormal probability curve isn&rsquo;t linear over wide ranges. Most of the &ldquo;+N% vs HIP-4&rdquo; is interpolation error, not arb-able mispricing.</span>
          </div>

          <div className="mt-3">
            <b style={{ color: "var(--hl-text)" }}>Also worth knowing:</b> Kalshi&rsquo;s daily BTC market often settles at 4PM ET, not 06:00 UTC like HIP-4. A different expiry = a different question; even a tight-bracket comparison there is structurally off. We can&rsquo;t auto-detect this — eyeball it before trading on the gap.
          </div>
        </div>
      </div>
    </div>
  );
}

function ExplainRow({ color, label, body }: { color: string; label: string; body: ReactNode }) {
  return (
    <div className="grid gap-1" style={{ gridTemplateColumns: "140px 1fr", alignItems: "baseline" }}>
      <span className="mono font-bold" style={{ color }}>{label}</span>
      <span style={{ color: "var(--hl-text)" }}>{body}</span>
    </div>
  );
}

// Subtitle line under each Kalshi / Polymarket cell showing the bracket
// strikes the interpolation came from, plus a coloured confidence dot.
// Lets the user see at a glance whether the cross-venue figure is a
// near-exact match (green) or a stretched linear extrapolation across
// a wide bracket gap (red) — the latter is mostly interpolation error,
// not a real venue mispricing, so the user can decide whether to trust
// the headline %.
function InterpBracketSubtitle({
  isInterpolated,
  lower,
  upper,
  hipStrike,
}: {
  isInterpolated: boolean;
  lower: number | undefined;
  upper: number | undefined;
  hipStrike: number | null;
}) {
  // Exact-strike match (rare but possible) → high confidence, no
  // bracket text needed.
  if (!isInterpolated || lower == null || upper == null) {
    return (
      <div className="flex items-center gap-1" style={{ fontSize: 9, color: "var(--hl-muted)", marginTop: 2 }}>
        <span style={{
          width: 6, height: 6, borderRadius: "50%",
          background: "var(--hl-green)", boxShadow: "0 0 4px var(--hl-green)",
        }} />
        <span>exact strike</span>
      </div>
    );
  }

  const width = upper - lower;
  // Distance from HIP-4 strike to the NEAREST bracket bound. If hipStrike
  // sits outside the bracket entirely (extrapolation) we treat that as
  // worst case — flagged red below.
  let outsideBracket = false;
  if (hipStrike != null) {
    if (hipStrike < lower || hipStrike > upper) outsideBracket = true;
  }

  // Confidence tiers picked from how badly linear breaks down on a
  // log-normal probability curve. ≤$1k bracket = trustworthy; up to
  // $2.5k = usable but watch the gap-chip with skepticism; wider or
  // outside the bracket = mostly interpolation error.
  let tier: "high" | "med" | "low";
  if (outsideBracket || width > 2500) tier = "low";
  else if (width > 1000) tier = "med";
  else tier = "high";

  const color =
    tier === "high" ? "var(--hl-green)" :
    tier === "med"  ? "var(--hl-yellow)" :
                      "var(--hl-red)";

  const fmt = (n: number) => n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`;

  const tooltip =
    `Interpolated at HIP-4's strike $${hipStrike?.toLocaleString() ?? "?"} ` +
    `between venue strikes ${fmt(lower)} and ${fmt(upper)} ` +
    `(window $${width.toLocaleString()}). ` +
    (tier === "high"
      ? "Tight bracket — comparison is reliable."
      : tier === "med"
        ? "Moderate bracket — interpolation error possible, treat the gap chip with mild skepticism."
        : outsideBracket
          ? "HIP-4 strike is OUTSIDE the venue's bracket — this is extrapolation, not interpolation. Treat as noise."
          : "Wide bracket — the gap-vs-HIP-4 is mostly interpolation error, not real venue mispricing.");

  return (
    <div
      className="flex items-center gap-1"
      style={{ fontSize: 9, color: "var(--hl-muted)", marginTop: 2 }}
      title={tooltip}
    >
      <span style={{
        width: 6, height: 6, borderRadius: "50%",
        background: color, boxShadow: `0 0 4px ${color}`,
      }} />
      <span className="mono">{fmt(lower)}–{fmt(upper)}</span>
      {outsideBracket && <span style={{ color: "var(--hl-red)" }}> · out</span>}
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

// ─── BucketMarketView ─────────────────────────────────────────────────────
// The HIP-4 priceBucket market is rendered as a dropdown picker + the SAME
// chart used by the binary market. Each named outcome is a YES/NO contract
// on "Will BTC settle in range X?". When the user picks a bucket the chart
// renders that bucket's YES probability over time exactly like the binary,
// with one or two dashed yellow strike lines marking the range boundaries.
function BucketMarketView({
  market,
  btcMark,
  btcCandles,
  settleTs,
  now,
  isConnected,
  address,
  timeframe,
  setTimeframe,
  usdhBalance,
  hip4Positions,
}: {
  market: BucketMarket | null;
  btcMark: number | null;
  btcCandles: Candle[];
  settleTs: number;
  now: number;
  isConnected: boolean;
  address: string | null;
  timeframe: "1H" | "6H" | "24H";
  setTimeframe: (tf: "1H" | "6H" | "24H") => void;
  // Wallet context — same shape as the binary TradePanel uses for its
  // Available-to-Trade + Current-Position rows.
  usdhBalance: number | null;
  hip4Positions: Map<string, number>;
}) {
  const [selectedBucketIdx, setSelectedBucketIdx] = useState(0);
  const [tradeSide, setTradeSide] = useState<"yes" | "no">("yes");
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [stake, setStake] = useState("100");
  const [limitPx, setLimitPx] = useState("");
  const [orderStatus, setOrderStatus] = useState<{ kind: "idle" | "pending" | "success" | "error"; message?: string }>({ kind: "idle" });
  const [bucketTrades, setBucketTrades] = useState<HyperOddTrade[]>([]);
  const [selectedWhale, setSelectedWhale] = useState<{ side: string; sideContext: "yes" | "no"; px: number; usd: number; count: number; time: number } | null>(null);

  const selectedBucket = market?.buckets[selectedBucketIdx] ?? null;
  const selectedYesCoin = selectedBucket?.yesCoin ?? null;

  // Trades for the chart's whale icons. Server already streams every
  // HIP-4 coin's trades; we just filter to the selected bucket's YES + NO
  // coins client-side so the chart can flip whales via the YES/NO toggle.
  useEffect(() => {
    if (!selectedBucket) return;
    let cancelled = false;
    const yesC = selectedBucket.yesCoin;
    const noC = selectedBucket.noCoin;
    const fetchTrades = async () => {
      // Merge incoming trades into the local buffer using tid dedupe,
      // never replace. The server's 5000-trade ring buffer rotates as
      // new trades arrive across all HIP-4 coins, so consecutive polls
      // can return slightly different sets even for the SAME bucket.
      // Replacing wholesale made the NO-side bucket whales flash off
      // every time YES dominated the latest server window.
      try {
        const res = await fetch(`/api/market/predict-trades?limit=2000`);
        if (!res.ok) return;
        const data = (await res.json()) as {
          trades: { coin: string; px: number; sz: number; side: string; time: number; tid: number }[];
        };
        if (cancelled || !Array.isArray(data.trades)) return;
        const incoming = data.trades
          .filter((t) => t.coin === yesC || t.coin === noC)
          .map((t) => ({
            coin: t.coin,
            px: String(t.px),
            sz: String(t.sz),
            side: t.side,
            time: t.time,
            tid: t.tid,
          } as HyperOddTrade));
        if (incoming.length === 0) return; // sticky — keep last good
        setBucketTrades((prev) => {
          const tids = new Set(prev.map((t) => t.tid).filter((x): x is number => x != null));
          const fresh = incoming.filter((t) => t.tid == null || !tids.has(t.tid));
          if (!fresh.length) return prev;
          // Newest first, capped at 500 so the array doesn't grow
          // unbounded on long-running sessions.
          return [...fresh, ...prev]
            .sort((a, b) => b.time - a.time)
            .slice(0, 500);
        });
      } catch { /* ignore — sticky preserves last known */ }
    };
    fetchTrades();
    const id = setInterval(fetchTrades, 8000);
    return () => { cancelled = true; clearInterval(id); };
  }, [selectedBucket]);

  // probSeries for the chart — each candle's close is the YES probability
  // (0..1) at that timestamp, exactly like the binary's market candles.
  const probSeries = useMemo(() => {
    if (!selectedBucket) return [] as { x: number; p: number }[];
    return selectedBucket.candles
      .map((c) => ({ x: c.t, p: parseFloat(c.c) }))
      .filter((d) => Number.isFinite(d.p));
  }, [selectedBucket]);

  // Strike values for the chart's yellow dashed lines + y-axis fit:
  //   index 0      "Below X"  → primary line at X, no extra
  //   index last   "Above X"  → primary line at X, no extra
  //   else         "X – Y"    → primary at X (lower), extra line at Y (upper)
  const { primaryStrike, extraStrikes, rangeDesc } = useMemo(() => {
    if (!market || !selectedBucket) {
      return { primaryStrike: null as number | null, extraStrikes: [] as { value: number; label: string }[], rangeDesc: "" };
    }
    const idx = selectedBucket.index;
    const ts = market.thresholds;
    if (idx === 0) {
      return { primaryStrike: ts[0], extraStrikes: [], rangeDesc: `Below $${ts[0].toLocaleString()}` };
    }
    if (idx === ts.length) {
      return { primaryStrike: ts[ts.length - 1], extraStrikes: [], rangeDesc: `Above $${ts[ts.length - 1].toLocaleString()}` };
    }
    return {
      primaryStrike: ts[idx - 1],
      extraStrikes: [{ value: ts[idx], label: "upper" }],
      rangeDesc: `$${ts[idx - 1].toLocaleString()} – $${ts[idx].toLocaleString()}`,
    };
  }, [market, selectedBucket]);

  if (!market || market.buckets.length === 0) {
    return (
      <main className="max-w-[1440px] mx-auto px-4 py-8 text-center text-[12px]" style={{ color: "var(--hl-muted)" }}>
        Loading bucket market metadata…
      </main>
    );
  }

  const yesCents = selectedBucket?.yesPrice != null ? Math.round(selectedBucket.yesPrice * 100) : 0;
  const noCents = 100 - yesCents;
  // probSum lets the user sanity-check that all buckets are well-arbed
  // (should sum to ~$1.00 since exactly one bucket MUST hit at expiry).
  const probSum = market.buckets.reduce((s, b) => s + (b.yesPrice ?? 0), 0);

  return (
    <>
      {/* Header strip — picker + stats row, mirrors the binary's market strip */}
      <div className="max-w-[1440px] mx-auto px-4 py-3 border-b" style={{ borderColor: "var(--hl-border)" }}>
        <div className="flex items-center gap-3 mb-3 flex-wrap">
          <h1 className="text-[22px] font-bold tracking-tight leading-tight">
            BTC price range on {market.expiryMs ? new Date(market.expiryMs).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "expiry"}?
          </h1>
          <select
            value={selectedBucketIdx}
            onChange={(e) => setSelectedBucketIdx(parseInt(e.target.value, 10))}
            className="px-3 py-1.5 text-[13px] mono font-semibold"
            style={{
              background: "var(--hl-surface)",
              border: "1px solid var(--hl-accent)",
              color: "var(--hl-accent)",
              borderRadius: 3,
            }}
          >
            {market.buckets.map((b, idx) => {
              const cents = b.yesPrice != null ? Math.round(b.yesPrice * 100) : null;
              return (
                <option key={b.outcomeId} value={idx}>
                  {b.label}{cents != null ? `  ·  ${cents}% YES` : ""}
                </option>
              );
            })}
          </select>
        </div>

        <div className="flex items-stretch flex-wrap text-[13px]">
          <Stat label="YES" value={`${yesCents}¢`} cls="text-[var(--hl-green)]" />
          <Stat label="NO" value={`${noCents}¢`} cls="text-[var(--hl-red)]" />
          <Stat label="BTC mark" value={btcMark ? `$${btcMark.toLocaleString(undefined, { maximumFractionDigits: 1 })}` : "—"} cls="" />
          <Stat label="Range" value={rangeDesc || "—"} cls="" />
          <Stat label="Settles" value={fmtCountdown(market.expiryMs - now)} cls="text-[var(--hl-yellow)]" />
          <Stat
            label="Bucket sum"
            value={`${(probSum * 100).toFixed(0)}%`}
            cls={Math.abs(probSum - 1) > 0.05 ? "text-[var(--hl-yellow)]" : "text-[var(--hl-muted)]"}
          />
        </div>
      </div>

      {/* Main grid — chart left, order panel right (same as binary) */}
      <main className="max-w-[1440px] mx-auto px-4 py-3 grid gap-3" style={{ gridTemplateColumns: "1fr 320px", alignItems: "start" }}>
        <div className="grid gap-3" style={{ gridAutoRows: "min-content" }}>
          <RiverChart
            timeframe={timeframe}
            setTimeframe={setTimeframe}
            probSeries={probSeries}
            fairProbSeries={[] /* σ√t range-probability not modelled yet — empty */}
            btcCandles={btcCandles}
            marketCandles={selectedBucket?.candles ?? []}
            btcMark={btcMark}
            strike={primaryStrike}
            extraStrikes={extraStrikes}
            settleTs={settleTs}
            now={now}
            yesCents={yesCents}
            trades={bucketTrades}
            hip4Coin={selectedYesCoin}
            viewSide={tradeSide}
            onWhaleClick={setSelectedWhale}
            limitOrderCents={null}
            limitOrderSide={null}
            limitOrderTypedCents={null}
          />
        </div>

        {/* Order panel — anchored to the chosen bucket */}
        <div className="panel p-3 flex flex-col gap-2">
          <div className="flex items-center" style={{ borderBottom: "1px solid var(--hl-border)", paddingBottom: 8 }}>
            <span className="ptitle">Trade range</span>
            <span className="psub ml-auto mono">{selectedBucket?.yesCoin}/{selectedBucket?.noCoin}</span>
          </div>
          <div className="text-[11px]" style={{ color: "var(--hl-text)" }}>
            <b className="mono">{selectedBucket?.label}</b>{" "}
            <span style={{ color: "var(--hl-muted)" }}>· {yesCents}¢ YES · {noCents}¢ NO</span>
          </div>

          <div className="grid grid-cols-2 gap-2 mt-1">
            <button
              onClick={() => setTradeSide("yes")}
              className="py-2 text-[12px] mono font-semibold"
              style={{
                background: tradeSide === "yes" ? "rgba(74,222,128,0.15)" : "var(--hl-surface)",
                border: `1px solid ${tradeSide === "yes" ? "var(--hl-green)" : "var(--hl-border)"}`,
                color: tradeSide === "yes" ? "var(--hl-green)" : "var(--hl-muted)",
                borderRadius: 3,
              }}
            >
              YES
            </button>
            <button
              onClick={() => setTradeSide("no")}
              className="py-2 text-[12px] mono font-semibold"
              style={{
                background: tradeSide === "no" ? "rgba(248,113,113,0.15)" : "var(--hl-surface)",
                border: `1px solid ${tradeSide === "no" ? "var(--hl-red)" : "var(--hl-border)"}`,
                color: tradeSide === "no" ? "var(--hl-red)" : "var(--hl-muted)",
                borderRadius: 3,
              }}
            >
              NO
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setOrderType("market")}
              className="py-1.5 text-[11px] mono"
              style={{
                background: orderType === "market" ? "var(--hl-accent)" : "var(--hl-surface)",
                color: orderType === "market" ? "var(--background)" : "var(--hl-muted)",
                border: `1px solid ${orderType === "market" ? "var(--hl-accent)" : "var(--hl-border)"}`,
                borderRadius: 3,
              }}
            >
              Market
            </button>
            <button
              onClick={() => setOrderType("limit")}
              className="py-1.5 text-[11px] mono"
              style={{
                background: orderType === "limit" ? "var(--hl-accent)" : "var(--hl-surface)",
                color: orderType === "limit" ? "var(--background)" : "var(--hl-muted)",
                border: `1px solid ${orderType === "limit" ? "var(--hl-accent)" : "var(--hl-border)"}`,
                borderRadius: 3,
              }}
            >
              Limit
            </button>
          </div>

          {/* Wallet context — Available-to-Trade + Current-Position rows,
              same shape as the binary TradePanel. Position is whichever
              side (YES/NO) the user is currently buying for this bucket. */}
          <div
            className="flex flex-col text-[11px]"
            style={{ background: "var(--background)", border: "1px solid var(--hl-border)", borderRadius: 3 }}
          >
            <div className="flex items-center justify-between px-2 py-1">
              <span style={{ color: "var(--hl-muted)" }}>Available to Trade</span>
              <span className="mono">
                {usdhBalance == null
                  ? "—"
                  : `${usdhBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDH`}
              </span>
            </div>
            <div className="flex items-center justify-between px-2 py-1" style={{ borderTop: "1px solid var(--hl-border)" }}>
              <span style={{ color: "var(--hl-muted)" }}>Current Position</span>
              <span className="mono">
                {(() => {
                  if (!selectedBucket) return "0";
                  const coin = tradeSide === "yes" ? selectedBucket.yesCoin : selectedBucket.noCoin;
                  const pos = hip4Positions.get(coin) ?? 0;
                  const label = tradeSide === "yes" ? "YES" : "NO";
                  if (!pos) return `0 ${label} shares`;
                  return `${pos.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${label} shares`;
                })()}
              </span>
            </div>
          </div>

          <label className="text-[10px]" style={{ color: "var(--hl-muted)" }}>Stake (USD)</label>
          <input
            type="number"
            value={stake}
            onChange={(e) => setStake(e.target.value)}
            className="mono text-[14px] px-2 py-1.5"
            style={{ background: "var(--background)", border: "1px solid var(--hl-border)", color: "var(--foreground)", borderRadius: 3 }}
          />

          {orderType === "limit" && (
            <>
              <label className="text-[10px]" style={{ color: "var(--hl-muted)" }}>Limit price (¢)</label>
              <input
                type="number"
                value={limitPx}
                onChange={(e) => setLimitPx(e.target.value)}
                placeholder="0-100"
                className="mono text-[14px] px-2 py-1.5"
                style={{ background: "var(--background)", border: "1px solid var(--hl-border)", color: "var(--foreground)", borderRadius: 3 }}
              />
            </>
          )}

          {(() => {
            const yesPx = selectedBucket?.yesPrice ?? 0;
            const sidePx = tradeSide === "yes" ? yesPx : 1 - yesPx;
            const usd = parseFloat(stake) || 0;
            const shares = sidePx > 0 ? Math.floor(usd / sidePx) : 0;
            return (
              <div className="text-[10px] mt-1" style={{ color: "var(--hl-muted)" }}>
                ≈ <b className="mono">{shares.toLocaleString()}</b> shares · payout if {tradeSide.toUpperCase()} wins:{" "}
                <b className="mono" style={{ color: "var(--hl-green)" }}>${shares.toLocaleString()}</b>
              </div>
            );
          })()}

          <button
            disabled={!isConnected || orderStatus.kind === "pending" || parseFloat(stake) <= 0 || !selectedBucket}
            onClick={async () => {
              if (!isConnected || !address || !selectedBucket) {
                setOrderStatus({ kind: "error", message: "Connect wallet first" });
                return;
              }
              const asset = tradeSide === "yes" ? selectedBucket.yesCoin : selectedBucket.noCoin;
              const yesPx = selectedBucket.yesPrice;
              const sidePx = yesPx != null ? (tradeSide === "yes" ? yesPx : 1 - yesPx) : null;
              if (sidePx == null || sidePx <= 0) {
                setOrderStatus({ kind: "error", message: "Side price unavailable" });
                return;
              }
              const usd = parseFloat(stake);
              const shares = Math.max(1, Math.floor(usd / sidePx));
              const lpx = parseFloat(limitPx);
              const limitPrice = orderType === "limit" && Number.isFinite(lpx) && lpx > 0 ? lpx / 100 : undefined;

              setOrderStatus({ kind: "pending" });
              try {
                const [wagmiCore, exchange, wagmiConfig] = await Promise.all([
                  import("@wagmi/core"),
                  import("@/lib/hl-exchange"),
                  import("@/config/wagmi"),
                ]);
                const walletClient = await wagmiCore.getWalletClient(wagmiConfig.config);
                if (!walletClient) throw new Error("Wallet client not available");
                const agentResult = await exchange.ensureAgent(walletClient, address as `0x${string}`);
                if (agentResult.error || !agentResult.agentKey) throw new Error(agentResult.error || "Agent setup failed");
                const builderApproved = await exchange.checkBuilderApproval(address as string);
                if (!builderApproved) {
                  const approval = await exchange.approveBuilderFee(walletClient, address as `0x${string}`);
                  if (!approval.success) throw new Error(approval.error || "Builder fee approval failed");
                }
                const res = await exchange.placeOrder(agentResult.agentKey, address as `0x${string}`, {
                  asset,
                  isBuy: true,
                  size: shares,
                  orderType,
                  limitPrice,
                  slippageBps: orderType === "market" ? 200 : undefined,
                });
                if (res.success) {
                  setOrderStatus({ kind: "success", message: `Filled ${res.filledSize ?? "?"} @ ${res.avgPrice ?? "?"}¢` });
                } else {
                  setOrderStatus({ kind: "error", message: res.error ?? "Order failed" });
                }
              } catch (err) {
                setOrderStatus({ kind: "error", message: err instanceof Error ? err.message : "Order threw" });
              }
            }}
            className="py-2 text-[12px] mono font-bold mt-1"
            style={{
              background: tradeSide === "yes" ? "var(--hl-green)" : "var(--hl-red)",
              color: "var(--background)",
              borderRadius: 3,
              opacity: !isConnected || orderStatus.kind === "pending" || parseFloat(stake) <= 0 ? 0.4 : 1,
            }}
          >
            {orderStatus.kind === "pending"
              ? "Placing…"
              : isConnected
                ? `${orderType === "market" ? "Buy" : "Place limit"} ${tradeSide.toUpperCase()} · ${selectedBucket?.label}`
                : "Connect wallet"}
          </button>

          {orderStatus.kind === "success" && (
            <div className="text-[10px] mono" style={{ color: "var(--hl-green)" }}>{orderStatus.message}</div>
          )}
          {orderStatus.kind === "error" && (
            <div className="text-[10px] mono" style={{ color: "var(--hl-red)" }}>{orderStatus.message}</div>
          )}
        </div>
      </main>

      {/* Whale details modal — driven by local state since the parent's
          modal is binary-scoped. Same shape as the binary's whale modal. */}
      {selectedWhale && (() => {
        const w = selectedWhale;
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
            onClick={() => setSelectedWhale(null)}
          >
            <div
              className="max-w-[440px] w-full p-5 text-[12px] leading-relaxed"
              style={{ background: "var(--hl-surface)", border: "1px solid var(--hl-border)", color: "var(--foreground)" }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-baseline mb-3">
                <h2 className="text-[16px] font-bold tracking-tight">🐋 Whale fill</h2>
                <button onClick={() => setSelectedWhale(null)} className="ml-auto text-[20px] leading-none">×</button>
              </div>
              <div className="grid gap-2">
                <BucketWhaleRow label="Side" value={`${(w.side === "B" || w.side === "buy") ? "BUY" : "SELL"} ${w.sideContext.toUpperCase()}`} />
                <BucketWhaleRow label="Price" value={`${(w.px * 100).toFixed(2)}¢`} />
                <BucketWhaleRow label="Notional" value={`$${w.usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
                <BucketWhaleRow label="Trade count" value={`${w.count}`} />
                <BucketWhaleRow label="When" value={new Date(w.time).toLocaleString()} />
              </div>
            </div>
          </div>
        );
      })()}
    </>
  );
}

function BucketWhaleRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-[11px]">
      <span style={{ color: "var(--hl-muted)" }}>{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}
