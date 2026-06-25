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
  // Open vs close: "buy" places a new YES/NO position; "sell" closes the
  // user's existing position on the selected side back to USDH. HL HIP-4
  // outcome shares are spot tokens, so sells = placeOrder(isBuy: false)
  // on the same coin — no special "close" call required.
  const [direction, setDirectionRaw] = useState<"buy" | "sell">("buy");
  // Wrap setDirection so toggling between buy/sell resets the stake
  // field to a sensible default for that mode. Without this, a user
  // who typed "250" (USDH) and then hits SELL would have the field
  // interpreted as "sell 250 shares" which is almost certainly not
  // what they meant.
  const setDirection = (d: "buy" | "sell") => {
    setDirectionRaw(d);
    if (d === "buy") {
      setStake("250");
    } else {
      // Default to selling the user's full position on the active side.
      const yesPos = hyperodd.hip4Coin ? hip4Positions.get(hyperodd.hip4Coin) ?? 0 : 0;
      const noPos = hyperodd.hip4Coin ? hip4Positions.get(`#${hyperodd.hip4Coin.slice(1, -1)}1`) ?? 0 : 0;
      const pos = side === "yes" ? yesPos : noPos;
      setStake(Math.floor(pos).toString());
    }
  };
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
  // Cost basis per HIP-4 coin, computed from the user's fill history.
  // For each "#NNN0" / "#NNN1" coin: total shares bought, total USDH
  // spent on those buys, total shares sold, total USDH received from
  // sells. Used in "Your Position" to show avg entry + profit math
  // (paid $X, value now $Y, profit if win = $Z).
  type CostBasisEntry = {
    totalBuyShares: number;
    totalBuyUsd: number;
    totalSellShares: number;
    totalSellUsd: number;
  };
  const [hip4CostBasis, setHip4CostBasis] = useState<Map<string, CostBasisEntry>>(new Map());
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
        // Only spotClearinghouseState is needed now. HL stores HIP-4
        // outcome positions in spot balances using the "+<outcome><side>"
        // coin format (e.g. "+700" = outcome 70, side 0 = YES). The
        // previous code looked in clearinghouseState.assetPositions for
        // "#NNN[01]" patterns — that scan returned 0 every time because
        // HIP-4 positions never appear there. Hence "Your Position" said
        // "No position" right after a successful fill.
        const spotRes = await fetch(HL_INFO, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "spotClearinghouseState", user: address }),
        });
        if (cancelled) return;
        if (!spotRes.ok) return;
        const data = (await spotRes.json()) as { balances?: { coin: string; total: string }[] };
        const balances = data?.balances;
        if (balances == null) return;

        // USDH wallet balance (drives the LIVE banner USDH pill / order
        // panel "Available to Trade").
        const usdh = balances.find((b) => b.coin === "USDH");
        const v = usdh ? parseFloat(usdh.total) : 0;
        if (v > 0 || !hadUsdh) {
          setUsdhBalance(v);
          if (v > 0) hadUsdh = true;
        }

        // HIP-4 outcome holdings. Coin pattern in balances is
        // "+<outcome><side>", e.g. "+700". Translate to the page's
        // canonical "#<outcome><side>" so the rest of the page (chart,
        // order panel, position widget) can use a single key format.
        const map = new Map<string, number>();
        for (const b of balances) {
          if (!b.coin || !/^\+\d+[01]$/.test(b.coin)) continue;
          const sz = parseFloat(b.total);
          if (!Number.isFinite(sz) || sz === 0) continue;
          // "+700" → "#700"
          const canonical = "#" + b.coin.slice(1);
          map.set(canonical, sz);
        }
        if (map.size > 0 || !hadPositions) {
          setHip4Positions(map);
          if (map.size > 0) hadPositions = true;
        }
      } catch { /* ignore — sticky preserves last-known-good */ }
    };
    fetchBalances();
    const id = setInterval(fetchBalances, 15_000);
    // Instant refetch when a HIP-4 trade fills — no 15s wait. The order
    // panels dispatch this CustomEvent on success; without the listener
    // the user's "Your Position" panel still said "No position" for up
    // to 15s after a fill, which looked broken (or like the order
    // didn't go through).
    const onFill = () => {
      // Small delay to let HL's API reflect the position change.
      setTimeout(fetchBalances, 400);
      // Second fetch covers any propagation lag.
      setTimeout(fetchBalances, 2_000);
    };
    window.addEventListener("hlone:trade-filled", onFill);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener("hlone:trade-filled", onFill);
    };
  }, [address]);

  // Fetch the user's fill history and compute cost basis for every
  // HIP-4 outcome coin they've traded. This drives the profit math in
  // "Your Position" (paid $X, value now $Y, profit if win = +$Z).
  //
  // Why fills and not the spot-balance entryNtl: HL's spot balances
  // don't include an entry-notional field for HIP-4 outcomes, so the
  // only source of truth for "what did the user actually pay" is the
  // fills endpoint. 7-day lookback is plenty since HIP-4 markets
  // roll daily — anything older is settled.
  useEffect(() => {
    if (!address) {
      setHip4CostBasis(new Map());
      return;
    }
    let cancelled = false;
    let hadFills = false;
    const fetchCostBasis = async () => {
      try {
        const res = await fetch(HL_INFO, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "userFillsByTime",
            user: address,
            startTime: Date.now() - 7 * 24 * 60 * 60 * 1000,
            endTime: Date.now(),
          }),
        });
        if (cancelled || !res.ok) return;
        const fills = (await res.json()) as Array<{
          coin: string;
          side: "B" | "A";
          px: string;
          sz: string;
          fee?: string;
        }>;
        if (!Array.isArray(fills)) return;

        // Aggregate buys/sells per HIP-4 coin. Filter to outcome
        // shares only (#NNN0 / #NNN1) — perp / spot fills are
        // tracked elsewhere.
        const byCoin = new Map<string, CostBasisEntry>();
        for (const f of fills) {
          if (!f.coin || !/^#\d+[01]$/.test(f.coin)) continue;
          const px = parseFloat(f.px);
          const sz = parseFloat(f.sz);
          if (!Number.isFinite(px) || !Number.isFinite(sz) || sz <= 0) continue;
          const usd = px * sz;
          let entry = byCoin.get(f.coin);
          if (!entry) {
            entry = { totalBuyShares: 0, totalBuyUsd: 0, totalSellShares: 0, totalSellUsd: 0 };
            byCoin.set(f.coin, entry);
          }
          if (f.side === "B") {
            entry.totalBuyShares += sz;
            entry.totalBuyUsd += usd;
          } else {
            entry.totalSellShares += sz;
            entry.totalSellUsd += usd;
          }
        }
        // Sticky guard — if we've seen real data before, don't blow
        // it away on a transient empty response.
        if (byCoin.size > 0 || !hadFills) {
          setHip4CostBasis(byCoin);
          if (byCoin.size > 0) hadFills = true;
        }
      } catch { /* ignore — sticky preserves last-known-good */ }
    };
    fetchCostBasis();
    const id = setInterval(fetchCostBasis, 30_000);
    const onFill = () => {
      // Same dual-fetch as the balance handler: fast first attempt,
      // then a slower fallback to catch HL API propagation lag.
      setTimeout(fetchCostBasis, 600);
      setTimeout(fetchCostBasis, 3_000);
    };
    window.addEventListener("hlone:trade-filled", onFill);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener("hlone:trade-filled", onFill);
    };
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
            .slice(0, 2500);
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
        // Initial-fetch limit decoupled from the in-memory cap (2500
        // in setHyperodd below). Pulling 2500 trades on every poll was
        // ~460 KB per request and slowed initial chart load notably on
        // mobile. 1000 trades (~180 KB) covers ~1h on an active market
        // — enough for whales to spread across the 1H view immediately.
        // The buffer fills up to 2500 over time as WS adds new trades
        // and 10s polls top it up, so 6H + early 24H views still get
        // their whale coverage within a minute or two of page load.
        const res = await fetch(`/api/market/predict-trades?limit=1000`);
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
            .slice(0, 2500);
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
                  // Newest first, capped at 2500 (was 500 — same reason
                  // as the REST fetch: chart whales need enough history
                  // to spread across the visible window).
                  const merged = [...newOnes, ...s.trades].slice(0, 2500);
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

  // Submit handler for the binary YES/NO order. Extracted so both the
  // desktop TradePanel and the mobile sticky bottom CTA can call the
  // same code path with the same state (direction / side / stake /
  // orderType / limitPx all live here on PredictPage).
  //
  // BUY: stake field is USDH the user wants to risk; we compute shares
  //      via floor(USDH / side_price) and round UP if it falls below
  //      HL's $10 minimum-notional floor.
  // SELL: stake field is the number of shares the user wants to sell
  //       from their existing position. No min-notional rounding —
  //       you can only sell what you hold, and HL accepts partial
  //       fills against the resting bid.
  const handleBinarySubmit = async () => {
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

    // Pre-flight share + notional sanity checks. Done before MetaMask
    // popup so the user gets a fast inline error instead of a wallet
    // confirmation that then fails.
    let finalSize: number;
    if (direction === "buy") {
      // HL enforces a $10 USDH minimum order value on HIP-4. Round UP.
      const MIN_NOTIONAL_USDH = 10;
      const naiveShares = Math.max(1, Math.floor(shares));
      const fillPxFraction = side === "yes" ? effectiveYesPx : 1 - effectiveYesPx;
      const minSharesForMinimum = fillPxFraction > 0
        ? Math.ceil(MIN_NOTIONAL_USDH / fillPxFraction)
        : naiveShares;
      finalSize = Math.max(naiveShares, minSharesForMinimum);
    } else {
      // SELL: stake field holds the share count directly. Clamp to the
      // position the user actually owns (you can't oversell).
      const yesPos = hyperodd.hip4Coin ? hip4Positions.get(hyperodd.hip4Coin) ?? 0 : 0;
      const noPos = hyperodd.hip4Coin ? hip4Positions.get(`#${hyperodd.hip4Coin.slice(1, -1)}1`) ?? 0 : 0;
      const positionOnSide = side === "yes" ? yesPos : noPos;
      const requested = Math.floor(parseFloat(stake) || 0);
      finalSize = Math.min(requested, Math.floor(positionOnSide));
      if (finalSize <= 0) {
        setOrderStatus({
          kind: "error",
          message: positionOnSide <= 0
            ? `No ${side.toUpperCase()} shares to sell`
            : "Enter a share count > 0",
        });
        return;
      }
    }

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
          isBuy: direction === "buy",
          size: finalSize,
          orderType,
          limitPrice,
          slippageBps: orderType === "market" ? 200 : undefined,
        },
      );
      if (res.success) {
        setOrderStatus({
          kind: "success",
          message: `${direction === "buy" ? "Bought" : "Sold"} ${res.filledSize ?? "?"} @ ${res.avgPrice ?? "?"}¢`,
        });
        // Tell the position-balance fetcher to refresh NOW
        // instead of waiting up to 15s for the next poll —
        // so "Your Position" reflects the fill immediately.
        window.dispatchEvent(new CustomEvent("hlone:trade-filled"));
      } else {
        setOrderStatus({ kind: "error", message: res.error ?? "Order failed" });
      }
    } catch (err) {
      setOrderStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Order threw",
      });
    }
  };

  // ─── render ────────────────────────────────────────────────────────────
  return (
    <div className="predict-root min-h-screen text-[var(--foreground)]" style={{ background: "var(--background)" }}>
      <style jsx>{`
        /* Type scale — single source of truth so mobile fonts read like an
           app instead of a pile of 9/10/11/12/13/14px ad-hoc values.
              caption  — uppercase labels, metadata
              micro    — denser secondary metadata (timestamps, sub-labels)
              body     — paragraph + summary rows
              input    — form inputs (≥16px so iOS doesn't auto-zoom on focus)
              num      — primary numeric readouts
              num-lg   — hero numbers (YES/NO cents, market %)
              title    — page H1 (mobile)
              title-lg — page H1 (desktop)
        */
        .predict-root {
          --t-caption: 11px;
          --t-micro: 10px;
          --t-body: 13px;
          --t-input: 16px;
          --t-num: 15px;
          --t-num-lg: 18px;
          --t-title: 20px;
          --t-title-lg: 28px;
        }
        .panel {
          background: var(--hl-surface);
          border: 1px solid var(--hl-border);
          border-radius: 6px;
        }
        .ptitle { font-size: var(--t-caption); font-weight: 600; color: var(--hl-accent); text-transform: uppercase; letter-spacing: 0.6px; }
        .psub { font-size: var(--t-micro); color: var(--hl-muted); }
        .cellL { font-size: var(--t-micro); color: var(--hl-muted); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
        .mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-variant-numeric: tabular-nums; }
        .badge-c { padding: 2px 7px; border-radius: 3px; font-size: var(--t-micro); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; background: rgba(0,240,255,0.08); color: var(--hl-accent); }
        .badge-l { padding: 2px 7px; border-radius: 3px; font-size: var(--t-micro); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; background: rgba(248,113,113,0.1); color: var(--hl-red); }
        .badge-l::before { content: "● "; }
        .badge-d { padding: 2px 7px; border-radius: 3px; font-size: var(--t-micro); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; background: rgba(245,165,36,0.12); color: var(--hl-yellow); }
        /* App-like field row: consistent padding, rounded corners,
           subtle inner bg so multi-row stacks (Available / Position /
           Size) read as a single grouped control. */
        .field-row {
          background: var(--background);
          border: 1px solid var(--hl-border);
          border-radius: 5px;
        }
        /* (predict-chip-anchor CSS variable removed — chip gutter is
           now hardcoded inline in RiverChart since the styled-jsx
           scope didn't reach across components.) */
        /* Number/value emphasis used inside the order summary so it
           pops vs the label. */
        .v-num { font-size: var(--t-num); font-weight: 600; }
        .v-num-lg { font-size: var(--t-num-lg); font-weight: 700; }
        @keyframes expiry-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.55; }
        }
        .expiry-pulse { animation: expiry-pulse 1.2s ease-in-out infinite; }
      `}</style>

      {/* Sticky context header — LIVE banner + tab strip pin to the top
          on mobile so the user always knows which market they're in while
          scrolling the chart / order flow. Desktop keeps the same look
          but doesn't need sticky (the chart + order panel are side by
          side, both visible without scrolling). */}
      <div
        className="md:static sticky top-0 z-20"
        style={{ background: "var(--background)" }}
      >
        {/* LIVE banner — DESKTOP ONLY. Hidden on mobile because it
            duplicated context the user already has (the page IS the
            HIP-4 market, the chart shows "live" by definition, and
            the ws-status indicator was noise). */}
        <div
          className="hidden md:flex max-w-[1440px] mx-auto px-4 py-1.5 items-center gap-3"
          style={{
            background: "rgba(74,222,128,0.06)",
            borderBottom: "1px solid rgba(74,222,128,0.2)",
            fontSize: "var(--t-micro)",
          }}
        >
          <span
            className="mono font-bold flex items-center gap-2"
            style={{ color: "var(--hl-green)", letterSpacing: 0.6 }}
          >
            <span>● LIVE · HIP-4 MAINNET</span>
            <code className="mono" style={{ color: "var(--hl-accent)", letterSpacing: 0 }}>
              {activeMarket === "binary"
                ? (hyperodd.hip4Coin ?? "loading…")
                : `Q${bucketMarket?.questionId ?? "…"}`}
            </code>
          </span>

          <span
            className="ml-auto mono"
            style={{ color: hyperodd.wsConnected ? "var(--hl-green)" : "var(--hl-muted)" }}
          >
            {hyperodd.wsConnected ? "● ws live" : "○ ws connecting…"}
          </span>
        </div>

        {/* Market-selector tabs — desktop only. On mobile the bucket
            market is reachable from the desktop view; the tab strip
            was eating ~32px of viewport without adding value to the
            mobile single-market flow. */}
        <div
          className="hidden md:flex max-w-[1440px] mx-auto px-4 items-center gap-2 overflow-x-auto whitespace-nowrap"
          style={{
            borderBottom: "1px solid var(--hl-border)",
            background: "var(--background)",
            fontSize: "var(--t-body)",
          }}
        >
        <button
          onClick={() => setActiveMarket("binary")}
          className="px-3 py-1.5 mono font-semibold flex-shrink-0"
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
          className="px-3 py-1.5 mono font-semibold flex-shrink-0"
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
            {/* Long explanatory body hidden below sm so mobile doesn't
                spread the banner over 4-5 lines. Full text restored at
                sm+ where there's room. */}
            <span className="hidden sm:inline">
              {expiryTier === "imminent"
                ? " Expect pin risk and rapid YES/NO whipsaws as BTC oscillates around the strike. σ-implied prob is no longer meaningful — trust the live order book and recent trades only."
                : " The σ-implied probability becomes unreliable as time decays — use the live HIP-4 mark, not the fair-value reference, for decision-making."}
            </span>
            {isPinRisk && (
              <span style={{ color: "var(--hl-red)", fontWeight: 600, marginLeft: 8 }}>
                BTC within {strikeProximityPct.toFixed(2)}% of strike — pin risk.
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

      {/* ── MOBILE HERO (md:hidden) ─────────────────────────────────────
          Tight, single-row hero. Question + context inline; one compact
          side-swap button on the right showing the active YES/NO + cents,
          tapping flips to the other. Massively reduces hero height vs the
          twin trade-card layout. */}
      <div className="md:hidden px-4 py-3 border-b" style={{ borderColor: "var(--hl-border)" }}>
        <div className="flex items-center gap-2">
          <h1
            className="font-bold tracking-tight leading-tight flex-1 min-w-0"
            style={{ fontSize: 18 }}
          >
            BTC &gt; ${strike?.toLocaleString() ?? "…"}?
          </h1>
          {/* Side-swap button — tap flips YES↔NO. The active side's
              colour fills the bg so it's visually obvious which side
              you're acting on. Compact (~32px tall) vs the previous
              ~70px twin cards. */}
          <button
            onClick={() => setSide(side === "yes" ? "no" : "yes")}
            className="flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 font-bold mono"
            style={{
              background: side === "yes" ? "rgba(74,222,128,0.16)" : "rgba(248,113,113,0.16)",
              border: `1px solid ${side === "yes" ? "var(--hl-green)" : "var(--hl-red)"}`,
              color: side === "yes" ? "var(--hl-green)" : "var(--hl-red)",
              borderRadius: 6,
              fontSize: "var(--t-body)",
              letterSpacing: 0.3,
            }}
            aria-label={`Switch to ${side === "yes" ? "NO" : "YES"}`}
          >
            <span>{side === "yes" ? "YES" : "NO"}</span>
            <span style={{ fontWeight: 700 }}>
              {side === "yes" ? yesCents : noCents}¢
            </span>
            <span style={{ opacity: 0.6, fontSize: 10, marginLeft: 1 }}>⇄</span>
          </button>
          <button
            onClick={() => setShowRules(true)}
            className="flex-shrink-0 px-1.5 py-1.5"
            style={{
              background: "transparent",
              border: "1px solid var(--hl-border)",
              color: "var(--hl-muted)",
              fontSize: "var(--t-micro)",
              borderRadius: 4,
              letterSpacing: 0.4,
            }}
            aria-label="Resolution rules"
          >
            ⓘ
          </button>
        </div>

        {/* BTC-price context line removed per user feedback — the
            chart's BTC line + orange endpoint chip already shows the
            same number. Countdown timer moved into the chart header. */}
      </div>

      {/* ── DESKTOP MARKET STRIP (hidden on mobile) ───────────────────── */}
      <div
        className="hidden md:block max-w-[1440px] mx-auto px-4 py-3 border-b"
        style={{ borderColor: "var(--hl-border)" }}
      >
        <div className="flex items-center gap-4 mb-3 flex-wrap">
          <h1
            className="font-bold tracking-tight leading-tight"
            style={{ fontSize: "var(--t-title-lg)" }}
          >
            Will BTC close above ${strike?.toLocaleString() ?? "…"} today?
          </h1>
          <div className="ml-auto flex gap-2">
            <button
              onClick={() => setShowRules(true)}
              className="px-3 py-1 rounded"
              style={{
                background: "var(--hl-surface)",
                border: "1px solid var(--hl-border)",
                color: "var(--hl-text)",
                fontSize: "var(--t-caption)",
              }}
            >
              Rules
            </button>
          </div>
        </div>

        {/* Desktop stat strip — horizontal scroll row. */}
        <div
          className="flex items-stretch overflow-x-auto whitespace-nowrap scrollbar-none"
          style={{ fontSize: "var(--t-body)" }}
        >
          <Stat label="YES" value={`${yesCents}¢`} cls="text-[var(--hl-green)]" />
          <Stat label="NO" value={`${noCents}¢`} cls="text-[var(--hl-red)]" />
          <Stat label="BTC mark" value={btcMark ? `$${btcMark.toLocaleString(undefined, { maximumFractionDigits: 1 })}` : "—"} cls="" />
          <Stat label="Strike" value={strike ? `$${strike.toLocaleString()}` : "—"} cls="" />
          <Stat label="Distance" value={btcMark ? `${distance >= 0 ? "+" : ""}$${Math.abs(distance).toFixed(0)} (${distancePct >= 0 ? "+" : ""}${distancePct.toFixed(2)}%)` : "—"} cls={distance < 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-yellow)]"} />
          <Stat label="Settles" value={fmtCountdown(settleTs - now)} cls="text-[var(--hl-yellow)]" />
        </div>

        {/* CompareStrip removed — its MARKET/THEORY/vs-theory content
            now lives inline in the chart header. Mark `compare` as
            void so the TS unused-import lint stays clean (it's still
            populated by /api/predict/compare for potential reuse). */}
        {void compare}
      </div>

      {/* main grid — single column on mobile (chart + order panel stack
          vertically), two columns (chart + sticky-width 320px order panel)
          at md+ as before. Tighter padding + gap on mobile to compress
          the dead space between panels. */}
      <main
        className="max-w-[1440px] mx-auto px-3 md:px-4 py-2 md:py-3 grid gap-2 md:gap-3 grid-cols-1 md:grid-cols-[1fr_320px]"
        style={{ alignItems: "start" }}
      >
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
            yesProb={yesProb}
            expiryTier={expiryTier}
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
          {/* Order book is hidden on mobile — it's a dense 3-column
              grid that crushes to unreadable at narrow widths AND
              pushes the actually-useful TradePanel ~540px down the
              page. Mirrors the perp page's pattern of hiding the
              order book below lg. */}
          <div className="hidden md:block">
            <LiveOrderBook hyperodd={hyperodd} fairCents={fairCents} now={now} viewSide={side} />
          </div>
        </div>

        <div className="flex flex-col gap-3 min-w-0">
          <TradePanel
            yesCents={yesCents}
            noCents={noCents}
            stake={stake}
            setStake={setStake}
            side={side}
            setSide={setSide}
            direction={direction}
            setDirection={setDirection}
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
            onSubmit={handleBinarySubmit}
          />
          {/* Your position panel — on MOBILE we only render it when
              the user actually holds shares (no empty-state filler);
              on desktop it always renders so the column doesn't
              visually collapse. */}
          {(() => {
            const yesCoinPanel = hyperodd.hip4Coin;
            const noCoinPanel = yesCoinPanel ? `#${yesCoinPanel.slice(1, -1)}1` : null;
            const yesSharesPanel = yesCoinPanel ? hip4Positions.get(yesCoinPanel) ?? 0 : 0;
            const noSharesPanel = noCoinPanel ? hip4Positions.get(noCoinPanel) ?? 0 : 0;
            const hasPos = yesSharesPanel > 0 || noSharesPanel > 0;
            return (
          <div className={`panel ${hasPos ? "" : "hidden md:block"}`}>
            <div
              className="px-3 py-2 flex items-center"
              style={{ borderBottom: "1px solid var(--hl-border)", height: 44, boxSizing: "border-box" as const }}
            >
              <span className="ptitle">Your position</span>
              <span className="psub ml-auto">on this market</span>
            </div>
            {(() => {
              // Read real positions for the active binary market from the
              // hip4Positions map (populated by the page-level
              // spotClearinghouseState + clearinghouseState poller). Was
              // previously a hard-coded "No position" placeholder that
              // never reflected reality even after a successful fill.
              const yesCoin = hyperodd.hip4Coin;
              const noCoin = yesCoin ? `#${yesCoin.slice(1, -1)}1` : null;
              const yesShares = yesCoin ? hip4Positions.get(yesCoin) ?? 0 : 0;
              const noShares = noCoin ? hip4Positions.get(noCoin) ?? 0 : 0;
              if (yesShares === 0 && noShares === 0) {
                return (
                  <div
                    className="p-3 text-center"
                    style={{ color: "var(--hl-muted)", fontSize: "var(--t-caption)" }}
                  >
                    No open position on this market.
                  </div>
                );
              }
              // Value-at-market: shares × current side price.
              const yesPx = hyperodd.mark ?? 0;
              const noPx = yesPx > 0 ? 1 - yesPx : 0;
              const yesVal = yesShares * yesPx;
              const noVal = noShares * noPx;
              // Payoff if YES settles: yesShares × $1 (NO shares lose).
              // Payoff if NO settles: noShares × $1 (YES shares lose).
              const ifYesWins = yesShares;
              const ifNoWins = noShares;

              // Cost basis from fill history. Weighted-average entry
              // assumes uniform per-share cost across the open
              // position — a perfectly accurate FIFO breakdown isn't
              // worth the complexity for daily-rolling markets where
              // most users open + close in one or two clicks.
              // Falls back to current-market value if we don't have
              // fill data yet (e.g. user just connected, fetcher
              // hasn't fired) so the panel still renders sensibly.
              const yesCb = yesCoin ? hip4CostBasis.get(yesCoin) : undefined;
              const noCb = noCoin ? hip4CostBasis.get(noCoin) : undefined;
              const yesAvgEntry = yesCb && yesCb.totalBuyShares > 0
                ? yesCb.totalBuyUsd / yesCb.totalBuyShares
                : null;
              const noAvgEntry = noCb && noCb.totalBuyShares > 0
                ? noCb.totalBuyUsd / noCb.totalBuyShares
                : null;
              const yesCostBasis = yesAvgEntry != null ? yesShares * yesAvgEntry : null;
              const noCostBasis = noAvgEntry != null ? noShares * noAvgEntry : null;
              // Unrealised P&L = current value − cost basis.
              const yesUnrealPnl = yesCostBasis != null ? yesVal - yesCostBasis : null;
              const noUnrealPnl = noCostBasis != null ? noVal - noCostBasis : null;
              // Net P&L per outcome:
              //   YES wins → YES shares pay $1 each, NO shares are worthless.
              //   profit = (yesShares - yesCostBasis) - noCostBasis
              //   (yesShares is also yesShares×$1, the full payout)
              //   NO wins is the mirror.
              const profitIfYesWins = (yesCb || noCb)
                ? (yesShares - (yesCostBasis ?? 0)) - (noCostBasis ?? 0)
                : null;
              const profitIfNoWins = (yesCb || noCb)
                ? (noShares - (noCostBasis ?? 0)) - (yesCostBasis ?? 0)
                : null;

              // One-tap shortcut: switch the order panel into SELL mode
              // for this side and scroll the panel into view so the user
              // can confirm the share count + tap Sell.
              const closeSide = (s: "yes" | "no", shares: number) => {
                setSide(s);
                setDirection("sell");
                setStake(Math.floor(shares).toString());
                // Scroll order panel into view (mobile UX).
                const root = document.querySelector(".predict-root");
                const panel = root?.querySelector(".panel");
                panel?.scrollIntoView({ behavior: "smooth", block: "center" });
              };

              // Helper: format a signed dollar number with colour.
              // Positive = green, negative = red, zero = muted.
              const fmtSigned = (n: number) => {
                const sign = n > 0 ? "+" : n < 0 ? "−" : "";
                return `${sign}$${Math.abs(n).toFixed(2)}`;
              };
              const colorForPnl = (n: number | null) =>
                n == null ? "var(--hl-muted)" : n > 0 ? "var(--hl-green)" : n < 0 ? "var(--hl-red)" : "var(--hl-muted)";

              return (
                <div className="p-3 flex flex-col gap-2.5" style={{ fontSize: "var(--t-caption)" }}>
                  {yesShares > 0 && (
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-2">
                        <span style={{ color: "var(--hl-green)" }}>
                          <b>{yesShares.toLocaleString()}</b> YES shares
                        </span>
                        <span className="flex items-center gap-2">
                          <span className="mono" style={{ color: "var(--hl-muted)" }}>
                            ≈ ${yesVal.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </span>
                          <button
                            onClick={() => closeSide("yes", yesShares)}
                            className="mono font-semibold px-2 py-0.5"
                            style={{
                              background: "transparent",
                              border: "1px solid var(--hl-green)",
                              color: "var(--hl-green)",
                              borderRadius: 4,
                              fontSize: "var(--t-micro)",
                              letterSpacing: 0.4,
                            }}
                          >
                            Close
                          </button>
                        </span>
                      </div>
                      {/* Cost-basis sub-line: avg entry, paid, and
                          unrealised P&L vs current market. Only shows
                          when we have fill data — otherwise the panel
                          looks cluttered with em-dashes. */}
                      {yesAvgEntry != null && yesCostBasis != null && (
                        <div className="flex items-center justify-between" style={{ color: "var(--hl-muted)", fontSize: "var(--t-micro)" }}>
                          <span>
                            Avg {(yesAvgEntry * 100).toFixed(1)}¢ · paid ${yesCostBasis.toFixed(2)}
                          </span>
                          <span className="mono" style={{ color: colorForPnl(yesUnrealPnl) }}>
                            {fmtSigned(yesUnrealPnl ?? 0)} now
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                  {noShares > 0 && (
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-2">
                        <span style={{ color: "var(--hl-red)" }}>
                          <b>{noShares.toLocaleString()}</b> NO shares
                        </span>
                        <span className="flex items-center gap-2">
                          <span className="mono" style={{ color: "var(--hl-muted)" }}>
                            ≈ ${noVal.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </span>
                          <button
                            onClick={() => closeSide("no", noShares)}
                            className="mono font-semibold px-2 py-0.5"
                            style={{
                              background: "transparent",
                              border: "1px solid var(--hl-red)",
                              color: "var(--hl-red)",
                              borderRadius: 4,
                              fontSize: "var(--t-micro)",
                              letterSpacing: 0.4,
                            }}
                          >
                            Close
                          </button>
                        </span>
                      </div>
                      {noAvgEntry != null && noCostBasis != null && (
                        <div className="flex items-center justify-between" style={{ color: "var(--hl-muted)", fontSize: "var(--t-micro)" }}>
                          <span>
                            Avg {(noAvgEntry * 100).toFixed(1)}¢ · paid ${noCostBasis.toFixed(2)}
                          </span>
                          <span className="mono" style={{ color: colorForPnl(noUnrealPnl) }}>
                            {fmtSigned(noUnrealPnl ?? 0)} now
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                  {/* Settle scenarios. With cost basis available, we
                      show the NET P&L (payout − total cost) so the user
                      sees "+$X profit" / "−$Y loss" instead of just the
                      gross payout. Without cost basis, we fall back to
                      the old gross-payout view. */}
                  <div
                    className="mt-0.5 pt-2 flex flex-col gap-1"
                    style={{ borderTop: "1px solid var(--hl-border)" }}
                  >
                    <div className="flex items-center justify-between" style={{ color: "var(--hl-muted)" }}>
                      <span>If YES wins</span>
                      {profitIfYesWins != null ? (
                        <span className="mono font-semibold" style={{ color: colorForPnl(profitIfYesWins) }}>
                          {fmtSigned(profitIfYesWins)}
                        </span>
                      ) : (
                        <span className="mono font-semibold" style={{ color: "var(--hl-green)" }}>
                          ${ifYesWins.toLocaleString()}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center justify-between" style={{ color: "var(--hl-muted)" }}>
                      <span>If NO wins</span>
                      {profitIfNoWins != null ? (
                        <span className="mono font-semibold" style={{ color: colorForPnl(profitIfNoWins) }}>
                          {fmtSigned(profitIfNoWins)}
                        </span>
                      ) : (
                        <span className="mono font-semibold" style={{ color: "var(--hl-red)" }}>
                          ${ifNoWins.toLocaleString()}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
            );
          })()}
          {/* Disclosure panel removed — the LIVE banner up top covers
              the essential context. */}
        </div>
      </main>

      {/* Sticky mobile Buy/Sell CTA was removed — user prefers buying
          via the in-flow TradePanel below the chart rather than a
          floating bar. Saved ~140px of viewport. */}
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
          hip4CostBasis={hip4CostBasis}
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
// GapChip removed — was used by the Kalshi/Polymarket cells in the
// cross-venue strip, both of which were dropped when the strip was
// simplified to just MARKET / THEORY / gap.

function Stat({ label, value, cls }: { label: string; value: string; cls: string }) {
  // On mobile (3-col grid) each chip is a self-contained cell with no
  // vertical dividers; rows get a subtle bottom border so the two rows
  // visually attach. On md+ we revert to the horizontal flex-strip
  // layout with right-side dividers (matches the perp page).
  return (
    <div
      className="py-1.5 md:py-0 px-2 md:px-3 md:border-r md:last:border-r-0 md:first:pl-0 md:flex-shrink-0"
      style={{ borderColor: "var(--hl-border)" }}
    >
      <div className="cellL">{label}</div>
      <div
        className={`mono font-semibold ${cls}`}
        style={{ fontSize: "var(--t-num)" }}
      >
        {value}
      </div>
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
  yesProb,
  expiryTier,
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
  // σ√t theory probability (0..1) — used by the desktop header to show
  // the MARKET / THEORY / vs-theory pricing inline (was a separate
  // CompareStrip card; user wanted it folded into the chart header).
  yesProb: number;
  // Drives the "strikethrough THEORY when σ√t collapses" affordance.
  expiryTier: "none" | "soon" | "imminent";
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

  // X-axis spans the contract's lifetime, but the *visible window* is
  // sized to the data we actually have so a brand-new market doesn't
  // render as a 30-pixel strip on the left edge of an otherwise empty
  // canvas (the failure mode the user reported on 24H view during the
  // first 30min of a fresh contract).
  //
  // 24H: starts at contractOpen. Right edge stretches as data accrues:
  //      tMax = contractOpen + max(1h, 2 × elapsed), capped at settleTs.
  //      → 30min in: 1h window (data fills 50% of canvas).
  //      → 6h  in: 12h window (data fills 50%).
  //      → 12h in: full session (data fills 50%+, settle line visible).
  //   This keeps the "open → settle" mental model while making the data
  //   actually readable from minute one.
  // 1H / 6H: last N hours ending at NOW, clamped to contractOpen so it
  //   never asks for pre-contract data.
  const contractOpen = settleTs - 24 * 60 * 60 * 1000;
  const nowSafe = now > 0 ? now : Date.now();
  const elapsed = Math.max(0, nowSafe - contractOpen);
  const tMin =
    timeframe === "24H"
      ? contractOpen
      : Math.max(contractOpen, nowSafe - tfParams(timeframe).lookbackMs);
  const tMax =
    timeframe === "24H"
      ? Math.min(
          settleTs,
          // Min 1h window so a fresh contract still has SOME readable
          // canvas; otherwise scales to keep data at ~50% of the width.
          contractOpen + Math.max(60 * 60 * 1000, elapsed * 2),
        )
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

    // Helper: convert a trade timestamp to an x pixel position.
    // Clamped to the LATER of:
    //   - the last market-candle time (= where the YES probability
    //     line actually ends — candles fetch every 60s but a single
    //     candle covers up to 15min, so the line lags real-time)
    //   - we never push past nowSafe regardless
    // Without this, the line could end at 11:15 (last 15-min candle)
    // and a whale at 11:25 (just-fired trade) would render to the
    // RIGHT of the line endpoint — visually placing the whale in the
    // 'future' empty zone of the chart, which is the user-reported
    // bug. Now the whale tucks up against the line endpoint instead.
    const lastLineTime = marketCandles.length > 0
      ? marketCandles[marketCandles.length - 1].t
      : nowSafe;
    const ceiling = Math.min(nowSafe, lastLineTime);
    const xForBucketCenter = (bucketCenter: number) => {
      const t = Math.min(bucketCenter, ceiling);
      return ((t - tMin) / (tMax - tMin)) * W;
    };

    const raw: Whale[] = [];
    for (const b of buckets.values()) {
      // X position based on the AVERAGE time of trades in this bucket
      // — not the bucket center. With 30-min buckets on 24H view, a
      // trade at 09:32 and another at 09:34 share the same bucket;
      // using the bucket centre (09:45) put both whales 11+ minutes
      // RIGHT of where they actually happened, which the user noticed
      // as 'whales all clustered to the right of where the price
      // moved'. Avg-time anchors the whale to roughly where the
      // trade(s) actually fired in time.
      const avgTime = b.tSum / b.count;
      if (avgTime < tMin) continue;
      const px = b.pxSum / b.count;
      raw.push({
        x: xForBucketCenter(avgTime),
        y: 0,           // filled in by the placement loop below
        usd: b.usd,
        px,
        side: b.side,
        isYes: b.isYes,
        count: b.count,
        time: avgTime,
        bucketIdx: b.bucketIdx,
      });
    }

    // Candle-volume fallback removed. Used to synthesise whale icons
    // from candle direction when the WS-trade buffer was empty (e.g.
    // after an API restart, since HL has no historical-trades endpoint
    // for HIP-4). User pushback: synthesised whales looked like real
    // fills and the inference (close ≥ open → YES buy) is a guess, not
    // truth. Nothing is better than approximated noise — when there's
    // no real fill data, the chart simply shows no whales.

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

    // Whales stack in the top SPACER above the chart (negative y), so
    // they don't cover price lines. Each whale's x already encodes the
    // trade time (via xForBucketCenter on b.tSum / b.count above).
    // Within a single bucket, multiple whales (e.g. BUY + SELL) stack
    // vertically — biggest USD closest to the chart top edge.
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
    // min-h compressed on mobile (320px) so the chart doesn't dominate
    // the viewport. Desktop keeps the original ~540px so the canvas has
    // breathing room.
    <div className="panel min-h-[320px] md:min-h-[540px]" style={{ overflow: "hidden" }}>
      {/* Chart header.
          Desktop: "Probability river · live · BTC mark vs strike" caption
            + timeframe pills.
          Mobile: kills the caption entirely (was cramped and useless).
            Left side carries the live market % so the user gets the
            "what's the bet trading at right now" number without leaving
            the chart panel — same row position as the Order entry
            panel's bid/ask info, which keeps the visual rhythm
            consistent down the page. */}
      <div
        className="px-3 py-2 flex items-center gap-2"
        style={{
          borderBottom: "1px solid var(--hl-border)",
          // Lock the header height so it aligns with the Order Entry
          // panel header beside it (which has the same min-h). Without
          // this the chart header was a few px taller because its
          // values use 15px text while Order Entry uses 11px ptitle.
          height: 44, boxSizing: "border-box" as const,
        }}
      >
        {/* Mobile chart header — countdown to settle. The live YES %
            is already visible via the hero swap pill ('YES 58¢ ⇄') and
            the chart's right-edge endpoint chip, so we don't repeat it
            here. The countdown was the user's other primary context
            data point so it lives in this slot. */}
        <span className="md:hidden flex items-center gap-1.5">
          <span className="ptitle">SETTLES</span>
          <span
            className="mono font-bold"
            style={{ color: "var(--hl-yellow)", fontSize: "var(--t-num)" }}
          >
            {fmtCountdown(settleTs - now)}
          </span>
        </span>
        {/* Desktop pricing — MARKET / THEORY / vs-theory inline.
            Heights normalised to match the Order Entry header beside
            it: all values at t-num (15px), all labels at t-micro
            (10px). Without this the 18px numbers made this header
            taller than the order-entry header and threw the side-by-
            side panel alignment out. */}
        {(() => {
          const theoryCents = Math.round(yesProb * 100);
          const gapCents = yesCents - theoryCents;
          const marketColor =
            yesCents >= 55 ? "var(--hl-green)" :
            yesCents <= 45 ? "var(--hl-red)" :
            "var(--foreground)";
          const labelStyle = {
            color: "var(--hl-muted)",
            fontSize: "var(--t-micro)",
            fontWeight: 600,
            letterSpacing: 0.4,
          } as const;
          const valueStyle = { fontSize: "var(--t-num)" } as const;
          return (
            <div className="hidden md:flex items-baseline gap-4">
              <span className="flex items-baseline gap-1.5">
                <span style={labelStyle}>MARKET</span>
                <span className="mono font-bold" style={{ ...valueStyle, color: marketColor }}>
                  {yesCents}%
                </span>
              </span>
              <span
                className="flex items-baseline gap-1.5"
                style={{
                  opacity: expiryTier === "imminent" ? 0.4 : 1,
                  textDecoration: expiryTier === "imminent" ? "line-through" : "none",
                }}
                title={
                  expiryTier === "imminent"
                    ? "Theory unreliable — σ√t collapses near expiry."
                    : "σ√t implied YES probability at 65% annualised vol."
                }
              >
                <span style={labelStyle}>THEORY</span>
                <span className="mono font-bold" style={{ ...valueStyle, color: "var(--hl-text)" }}>
                  {theoryCents}%
                </span>
              </span>
              <span className="flex items-baseline gap-1.5" title="Gap between market and theory.">
                <span style={labelStyle}>vs theory</span>
                <span
                  className="mono font-bold"
                  style={{
                    ...valueStyle,
                    color: gapCents > 0 ? "var(--hl-green)" : gapCents < 0 ? "var(--hl-red)" : "var(--hl-muted)",
                  }}
                >
                  {gapCents > 0 ? "+" : ""}{gapCents}%
                </span>
              </span>
            </div>
          );
        })()}
        {/* Segmented control for the timeframe pills — single pill
            background so the row reads as one control rather than three
            loose buttons. Right-aligned in both layouts. */}
        <div
          className="ml-auto flex p-0.5"
          style={{
            background: "var(--background)",
            border: "1px solid var(--hl-border)",
            borderRadius: 6,
            fontSize: "var(--t-micro)",
          }}
        >
          {(["1H", "6H", "24H"] as const).map((tf) => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              className="px-2.5 py-1 transition-colors"
              style={{
                background: timeframe === tf ? "var(--hl-surface-hover)" : "transparent",
                color: timeframe === tf ? "var(--hl-accent)" : "var(--hl-muted)",
                fontWeight: timeframe === tf ? 700 : 500,
                cursor: "pointer",
                borderRadius: 4,
                letterSpacing: 0.4,
              }}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>
      <div className="p-3 flex flex-col">
        {/* Whale-stack spacer above the chart. Desktop reserves 70px
            for the YES whale stack; mobile shrinks to 28px since
            (a) the synthetic candle-fallback whales are gone so the
            stack is rarely more than 1-2 deep and (b) we want to
            reclaim viewport. overflow:visible on the chart-canvas
            below lets whales render UP into this zone via negative
            y in their absolute positioning. */}
        <div className="h-[24px] md:h-[70px]" />
        <div className="relative h-[200px] md:h-[420px]" style={{ overflow: "visible" }}>
          {/* Chart canvas reserves a 32px right margin for the y-axis
              percent labels. Endpoint chips no longer live in this
              gutter — they float ABOVE the line endpoint instead, so
              the canvas can reclaim the wider gutter that earlier
              versions used. */}
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="block h-full w-[calc(100%-32px)]"
          >
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

            {/* Strike reference — bright yellow + thicker dashes so it
                stops getting lost against the BTC line + green river.
                Previous values (width 1, opacity 0.4) made it fade
                completely on busy charts. Stops at the SETTLE line
                visually but still rendered full-width for simplicity. */}
            {strike != null && (
              <>
                <line
                  x1="0"
                  y1={strikeY}
                  x2={W}
                  y2={strikeY}
                  stroke="#f5a524"
                  strokeWidth="2"
                  strokeDasharray="8,4"
                  opacity="0.75"
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
                strokeWidth="2"
                strokeDasharray="8,4"
                opacity="0.75"
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

            {/* SETTLE vertical line — bright yellow so it reads as "the
                deadline / settlement moment". On 24H view this sits at
                the right edge of the chart (since tMax === settleTs).
                On 6H/1H views settleTs is beyond the visible window, so
                we skip the line and the user can rely on the countdown
                in the stats row instead.

                Also paint a subtle yellow-tinted band from nowX to
                settleX to make the "future" region of the chart
                visually distinct from already-resolved time. */}
            {(() => {
              if (now <= 0) return null;
              const settleX = ((settleTs - tMin) / (tMax - tMin)) * W;
              if (!Number.isFinite(settleX)) return null;
              // Off-chart on 6H/1H — settleTs > tMax = now, so nothing
              // to draw inside the visible viewBox.
              if (settleX > W + 1 || settleX < 0) return null;
              return (
                <>
                  {/* Future band — nowX (or 0) up to settleX */}
                  {nowX != null && nowX < settleX && (
                    <rect
                      x={Math.max(0, nowX)}
                      y={0}
                      width={Math.min(W, settleX) - Math.max(0, nowX)}
                      height={H}
                      fill="#f5a524"
                      opacity={0.04}
                    />
                  )}
                  {/* The settle line itself */}
                  <line
                    x1={settleX}
                    y1={0}
                    x2={settleX}
                    y2={H}
                    stroke="#f5a524"
                    strokeWidth={1.5}
                    strokeDasharray="6,3"
                    opacity={0.7}
                  />
                </>
              );
            })()}

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
            // All whales are now real fills (the candle-fallback that
            // synthesised whales from candle volume was removed).
            const outlineColor = isBuy ? "var(--hl-green)" : "var(--hl-red)";
            const opacity = 1;
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
                  border: `${w.outline}px solid ${outlineColor}`,
                  boxShadow: `0 0 ${6 + sizeFactor * 10}px ${isBuy ? "rgba(74,222,128,0.4)" : "rgba(248,113,113,0.4)"}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 9 + sizeFactor * 4,
                  zIndex: 3,
                  cursor: "pointer",
                  opacity,
                }}
                title={`Click for details · ${isBuy ? "BUY" : "SELL"} ${w.isYes ? "YES" : "NO"} · ${w.count} trade${w.count > 1 ? "s" : ""} @ ~${(w.px * 100).toFixed(1)}¢ · ${usdStr}`}
                onClick={() => onWhaleClick({ side: w.side, sideContext: w.isYes ? "yes" : "no", px: w.px, usd: w.usd, count: w.count, time: w.time })}
              >
                🐋
              </div>
            );
          })}

          {/* Endpoint price tags — anchored to the RIGHT axis area so they
              never bleed past the chart panel into the order panel.
              Previously positioned at `left: ${nowX%}` + translate(8px)
              which, when nowX was near W, pushed the chip ~70px past the
              chart's right edge. The fix moves them to a fixed
              `right: 4px` slot just inside the right y-axis labels area
              (which lives in the 32px reserved strip on the right). */}
          {/* Endpoint chips: YES/NO + BTC, both anchored right.
              When the YES line and BTC line cross (close in y-space)
              the chips were stacking on top of each other. Detect
              that case and shift the BTC chip up or down so the two
              never overlap. */}
          {nowX != null && (() => {
            const sideCents = viewSide === "yes" ? yesCents : 100 - yesCents;
            const yesPct = viewSide === "yes" ? (endY / H) * 100 : ((H - endY) / H) * 100;
            const btcPct = btcMark != null ? (btcToY(btcMark) / H) * 100 : null;

            // Vertical separation threshold — if BTC chip's centre is
            // within ~8% of the YES chip's centre, push BTC away.
            // 8% on a 200-420px tall canvas = ~16-34px, just enough to
            // clear the ~24px chip height.
            const MIN_SEP_PCT = 8;
            let btcAdjustedPct = btcPct;
            if (btcPct != null && Math.abs(btcPct - yesPct) < MIN_SEP_PCT) {
              // Push the BTC chip away from the YES chip. If BTC y is
              // numerically larger (lower on screen), push it further
              // down; otherwise push it up. Clamped to [4, 96].
              btcAdjustedPct = btcPct > yesPct
                ? Math.min(96, yesPct + MIN_SEP_PCT)
                : Math.max(4, yesPct - MIN_SEP_PCT);
            }

            const bg = viewSide === "yes" ? "var(--hl-green)" : "var(--hl-red)";
            const textColor = viewSide === "yes" ? "#001d0c" : "#2a0606";
            const glow = viewSide === "yes" ? "rgba(74,222,128,0.5)" : "rgba(248,113,113,0.5)";
            // Chips pinned to the LEFT edge of the chart, vertically
            // tracking the line's current y-position. Acts as a live
            // 'y-axis extension' — like the moving current-price tag
            // on a TradingView chart, but on the left side next to the
            // BTC price ladder. Never covers the line endpoint on the
            // right where the most recent data is.
            //
            // Horizontal: fixed at left: 4px (just inside canvas).
            // Vertical: top = line y%; translateY(-50%) centers chip on
            //   the line. No "above vs below" flip needed since the
            //   chip is sitting at the y-axis, not at the line endpoint.
            const chipLeft = "4px";
            const chipTransform = "translateY(-50%)";
            return (
              <>
                <div
                  className="absolute mono text-[9px] md:text-[11px] px-[5px] md:px-[8px] py-[2px] md:py-[3px]"
                  style={{
                    left: chipLeft,
                    top: `${yesPct}%`,
                    transform: chipTransform,
                    background: bg,
                    color: textColor,
                    borderRadius: 3,
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
                {btcMark != null && btcAdjustedPct != null && (
                  <div
                    className="absolute mono text-[9px] md:text-[11px] px-[5px] md:px-[8px] py-[2px] md:py-[3px]"
                    style={{
                      left: chipLeft,
                      top: `${btcAdjustedPct}%`,
                      transform: chipTransform,
                      background: "#fb923c",
                      color: "#1d0606",
                      borderRadius: 3,
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
              </>
            );
          })()}

          {/* SETTLE label — a vertical "SETTLES IN XhYm" tag that sits
              along the settle line on 24H view (so the bright yellow
              line on the chart is obviously labelled). Rendered as HTML
              so the text can be vertically rotated cheaply and update
              the countdown without a chart re-render. */}
          {(() => {
            if (timeframe !== "24H") return null;
            if (now <= 0) return null;
            const settleX = ((settleTs - tMin) / (tMax - tMin)) * W;
            if (!Number.isFinite(settleX) || settleX < 0 || settleX > W + 1) return null;
            return (
              <div
                className="absolute mono"
                style={{
                  // Anchor 18px LEFT of the settle line (was at the
                  // line, which sat right on the chart panel's right
                  // edge and clipped against the Order Entry panel
                  // next door).
                  left: `calc(${(settleX / W) * 100}% - 18px)`,
                  top: "50%",
                  transform: "translate(-100%, -50%) rotate(-90deg)",
                  transformOrigin: "right center",
                  color: "var(--hl-yellow)",
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: 1.5,
                  textTransform: "uppercase",
                  pointerEvents: "none",
                  whiteSpace: "nowrap",
                  textShadow: "0 0 6px rgba(245,165,36,0.4)",
                  zIndex: 2,
                }}
              >
                Settles in {fmtCountdown(settleTs - now)}
              </div>
            );
          })()}

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

          {/* LEFT y-axis — BTC price ticks in orange to match the BTC
              line. Labels sit JUST ABOVE the gridline they represent
              (translateY(-100%) shifts their bottom to align with the
              line) so the number isn't overprinted on the line itself.
              Strike row pulled out into a separate prominent chip
              below; if a tick lands within 8% of the strike's y-position
              we hide it to avoid colliding with that chip. */}
          {strike != null && (() => {
            // Strike's y as a 0..1 fraction of canvas height.
            const strikePct = strikeY / H;
            const HIDE_NEAR_STRIKE_PCT = 0.08;
            const isNearStrike = (pct: number) =>
              Math.abs(pct - strikePct) < HIDE_NEAR_STRIKE_PCT;
            // Common style for interior ticks: position by top, then
            // translateY(-100%) so the label's BOTTOM edge sits on the
            // gridline. Top tick stays at top:0 with no transform
            // (label hugs the top edge). Bottom tick uses `bottom: 0`
            // (label hugs the bottom edge).
            const tickStyle = {
              position: "absolute" as const,
              left: 4,
              transform: "translateY(-100%)",
            };
            return (
              <div
                className="absolute left-0 top-0 bottom-4 mono"
                style={{ width: 80, fontSize: 9, color: "#fb923c", padding: "2px 4px", pointerEvents: "none", opacity: 0.75 }}
              >
                {/* Top label — anchors to the top edge, no shift. */}
                <span style={{ position: "absolute", top: 0, left: 4 }}>
                  ${Math.round(btcYMax).toLocaleString()}
                </span>
                {/* 25%-down tick (= 75% of value range from min). */}
                {!isNearStrike(0.25) && (
                  <span style={{ ...tickStyle, top: "25%" }}>
                    ${Math.round(btcYMin + (btcYMax - btcYMin) * 0.75).toLocaleString()}
                  </span>
                )}
                {/* 75%-down tick (= 25% of value range from min). */}
                {!isNearStrike(0.75) && (
                  <span style={{ ...tickStyle, top: "75%" }}>
                    ${Math.round(btcYMin + (btcYMax - btcYMin) * 0.25).toLocaleString()}
                  </span>
                )}
                {/* Bottom label — anchors to the bottom edge. */}
                <span style={{ position: "absolute", bottom: 0, left: 4 }}>
                  ${Math.round(btcYMin).toLocaleString()}
                </span>
              </div>
            );
          })()}

          {/* Strike label — solid yellow chip that anchors to the
              strike line at its y position. Bigger, bolder, with a
              subtle border + background fill so the actual $-number
              reads at a glance even on busy backgrounds. Used to be a
              translucent overlapping span that disappeared into the
              orange BTC ticks behind it. */}
          {strike != null && (
            <div
              className="absolute mono text-[8px] md:text-[10px] px-[3px] md:px-[6px] py-[1px] md:py-[2px]"
              style={{
                left: 0,
                top: `${(strikeY / H) * 100}%`,
                transform: "translateY(-50%)",
                background: "rgba(245,165,36,0.18)",
                color: "var(--hl-yellow)",
                border: "1px solid rgba(245,165,36,0.6)",
                fontWeight: 800,
                letterSpacing: 0.3,
                pointerEvents: "none",
                whiteSpace: "nowrap",
                borderRadius: 2,
                zIndex: 4,
                boxShadow: "0 0 6px rgba(245,165,36,0.4)",
              }}
            >
              ${strike.toLocaleString()} {extraStrikesY?.length ? "low" : "strike"}
            </div>
          )}
          {extraStrikesY?.map((e, i) => (
            <div
              key={i}
              className="absolute mono"
              style={{
                left: 0,
                top: `${(e.y / H) * 100}%`,
                transform: "translateY(-50%)",
                background: "rgba(245,165,36,0.18)",
                color: "var(--hl-yellow)",
                border: "1px solid rgba(245,165,36,0.6)",
                padding: "2px 6px",
                fontSize: 10,
                fontWeight: 800,
                letterSpacing: 0.3,
                pointerEvents: "none",
                whiteSpace: "nowrap",
                borderRadius: 2,
                zIndex: 4,
                boxShadow: "0 0 6px rgba(245,165,36,0.4)",
              }}
            >
              ${e.value.toLocaleString()} {e.label ?? "high"}
            </div>
          ))}

          {/* NOW chip removed — the dashed vertical line + the "now ▶"
              label in the x-axis convey the same thing without the
              outlined-box artifact the user kept noticing. */}

          {/* x-axis time-of-day ticks. Mobile gets 3 evenly-spaced
              labels (start / middle / end); desktop gets 5. */}
          {(() => {
            const fmtTime = (ts: number) =>
              new Date(ts).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              });
            const isLeftEdgeContractOpen = Math.abs(tMin - contractOpen) < 60_000;
            const isRightEdgeSettle = Math.abs(tMax - settleTs) < 60_000;
            const isRightEdgeNow = Math.abs(tMax - nowSafe) < 60_000;
            const buildTicks = (N: number) => {
              const ticks: string[] = [];
              for (let i = 0; i < N; i++) {
                const ts = tMin + (i / (N - 1)) * (tMax - tMin);
                const label = fmtTime(ts);
                const decorated =
                  i === 0 && isLeftEdgeContractOpen ? `open · ${label}`
                  : i === N - 1 && isRightEdgeSettle ? `${label} · settle ▶`
                  : i === N - 1 && isRightEdgeNow ? `${label} · now ▶`
                  : label;
                ticks.push(decorated);
              }
              return ticks;
            };
            const sharedStyle = {
              left: strike != null ? 60 : 0,
              height: 16,
              fontSize: 9,
              color: "var(--hl-muted)",
              paddingTop: 4,
              borderTop: "1px solid var(--hl-border)",
            } as const;
            // right edge tracks the SVG's right edge (32px reserved for
            // y-axis percent labels on both mobile and desktop).
            const rightClass = "right-[32px]";
            return (
              <>
                <div className={`hidden md:flex absolute bottom-0 justify-between mono ${rightClass}`} style={sharedStyle}>
                  {buildTicks(5).map((t, i) => <span key={i}>{t}</span>)}
                </div>
                <div className={`md:hidden absolute bottom-0 flex justify-between mono ${rightClass}`} style={sharedStyle}>
                  {buildTicks(3).map((t, i) => <span key={i}>{t}</span>)}
                </div>
              </>
            );
          })()}

          {/* Conviction thumb + arc removed — order entry uses standard limit/market panel */}

          {/* Kalshi + Polymarket on-chart chips removed — duplicate with the
              cross-venue strip at top + the legend at bottom. The right edge
              now only has the two primary endpoint chips (YES and BTC) plus
              the optional limit-order chip when composing a limit. */}

          {/* Pending limit-order endpoint label — cyan chip near the right edge
              when a limit is being composed. */}
          {limitY != null && limitOrderCents != null && (
            <div
              className="absolute mono right-[32px]"
              style={{
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

        {/* Bottom whale spacer removed — was originally for the NO
            stack when whales rendered on both sides; we now show only
            the active side at the top, so this strip was always
            empty and just created dead space below the chart. */}

        {/* Legend strip — desktop only. Chart on mobile is visual-only
            (no key); the colours self-explain in context (green river
            = YES, orange = BTC, dashed yellow = strike + settle line). */}
        <div
          className="hidden md:flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-1 px-1"
          style={{ color: "var(--hl-muted)", fontSize: "var(--t-micro)" }}
        >
          <LegendItem swatch="line" color="var(--hl-green)" label="YES probability" />
          <LegendItem swatch="line" color="#fb923c" label="BTC price" />
          <LegendItem swatch="dashed" color="#a371f7" label="Theory (σ√t fair value)" />
          <LegendItem swatch="dashed" color="#f5a524" label="Strike" />
          <LegendItem swatch="dashed" color="#f5a524" label="Settles" />
          <LegendItem swatch="bar" color="var(--hl-green)" label="Volume (bull/bear)" />
          <LegendItem swatch="whale" color="var(--hl-green)" label="Trade flow (whale fills)" />
        </div>
      </div>
    </div>
  );
}

// Inline legend swatch — keeps the chart legend compact while still
// matching exactly the visual style of the lines on the chart above.
function LegendItem({ swatch, color, label }: { swatch: "line" | "dashed" | "bar" | "whale"; color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      {swatch === "line" && (
        <span style={{ width: 18, height: 2, background: color, display: "inline-block", borderRadius: 1 }} />
      )}
      {swatch === "dashed" && (
        <span
          style={{
            width: 18,
            height: 2,
            background: `repeating-linear-gradient(90deg, ${color} 0 5px, transparent 5px 8px)`,
            display: "inline-block",
          }}
        />
      )}
      {swatch === "bar" && (
        <span style={{ display: "inline-flex", gap: 1 }}>
          <span style={{ width: 3, height: 8, background: "var(--hl-green)", opacity: 0.55, display: "inline-block" }} />
          <span style={{ width: 3, height: 6, background: "var(--hl-red)", opacity: 0.55, display: "inline-block" }} />
          <span style={{ width: 3, height: 10, background: "var(--hl-green)", opacity: 0.55, display: "inline-block" }} />
        </span>
      )}
      {swatch === "whale" && (
        <span
          style={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            border: `2px solid ${color}`,
            display: "inline-block",
          }}
        />
      )}
      <span>{label}</span>
    </span>
  );
}

function LiveOrderBook({ hyperodd, fairCents, now, viewSide }: { hyperodd: HyperOddState; fairCents: number; now: number; viewSide: "yes" | "no" }) {
  // We only subscribe to the YES coin's book via WS, but YES + NO are
  // perfectly complementary at 0/1 settle:
  //   YES bid  P,size  ⟷  NO ask  (1−P),size
  //   YES ask  P,size  ⟷  NO bid  (1−P),size
  // So when the user toggles BUY NO we just flip + invert the book
  // client-side instead of subscribing to two channels. The mark/spread
  // calculations use the post-flip values so headers read in NO space.
  const flip = viewSide === "no";
  const rawYesBids = hyperodd.bids;
  const rawYesAsks = hyperodd.asks;
  // After flip: NO "bids" = YES asks inverted, NO "asks" = YES bids inverted.
  // Best-bid-first / best-ask-first ordering: YES bids are ranked high→low
  // and YES asks low→high; flipping a "high→low YES bid" by (1−P) yields
  // "low→high NO ask", which is wrong for an ask column (asks display
  // low→high already). Reverse the array post-flip to restore the
  // expected sort.
  const invertRow = (l: BookLevel) => ({ ...l, px: String(1 - parseFloat(l.px)) });
  const bids: BookLevel[] = flip ? rawYesAsks.map(invertRow) : rawYesBids;
  const asks: BookLevel[] = flip ? rawYesBids.map(invertRow) : rawYesAsks;

  const hasBook = bids.length > 0 || asks.length > 0;
  const yesMark = hyperodd.mark;
  const sideMark = yesMark != null ? (flip ? 1 - yesMark : yesMark) : null;
  const markCents = sideMark != null ? Math.round(sideMark * 100) : null;
  const bestBid = bids[0] ? parseFloat(bids[0].px) : null;
  const bestAsk = asks[0] ? parseFloat(asks[0].px) : null;
  const spread = bestBid != null && bestAsk != null ? Math.abs(bestAsk - bestBid) : null;

  const allLevels = [...bids.slice(0, 10), ...asks.slice(0, 10)];
  const maxSize = allLevels.reduce((m, l) => Math.max(m, parseFloat(l.sz)), 0.001);

  // displayCoin + sideLabel removed alongside the panel-header caption
  // they used to populate. markColor stays — Mark cents value below
  // colour-codes based on which side the user is viewing.
  const markColor = flip ? "var(--hl-red)" : "var(--hl-green)";

  return (
    <div className="panel">
      <div
        className="px-3 py-2 flex items-center gap-3"
        style={{ borderBottom: "1px solid var(--hl-border)", height: 44, boxSizing: "border-box" }}
      >
        <span className="ptitle">Order book</span>
        {/* Caption ('live · #750 · HIP-4 mainnet · YES side') removed
            per user request — the panel is obviously live in context,
            the coin tag is duplicated elsewhere, and the side label is
            already implicit in the order book contents below. */}
        <div className="ml-auto flex gap-3 text-[10px]" style={{ color: "var(--hl-muted)" }}>
          {markCents != null && (
            <span>
              Mark <b className="mono" style={{ color: markColor }}>{markCents}¢</b>
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
          <LiveObSide rows={bids.slice(0, 10).map((l) => ({ px: parseFloat(l.px), size: parseFloat(l.sz) }))} side="bid" maxSize={maxSize} />
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
          <LiveObSide rows={asks.slice(0, 10).map((l) => ({ px: parseFloat(l.px), size: parseFloat(l.sz) }))} side="ask" maxSize={maxSize} />
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
  direction,
  setDirection,
}: {
  yesCents: number;
  noCents: number;
  stake: string;
  setStake: (s: string) => void;
  side: "yes" | "no";
  setSide: (s: "yes" | "no") => void;
  direction: "buy" | "sell";
  setDirection: (d: "buy" | "sell") => void;
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
  const isSell = direction === "sell";
  // Buy fills at the ask, sell fills at the bid. effectiveYesPx is the
  // ask side; when selling we want the bid.
  const sellYesPx = liveYesBid;
  const sellNoPx = 1 - liveYesAsk;
  const buyFillCents = side === "yes" ? effectiveYesPx * 100 : (1 - effectiveYesPx) * 100;
  const sellFillCents = side === "yes" ? sellYesPx * 100 : sellNoPx * 100;
  const fillPriceCents = isSell ? sellFillCents : buyFillCents;
  const bestForSide = isSell
    ? (side === "yes" ? liveYesBid * 100 : (1 - liveYesAsk) * 100)
    : (side === "yes" ? liveYesAsk * 100 : (1 - liveYesBid) * 100);
  const slippageBps =
    orderType === "limit" && parseFloat(limitPx) > 0
      ? Math.abs(fillPriceCents - bestForSide) * 100 // bps approx
      : 0;

  // SELL-mode derived values: how many shares the user has on the
  // selected side, and the proceeds (shares × bid price) at the
  // currently-typed share count.
  const positionOnSide = side === "yes" ? yesPosition : noPosition;
  const sellSharesTyped = isSell ? Math.max(0, Math.floor(parseFloat(stake) || 0)) : 0;
  const sellSharesClamped = Math.min(sellSharesTyped, Math.floor(positionOnSide));
  const sellProceedsUsd = isSell ? sellSharesClamped * (fillPriceCents / 100) : 0;

  return (
    <div className="panel">
      <div
        className="px-3 py-2 flex items-center"
        style={{
          borderBottom: "1px solid var(--hl-border)",
          // Locked to 40px so this header lines up vertically with the
          // chart panel header beside it. See chart-panel header for
          // the matching minHeight.
          height: 44, boxSizing: "border-box" as const,
        }}
      >
        <span className="ptitle">Order entry</span>
        {/* bid/ask hidden on mobile — too dense, the hero already shows
            the live market % and the YES/NO swap shows cents. */}
        <span className="psub ml-auto hidden md:inline">
          bid {(liveYesBid * 100).toFixed(1)}¢ · ask {(liveYesAsk * 100).toFixed(1)}¢
        </span>
      </div>
      {/* gap-2 on mobile (was 2.5) saves ~10-12px across the order
          form. Desktop keeps gap-2.5 for breathing room. */}
      <div className="p-3 flex flex-col gap-2 md:gap-2.5">

        {/* BUY / SELL direction. Sell is only meaningful if the user
            holds shares on at least one side — but we don't disable it
            because the disabled-state is more confusing than just
            letting them click and seeing the "no shares" error inline. */}
        <div
          className="grid grid-cols-2 gap-1 p-1"
          style={{ background: "var(--background)", border: "1px solid var(--hl-border)", borderRadius: 5 }}
        >
          <button
            onClick={() => setDirection("buy")}
            className="py-2 font-bold"
            style={{
              background: !isSell ? "var(--hl-surface-hover)" : "transparent",
              color: !isSell ? "var(--foreground)" : "var(--hl-muted)",
              borderRadius: 4,
              fontSize: "var(--t-caption)",
              letterSpacing: 0.4,
            }}
          >
            BUY
          </button>
          <button
            onClick={() => setDirection("sell")}
            className="py-2 font-bold"
            style={{
              background: isSell ? "var(--hl-surface-hover)" : "transparent",
              color: isSell ? "var(--foreground)" : "var(--hl-muted)",
              borderRadius: 4,
              fontSize: "var(--t-caption)",
              letterSpacing: 0.4,
            }}
          >
            SELL
          </button>
        </div>

        {/* YES / NO side selector. Shown on both mobile and desktop —
            user feedback: the hero swap pill alone wasn't obvious as the
            order-side control. Stays in sync with the hero pill via
            shared `side` state, so either control flips both. */}
        <div
          className="grid grid-cols-2 gap-1 p-1"
          style={{ background: "var(--background)", border: "1px solid var(--hl-border)", borderRadius: 5 }}
        >
          <button
            onClick={() => {
              setSide("yes");
              // When already in SELL mode, point the share count at
              // the YES position the user actually holds. Skipped in
              // BUY mode — there the stake is "USDH to spend", which
              // doesn't depend on side.
              if (isSell) setStake(Math.floor(yesPosition).toString());
            }}
            className="py-2 font-bold flex flex-col items-center"
            style={{
              background: side === "yes" ? "rgba(74,222,128,0.12)" : "transparent",
              color: side === "yes" ? "var(--hl-green)" : "var(--hl-muted)",
              borderRadius: 4,
              fontSize: "var(--t-caption)",
              letterSpacing: 0.4,
            }}
          >
            {isSell ? "SELL YES" : "BUY YES"}
            <span className="mono" style={{ fontSize: "var(--t-num)" }}>
              {isSell ? `${(sellYesPx * 100).toFixed(1)}¢` : `${yesCents}¢`}
            </span>
            {isSell && (
              <span className="mono" style={{ fontSize: "var(--t-micro)", color: "var(--hl-muted)" }}>
                {yesPosition > 0 ? `${yesPosition.toLocaleString()} held` : "0 held"}
              </span>
            )}
          </button>
          <button
            onClick={() => {
              setSide("no");
              if (isSell) setStake(Math.floor(noPosition).toString());
            }}
            className="py-2 font-bold flex flex-col items-center"
            style={{
              background: side === "no" ? "rgba(248,113,113,0.12)" : "transparent",
              color: side === "no" ? "var(--hl-red)" : "var(--hl-muted)",
              borderRadius: 4,
              fontSize: "var(--t-caption)",
              letterSpacing: 0.4,
            }}
          >
            {isSell ? "SELL NO" : "BUY NO"}
            <span className="mono" style={{ fontSize: "var(--t-num)" }}>
              {isSell ? `${(sellNoPx * 100).toFixed(1)}¢` : `${noCents}¢`}
            </span>
            {isSell && (
              <span className="mono" style={{ fontSize: "var(--t-micro)", color: "var(--hl-muted)" }}>
                {noPosition > 0 ? `${noPosition.toLocaleString()} held` : "0 held"}
              </span>
            )}
          </button>
        </div>

        {/* Market / Limit toggle — DESKTOP ONLY. Mobile defaults to
            market orders; limit ordering is a power-user flow that
            belongs on the desktop UI. */}
        <div
          className="hidden md:grid grid-cols-2 gap-1 p-1"
          style={{ background: "var(--background)", border: "1px solid var(--hl-border)", borderRadius: 5 }}
        >
          <button
            onClick={() => setOrderType("market")}
            className="py-1.5 font-semibold"
            style={{
              background: orderType === "market" ? "var(--hl-surface-hover)" : "transparent",
              color: orderType === "market" ? "var(--foreground)" : "var(--hl-muted)",
              borderRadius: 4,
              fontSize: "var(--t-micro)",
              letterSpacing: 0.4,
            }}
          >
            MARKET
          </button>
          <button
            onClick={() => setOrderType("limit")}
            className="py-1.5 font-semibold"
            style={{
              background: orderType === "limit" ? "var(--hl-surface-hover)" : "transparent",
              color: orderType === "limit" ? "var(--foreground)" : "var(--hl-muted)",
              borderRadius: 4,
              fontSize: "var(--t-micro)",
              letterSpacing: 0.4,
            }}
          >
            LIMIT
          </button>
        </div>

        {/* Limit price input — only when limit selected */}
        {orderType === "limit" && (
          <div className="field-row flex items-center gap-2 px-2 py-2">
            <span className="cellL">Limit ¢</span>
            <input
              type="text"
              inputMode="decimal"
              value={limitPx}
              placeholder={side === "yes" ? (liveYesAsk * 100).toFixed(1) : ((1 - liveYesBid) * 100).toFixed(1)}
              onChange={(e) => setLimitPx(e.target.value.replace(/[^\d.]/g, ""))}
              className="flex-1 min-w-0 bg-transparent border-none outline-none mono text-right font-semibold"
              style={{ color: "var(--foreground)", fontSize: "var(--t-input)" }}
            />
            <span className="mono" style={{ color: "var(--hl-muted)", fontSize: "var(--t-micro)" }}>¢ / share</span>
          </div>
        )}

        {/* Wallet context — DESKTOP ONLY. On mobile the dedicated
            "Your position" panel below + the hero's BTC line already
            show this info; duplicating it here was redundant chrome. */}
        <div className="hidden md:flex field-row flex-col" style={{ fontSize: "var(--t-caption)" }}>
          <div className="flex items-center justify-between px-2 py-1.5">
            <span style={{ color: "var(--hl-muted)" }}>Available</span>
            <span className="mono" style={{ fontWeight: 600 }}>
              {usdhBalance == null
                ? "—"
                : `${usdhBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDH`}
            </span>
          </div>
          <div className="flex items-center justify-between px-2 py-1.5" style={{ borderTop: "1px solid var(--hl-border)" }}>
            <span style={{ color: "var(--hl-muted)" }}>Position</span>
            <span className="mono" style={{ fontWeight: 600 }}>
              {(() => {
                const pos = side === "yes" ? yesPosition : noPosition;
                const label = side === "yes" ? "YES" : "NO";
                if (!pos) return `0 ${label}`;
                return `${pos.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${label}`;
              })()}
            </span>
          </div>
        </div>

        {/* Size input. BUY = USDH the user wants to risk; SELL = shares
            they want to close. Same stake state in both modes, so a
            switch resets the value visually but not the typed string. */}
        <div className="field-row flex items-center gap-2 px-2 py-2">
          <span className="cellL">{isSell ? "Shares" : "Size"}</span>
          <input
            type="text"
            inputMode="decimal"
            value={stake}
            onChange={(e) => setStake(e.target.value.replace(/[^\d.]/g, ""))}
            placeholder={isSell ? Math.floor(positionOnSide).toString() : undefined}
            className="flex-1 min-w-0 bg-transparent border-none outline-none mono text-right font-semibold"
            style={{ color: "var(--foreground)", fontSize: "var(--t-input)" }}
          />
          <span className="mono" style={{ color: "var(--hl-muted)", fontSize: "var(--t-micro)" }}>
            {isSell ? "shares" : "USDH"}
          </span>
        </div>

        {/* Quick-pick row. BUY = preset USDH amounts; SELL = percent
            of current position (25/50/75/100%) so users can close a
            chunk of their position with one tap. */}
        <div className="grid grid-cols-4 gap-1">
          {(isSell
            ? ["25%", "50%", "75%", "Max"]
            : ["$25", "$100", "$250", "Max"]
          ).map((q) => (
            <button
              key={q}
              onClick={() => {
                if (isSell) {
                  const max = Math.floor(positionOnSide);
                  const pct = q === "Max" ? 1 : parseInt(q, 10) / 100;
                  setStake(Math.max(0, Math.floor(max * pct)).toString());
                } else {
                  setStake(q === "Max" ? "1000" : q.replace("$", ""));
                }
              }}
              className="py-2 font-semibold"
              style={{
                background: "var(--background)",
                border: "1px solid var(--hl-border)",
                color: "var(--hl-text)",
                borderRadius: 5,
                fontSize: "var(--t-caption)",
              }}
            >
              {q}
            </button>
          ))}
        </div>

        {/* Summary — DESKTOP gets the full breakdown (avg fill / shares
            / profit if win / max payout). MOBILE gets a single muted
            line above the submit button to keep noise down. */}
        <div className="hidden md:block field-row px-2 py-2">
          <SumRow l={orderType === "market" ? "Avg fill" : "Limit price"} v={`${fillPriceCents.toFixed(1)}¢`} />
          {!isSell && <SumRow l="Shares" v={shares.toFixed(0)} />}
          {orderType === "limit" && slippageBps > 0 && (
            <SumRow l="Distance from best" v={`${Math.abs(fillPriceCents - bestForSide).toFixed(2)}¢`} cls="text-[var(--hl-muted)]" />
          )}
          {!isSell && <SumRow l="Profit if win" v={`+$${profit.toFixed(2)}`} cls="text-[var(--hl-green)]" />}
          {!isSell && <SumRow l="Max payout" v={`$${maxPayout.toFixed(2)}`} total />}
          {isSell && <SumRow l="Selling" v={`${sellSharesClamped.toLocaleString()} ${side.toUpperCase()}`} />}
          {isSell && <SumRow l="You receive" v={`≈ $${sellProceedsUsd.toFixed(2)}`} total />}
        </div>
        {/* Mobile one-liner — minimum info. Dropped 'max payout'
            since it's literally just `shares` ($1 per share at settle),
            so showing both was saying the same thing twice. Profit-
            if-win is the more informative number. */}
        <div
          className="md:hidden text-center mono"
          style={{ color: "var(--hl-muted)", fontSize: "var(--t-micro)" }}
        >
          {isSell
            ? `Selling ${sellSharesClamped.toLocaleString()} ${side.toUpperCase()} · receive ≈ $${sellProceedsUsd.toFixed(2)}`
            : `${shares.toFixed(0)} shares · +$${profit.toFixed(0)} if win`}
        </div>

        <button
          className="py-3 font-bold tracking-wide"
          style={{
            background: orderStatus.kind === "pending"
              ? "var(--hl-muted)"
              : isSell
                ? "var(--hl-muted)" /* neutral grey fill colour for sell */
                : side === "yes" ? "var(--hl-green)" : "var(--hl-red)",
            color: isSell ? "var(--foreground)" : "#001d0c",
            border: isSell ? `1px solid ${side === "yes" ? "var(--hl-green)" : "var(--hl-red)"}` : "none",
            borderRadius: 6,
            fontSize: "var(--t-body)",
            cursor: orderStatus.kind === "pending" ? "wait" : "pointer",
            opacity: orderStatus.kind === "pending" ? 0.7 : 1,
          }}
          disabled={orderStatus.kind === "pending"}
          onClick={onSubmit}
        >
          {(() => {
            if (orderStatus.kind === "pending") return "Placing order…";
            const verb = isSell ? "Sell" : "Buy";
            const sideLabel = side === "yes" ? "YES" : "NO";
            const tail = orderType === "market"
              ? "@ market"
              : `@ ${parseFloat(limitPx || "0").toFixed(1)}¢`;
            return `${verb} ${sideLabel} ${tail}`;
          })()}
        </button>

        {/* Inline order status */}
        {orderStatus.kind === "success" && (
          <div
            className="px-2 py-1.5"
            style={{
              background: "rgba(74,222,128,0.1)",
              border: "1px solid rgba(74,222,128,0.35)",
              color: "var(--hl-green)",
              borderRadius: 5,
              fontSize: "var(--t-micro)",
            }}
          >
            ✓ {orderStatus.message ?? "Order placed"}
          </div>
        )}
        {orderStatus.kind === "error" && (
          <div
            className="px-2 py-1.5"
            style={{
              background: "rgba(248,113,113,0.1)",
              border: "1px solid rgba(248,113,113,0.35)",
              color: "var(--hl-red)",
              borderRadius: 5,
              fontSize: "var(--t-micro)",
            }}
          >
            ✗ {orderStatus.message ?? "Order failed"}
          </div>
        )}

        {/* Footer — desktop only. Mobile already shows the settle
            countdown in the hero context line. */}
        <div
          className="hidden md:block text-center tracking-wide"
          style={{ color: "var(--hl-muted)", fontSize: "var(--t-micro)" }}
        >
          Settles 06:00 UTC · 1.5 bps builder fee
        </div>
      </div>
    </div>
  );
}

// CompareStrip, CompareStripHelp, ExplainRow components removed —
// their MARKET / THEORY / vs-theory content was moved inline into
// the RiverChart desktop header so the chart panel and pricing live
// on the same row. Saves a full panel-card of vertical space.

// InterpBracketSubtitle removed alongside Kalshi/Polymarket cells.

function SumRow({ l, v, cls = "", total = false }: { l: string; v: string; cls?: string; total?: boolean }) {
  // total row gets bumped to body-size + accent color, others sit at
  // micro-size so the eye is drawn to the bottom-line payout.
  return (
    <div
      className="flex justify-between"
      style={{
        padding: "3px 0",
        fontSize: total ? "var(--t-caption)" : "var(--t-micro)",
        marginTop: total ? 4 : 0,
        paddingTop: total ? 6 : 3,
        borderTop: total ? "1px solid var(--hl-border)" : undefined,
      }}
    >
      <span style={{ color: total ? "var(--foreground)" : "var(--hl-muted)", fontWeight: total ? 600 : 400 }}>{l}</span>
      <span
        className={`mono font-semibold ${cls}`}
        style={{
          color: total && !cls ? "var(--hl-green)" : undefined,
          fontSize: total ? "var(--t-body)" : "var(--t-caption)",
        }}
      >
        {v}
      </span>
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
  hip4CostBasis,
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
  // Cost basis per HIP-4 coin — drives profit display in the active
  // bucket's order panel when the user already holds shares.
  hip4CostBasis: Map<string, {
    totalBuyShares: number;
    totalBuyUsd: number;
    totalSellShares: number;
    totalSellUsd: number;
  }>;
}) {
  const [selectedBucketIdx, setSelectedBucketIdx] = useState(0);
  const [tradeSide, setTradeSide] = useState<"yes" | "no">("yes");
  const [direction, setDirectionRaw] = useState<"buy" | "sell">("buy");
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
          // Newest first, capped at 2500 so chart whales can spread
          // across the visible time window without older trades being
          // evicted as new ones stream in.
          return [...fresh, ...prev]
            .sort((a, b) => b.time - a.time)
            .slice(0, 2500);
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
      {/* ── MOBILE HERO (md:hidden) ───────────────────────────────────
          Same hero pattern as the binary view: big question, big bucket
          picker, YES/NO cards for the chosen bucket, single context
          line. The bucket dropdown takes full width since it's the
          primary navigation in this view. */}
      <div className="md:hidden px-4 pt-4 pb-3 border-b" style={{ borderColor: "var(--hl-border)" }}>
        <h1
          className="font-bold tracking-tight leading-tight"
          style={{ fontSize: 22 }}
        >
          BTC price range?
        </h1>
        <div
          className="mt-1.5 flex items-center gap-2 flex-wrap"
          style={{ fontSize: "var(--t-caption)" }}
        >
          <span className="mono" style={{ color: "var(--hl-text)", fontWeight: 600 }}>
            BTC {btcMark ? `$${btcMark.toLocaleString(undefined, { maximumFractionDigits: 1 })}` : "—"}
          </span>
          <span style={{ color: "var(--hl-muted)" }}>·</span>
          <span className="mono" style={{ color: "var(--hl-yellow)" }}>
            {fmtCountdown(market.expiryMs - now)} left
          </span>
        </div>

        {/* Full-width bucket picker — the chosen range becomes the
            user's market. Bigger touch target than the inline desktop
            select, and shows the range it represents. */}
        <select
          value={selectedBucketIdx}
          onChange={(e) => setSelectedBucketIdx(parseInt(e.target.value, 10))}
          className="mt-3 w-full px-3 py-2.5 mono font-semibold"
          style={{
            background: "var(--hl-surface)",
            border: "1px solid var(--hl-accent)",
            color: "var(--hl-accent)",
            borderRadius: 8,
            fontSize: "var(--t-body)",
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

        {/* Twin YES/NO trade cards for the selected bucket. */}
        <div className="mt-3 grid grid-cols-2 gap-2.5">
          <button
            onClick={() => setTradeSide("yes")}
            className="text-left px-3 py-2.5 transition-all"
            style={{
              background: tradeSide === "yes" ? "rgba(74,222,128,0.14)" : "var(--hl-surface)",
              border: `1.5px solid ${tradeSide === "yes" ? "var(--hl-green)" : "var(--hl-border)"}`,
              borderRadius: 8,
            }}
          >
            <div
              style={{
                color: tradeSide === "yes" ? "var(--hl-green)" : "var(--hl-muted)",
                fontSize: "var(--t-micro)",
                letterSpacing: 0.6,
                fontWeight: 700,
              }}
            >
              YES
            </div>
            <div
              className="mono font-bold tracking-tight"
              style={{
                color: tradeSide === "yes" ? "var(--hl-green)" : "var(--foreground)",
                fontSize: 28,
                lineHeight: 1.1,
                marginTop: 1,
              }}
            >
              {yesCents}¢
            </div>
          </button>
          <button
            onClick={() => setTradeSide("no")}
            className="text-left px-3 py-2.5 transition-all"
            style={{
              background: tradeSide === "no" ? "rgba(248,113,113,0.14)" : "var(--hl-surface)",
              border: `1.5px solid ${tradeSide === "no" ? "var(--hl-red)" : "var(--hl-border)"}`,
              borderRadius: 8,
            }}
          >
            <div
              style={{
                color: tradeSide === "no" ? "var(--hl-red)" : "var(--hl-muted)",
                fontSize: "var(--t-micro)",
                letterSpacing: 0.6,
                fontWeight: 700,
              }}
            >
              NO
            </div>
            <div
              className="mono font-bold tracking-tight"
              style={{
                color: tradeSide === "no" ? "var(--hl-red)" : "var(--foreground)",
                fontSize: 28,
                lineHeight: 1.1,
                marginTop: 1,
              }}
            >
              {noCents}¢
            </div>
          </button>
        </div>
      </div>

      {/* ── DESKTOP HEADER (hidden on mobile) ─────────────────────────── */}
      <div className="hidden md:block max-w-[1440px] mx-auto px-4 py-3 border-b" style={{ borderColor: "var(--hl-border)" }}>
        <div className="flex items-center gap-3 mb-3 flex-wrap">
          <h1
            className="font-bold tracking-tight leading-tight"
            style={{ fontSize: "var(--t-title-lg)" }}
          >
            BTC price range on {market.expiryMs ? new Date(market.expiryMs).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "expiry"}?
          </h1>
          <select
            value={selectedBucketIdx}
            onChange={(e) => setSelectedBucketIdx(parseInt(e.target.value, 10))}
            className="px-3 py-1.5 mono font-semibold"
            style={{
              background: "var(--hl-surface)",
              border: "1px solid var(--hl-accent)",
              color: "var(--hl-accent)",
              borderRadius: 5,
              fontSize: "var(--t-body)",
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

        <div
          className="flex items-stretch overflow-x-auto whitespace-nowrap scrollbar-none"
          style={{ fontSize: "var(--t-body)" }}
        >
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

      {/* Main grid — stacks vertically on mobile, two columns at md+.
          pb-6 on mobile (no sticky bar in bucket view, so smaller pad). */}
      <main className="max-w-[1440px] mx-auto px-4 py-3 grid gap-3 grid-cols-1 md:grid-cols-[1fr_320px] pb-6" style={{ alignItems: "start" }}>
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
            yesProb={(selectedBucket?.yesPrice ?? 0)}
            expiryTier="none"
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
        <div className="panel p-3 flex flex-col gap-2.5">
          <div className="flex items-center" style={{ borderBottom: "1px solid var(--hl-border)", paddingBottom: 8 }}>
            <span className="ptitle">Trade range</span>
            <span className="psub ml-auto mono">{selectedBucket?.yesCoin}/{selectedBucket?.noCoin}</span>
          </div>
          <div style={{ color: "var(--hl-text)", fontSize: "var(--t-caption)" }}>
            <b className="mono">{selectedBucket?.label}</b>{" "}
            <span style={{ color: "var(--hl-muted)" }}>· {yesCents}¢ YES · {noCents}¢ NO</span>
          </div>

          {/* BUY / SELL direction toggle — switching resets stake to
              either "100" USDH (buy) or the user's position on the
              active side (sell). */}
          <div
            className="grid grid-cols-2 gap-1 p-1 mt-1"
            style={{ background: "var(--background)", border: "1px solid var(--hl-border)", borderRadius: 5 }}
          >
            <button
              onClick={() => {
                setDirectionRaw("buy");
                setStake("100");
              }}
              className="py-1.5 font-bold"
              style={{
                background: direction === "buy" ? "var(--hl-surface-hover)" : "transparent",
                color: direction === "buy" ? "var(--foreground)" : "var(--hl-muted)",
                borderRadius: 4,
                fontSize: "var(--t-micro)",
                letterSpacing: 0.4,
              }}
            >
              BUY
            </button>
            <button
              onClick={() => {
                setDirectionRaw("sell");
                if (selectedBucket) {
                  const coin = tradeSide === "yes" ? selectedBucket.yesCoin : selectedBucket.noCoin;
                  const pos = hip4Positions.get(coin) ?? 0;
                  setStake(Math.floor(pos).toString());
                }
              }}
              className="py-1.5 font-bold"
              style={{
                background: direction === "sell" ? "var(--hl-surface-hover)" : "transparent",
                color: direction === "sell" ? "var(--foreground)" : "var(--hl-muted)",
                borderRadius: 4,
                fontSize: "var(--t-micro)",
                letterSpacing: 0.4,
              }}
            >
              SELL
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2 mt-1">
            <button
              onClick={() => {
                setTradeSide("yes");
                // In SELL mode, retarget stake to the YES position on
                // this bucket so users don't accidentally try to sell
                // a NO-side share count they don't actually hold.
                if (direction === "sell" && selectedBucket) {
                  const pos = hip4Positions.get(selectedBucket.yesCoin) ?? 0;
                  setStake(Math.floor(pos).toString());
                }
              }}
              className="py-2 mono font-semibold"
              style={{
                background: tradeSide === "yes" ? "rgba(74,222,128,0.15)" : "var(--hl-surface)",
                border: `1px solid ${tradeSide === "yes" ? "var(--hl-green)" : "var(--hl-border)"}`,
                color: tradeSide === "yes" ? "var(--hl-green)" : "var(--hl-muted)",
                borderRadius: 5,
                fontSize: "var(--t-body)",
              }}
            >
              {direction === "sell" ? "SELL YES" : "YES"}
            </button>
            <button
              onClick={() => {
                setTradeSide("no");
                if (direction === "sell" && selectedBucket) {
                  const pos = hip4Positions.get(selectedBucket.noCoin) ?? 0;
                  setStake(Math.floor(pos).toString());
                }
              }}
              className="py-2 mono font-semibold"
              style={{
                background: tradeSide === "no" ? "rgba(248,113,113,0.15)" : "var(--hl-surface)",
                border: `1px solid ${tradeSide === "no" ? "var(--hl-red)" : "var(--hl-border)"}`,
                color: tradeSide === "no" ? "var(--hl-red)" : "var(--hl-muted)",
                borderRadius: 5,
                fontSize: "var(--t-body)",
              }}
            >
              {direction === "sell" ? "SELL NO" : "NO"}
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setOrderType("market")}
              className="py-1.5 mono"
              style={{
                background: orderType === "market" ? "var(--hl-accent)" : "var(--hl-surface)",
                color: orderType === "market" ? "var(--background)" : "var(--hl-muted)",
                border: `1px solid ${orderType === "market" ? "var(--hl-accent)" : "var(--hl-border)"}`,
                borderRadius: 5,
                fontSize: "var(--t-caption)",
              }}
            >
              Market
            </button>
            <button
              onClick={() => setOrderType("limit")}
              className="py-1.5 mono"
              style={{
                background: orderType === "limit" ? "var(--hl-accent)" : "var(--hl-surface)",
                color: orderType === "limit" ? "var(--background)" : "var(--hl-muted)",
                border: `1px solid ${orderType === "limit" ? "var(--hl-accent)" : "var(--hl-border)"}`,
                borderRadius: 5,
                fontSize: "var(--t-caption)",
              }}
            >
              Limit
            </button>
          </div>

          {/* Wallet context — Available-to-Trade + Current-Position rows,
              same shape as the binary TradePanel. Position is whichever
              side (YES/NO) the user is currently buying for this bucket.
              When the user holds shares we also show an "If wins" net
              P&L underneath using cost basis from fill history. */}
          {(() => {
            const coin = selectedBucket
              ? (tradeSide === "yes" ? selectedBucket.yesCoin : selectedBucket.noCoin)
              : null;
            const pos = coin ? hip4Positions.get(coin) ?? 0 : 0;
            const cb = coin ? hip4CostBasis.get(coin) : undefined;
            const avgEntry = cb && cb.totalBuyShares > 0
              ? cb.totalBuyUsd / cb.totalBuyShares
              : null;
            const costBasis = avgEntry != null ? pos * avgEntry : null;
            // If this side wins, every share pays $1 → profit = shares − cost.
            const profitIfWins = costBasis != null ? pos - costBasis : null;
            const label = tradeSide === "yes" ? "YES" : "NO";
            return (
              <div className="field-row flex flex-col" style={{ fontSize: "var(--t-caption)" }}>
                <div className="flex items-center justify-between px-2 py-1.5">
                  <span style={{ color: "var(--hl-muted)" }}>Available</span>
                  <span className="mono" style={{ fontWeight: 600 }}>
                    {usdhBalance == null
                      ? "—"
                      : `${usdhBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDH`}
                  </span>
                </div>
                <div className="flex items-center justify-between px-2 py-1.5" style={{ borderTop: "1px solid var(--hl-border)" }}>
                  <span style={{ color: "var(--hl-muted)" }}>Position</span>
                  <span className="mono" style={{ fontWeight: 600 }}>
                    {pos > 0 ? `${pos.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${label}` : `0 ${label}`}
                  </span>
                </div>
                {/* Cost-basis sub-line: only shown when user has a real
                    position + we have fill history to compute it. */}
                {pos > 0 && avgEntry != null && costBasis != null && (
                  <div
                    className="flex items-center justify-between px-2 py-1"
                    style={{ borderTop: "1px solid var(--hl-border)", color: "var(--hl-muted)", fontSize: "var(--t-micro)" }}
                  >
                    <span>Avg {(avgEntry * 100).toFixed(1)}¢ · paid ${costBasis.toFixed(2)}</span>
                    {profitIfWins != null && (
                      <span
                        className="mono"
                        style={{ color: profitIfWins >= 0 ? "var(--hl-green)" : "var(--hl-red)", fontWeight: 600 }}
                      >
                        {profitIfWins >= 0 ? "+" : "−"}${Math.abs(profitIfWins).toFixed(2)} if win
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          <label className="cellL">{direction === "sell" ? "Shares" : "Stake (USD)"}</label>
          <input
            type="number"
            inputMode="decimal"
            value={stake}
            onChange={(e) => setStake(e.target.value)}
            placeholder={
              direction === "sell" && selectedBucket
                ? Math.floor(hip4Positions.get(tradeSide === "yes" ? selectedBucket.yesCoin : selectedBucket.noCoin) ?? 0).toString()
                : undefined
            }
            className="mono field-row px-2 py-2"
            // fontSize 16 prevents iOS Safari from auto-zooming on focus.
            style={{ color: "var(--foreground)", fontSize: "var(--t-input)" }}
          />

          {orderType === "limit" && (
            <>
              <label className="cellL">Limit price (¢)</label>
              <input
                type="number"
                inputMode="decimal"
                value={limitPx}
                onChange={(e) => setLimitPx(e.target.value)}
                placeholder="0-100"
                className="mono field-row px-2 py-2"
                style={{ color: "var(--foreground)", fontSize: "var(--t-input)" }}
              />
            </>
          )}

          {(() => {
            const yesPx = selectedBucket?.yesPrice ?? 0;
            const sidePx = tradeSide === "yes" ? yesPx : 1 - yesPx;
            if (direction === "buy") {
              const usd = parseFloat(stake) || 0;
              const shares = sidePx > 0 ? Math.floor(usd / sidePx) : 0;
              return (
                <div className="mt-1" style={{ color: "var(--hl-muted)", fontSize: "var(--t-caption)" }}>
                  ≈ <b className="mono">{shares.toLocaleString()}</b> shares · payout if {tradeSide.toUpperCase()} wins:{" "}
                  <b className="mono" style={{ color: "var(--hl-green)" }}>${shares.toLocaleString()}</b>
                </div>
              );
            }
            // sell: stake is share count, proceeds = shares × side bid.
            const coin = selectedBucket ? (tradeSide === "yes" ? selectedBucket.yesCoin : selectedBucket.noCoin) : null;
            const positionOnSide = coin ? hip4Positions.get(coin) ?? 0 : 0;
            const wantShares = Math.max(0, Math.floor(parseFloat(stake) || 0));
            const sellShares = Math.min(wantShares, Math.floor(positionOnSide));
            const proceeds = sellShares * sidePx;
            return (
              <div className="mt-1" style={{ color: "var(--hl-muted)", fontSize: "var(--t-caption)" }}>
                Sell <b className="mono">{sellShares.toLocaleString()}</b> {tradeSide.toUpperCase()} · receive{" "}
                <b className="mono" style={{ color: "var(--hl-green)" }}>≈ ${proceeds.toFixed(2)}</b>
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

              // Compute final size differently for buy vs sell:
              //  - BUY: floor(USDH / price), bumped up to clear $10 min
              //  - SELL: typed share count, clamped to position
              let finalSize: number;
              if (direction === "buy") {
                const usd = parseFloat(stake);
                const MIN_NOTIONAL_USDH = 10;
                const naiveShares = Math.max(1, Math.floor(usd / sidePx));
                const minSharesForMinimum = Math.ceil(MIN_NOTIONAL_USDH / sidePx);
                finalSize = Math.max(naiveShares, minSharesForMinimum);
              } else {
                const coin = tradeSide === "yes" ? selectedBucket.yesCoin : selectedBucket.noCoin;
                const positionOnSide = hip4Positions.get(coin) ?? 0;
                const requested = Math.floor(parseFloat(stake) || 0);
                finalSize = Math.min(requested, Math.floor(positionOnSide));
                if (finalSize <= 0) {
                  setOrderStatus({
                    kind: "error",
                    message: positionOnSide <= 0
                      ? `No ${tradeSide.toUpperCase()} shares to sell`
                      : "Enter a share count > 0",
                  });
                  return;
                }
              }

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
                  isBuy: direction === "buy",
                  size: finalSize,
                  orderType,
                  limitPrice,
                  slippageBps: orderType === "market" ? 200 : undefined,
                });
                if (res.success) {
                  setOrderStatus({
                    kind: "success",
                    message: `${direction === "buy" ? "Bought" : "Sold"} ${res.filledSize ?? "?"} @ ${res.avgPrice ?? "?"}¢`,
                  });
                  window.dispatchEvent(new CustomEvent("hlone:trade-filled"));
                } else {
                  setOrderStatus({ kind: "error", message: res.error ?? "Order failed" });
                }
              } catch (err) {
                setOrderStatus({ kind: "error", message: err instanceof Error ? err.message : "Order threw" });
              }
            }}
            className="py-3 mono font-bold mt-1 tracking-wide"
            style={{
              background: direction === "sell"
                ? "transparent"
                : tradeSide === "yes" ? "var(--hl-green)" : "var(--hl-red)",
              color: direction === "sell"
                ? (tradeSide === "yes" ? "var(--hl-green)" : "var(--hl-red)")
                : "var(--background)",
              border: direction === "sell"
                ? `1px solid ${tradeSide === "yes" ? "var(--hl-green)" : "var(--hl-red)"}`
                : "none",
              borderRadius: 6,
              opacity: !isConnected || orderStatus.kind === "pending" || parseFloat(stake) <= 0 ? 0.4 : 1,
              fontSize: "var(--t-body)",
            }}
          >
            {orderStatus.kind === "pending"
              ? "Placing…"
              : isConnected
                ? `${direction === "buy"
                    ? (orderType === "market" ? "Buy" : "Place limit")
                    : "Sell"} ${tradeSide.toUpperCase()} · ${selectedBucket?.label}`
                : "Connect wallet"}
          </button>

          {orderStatus.kind === "success" && (
            <div className="mono" style={{ color: "var(--hl-green)", fontSize: "var(--t-micro)" }}>{orderStatus.message}</div>
          )}
          {orderStatus.kind === "error" && (
            <div className="mono" style={{ color: "var(--hl-red)", fontSize: "var(--t-micro)" }}>{orderStatus.message}</div>
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
