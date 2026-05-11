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

// HIP-4 outcome markets went live on mainnet. The first (and currently only)
// binary is outcome 20 — "BTC > $80,657 by 2026-05-11 06:00 UTC". HL encodes
// outcome shares in `allMids` and l2Book/recentTrades as "#<outcome><side>":
//   #200 = YES, #201 = NO, etc.
const HIP4_COIN_YES = "#200";
const HIP4_COIN_NO = "#201";

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
  hip4Strike: number | null;
  hip4ExpiryMs: number | null;
  hip4Underlying: string | null;
  // 24h of probability-river candles for #200
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
  const [convictionPct, setConvictionPct] = useState<number | null>(null);

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

  // ── LIVE HIP-4 outcome market on mainnet ────────────────────────
  // outcomeMeta gives us the strike + expiry + underlying.
  // allMids gives the YES mark for "#200".
  // l2Book over WS streams live bids/asks.
  // recentTrades polled every 5s for the tape.
  // candleSnapshot for "#200" is the actual probability-river history.
  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;

    // Parse "class:priceBinary|underlying:BTC|expiry:20260511-0600|targetPrice:80657|period:1d"
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
        // "20260511-0600" → 2026-05-11 06:00 UTC
        const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(expiryStr);
        if (m) {
          expiryMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
        }
      }
      return {
        strike: parts.targetPrice ? parseFloat(parts.targetPrice) : null,
        underlying: parts.underlying ?? null,
        expiryMs,
        klass: parts.class ?? null,
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
          outcomes: { outcome: number; name: string; description: string }[];
        };
        const binary = (data.outcomes ?? []).find((o) =>
          (o.description ?? "").includes("priceBinary"),
        );
        if (!binary || cancelled) return;
        const parsed = parseHip4Desc(binary.description);
        setHyperodd((s) => ({
          ...s,
          hip4Strike: parsed.strike,
          hip4ExpiryMs: parsed.expiryMs,
          hip4Underlying: parsed.underlying,
        }));
      } catch { /* ignore */ }
    };

    const fetchMark = async () => {
      try {
        const res = await fetch(HL_INFO, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "allMids" }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as Record<string, string>;
        const yes = data[HIP4_COIN_YES];
        if (yes && !cancelled) {
          setHyperodd((s) => ({ ...s, mark: parseFloat(yes) }));
        }
      } catch { /* ignore */ }
    };

    const fetchTrades = async () => {
      try {
        const res = await fetch(HL_INFO, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "recentTrades", coin: HIP4_COIN_YES }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as HyperOddTrade[];
        if (cancelled || !Array.isArray(data)) return;
        setHyperodd((s) => ({ ...s, trades: data.slice(0, 20) }));
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
            req: { coin: HIP4_COIN_YES, interval: "15m", startTime: start, endTime: end },
          }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as Candle[];
        if (cancelled || !Array.isArray(data)) return;
        setHyperodd((s) => ({ ...s, marketCandles: data }));
      } catch { /* ignore */ }
    };

    // Initial fetches + intervals
    fetchOutcomeMeta();
    fetchMark();
    fetchTrades();
    fetchCandles();
    const markId = setInterval(fetchMark, 3000);
    const tradeId = setInterval(fetchTrades, 5000);
    const candleId = setInterval(fetchCandles, 60_000);

    // WS for live L2 book updates
    const connectWs = () => {
      if (cancelled) return;
      try {
        ws = new WebSocket(HL_WS);
        ws.onopen = () => {
          ws?.send(
            JSON.stringify({
              method: "subscribe",
              subscription: { type: "l2Book", coin: HIP4_COIN_YES },
            }),
          );
          if (!cancelled) setHyperodd((s) => ({ ...s, wsConnected: true }));
        };
        ws.onmessage = (ev) => {
          if (cancelled) return;
          try {
            const msg = JSON.parse(ev.data);
            if (msg.channel === "l2Book" && msg.data?.coin === HIP4_COIN_YES) {
              const levels = msg.data.levels ?? [[], []];
              setHyperodd((s) => ({
                ...s,
                bids: (levels[0] as BookLevel[]) ?? [],
                asks: (levels[1] as BookLevel[]) ?? [],
              }));
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
  }, []);

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
    const id = setInterval(fetchCompare, 8000);
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

  // synthetic conviction price (from drag) — defaults to current YES
  const userPrice = convictionPct ?? yesCents;
  const userPriceFraction = userPrice / 100;
  const stakeNum = parseFloat(stake) || 0;
  const shares = side === "yes" ? stakeNum / userPriceFraction : stakeNum / (1 - userPriceFraction);
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
          <code className="mono" style={{ color: "var(--hl-accent)" }}>{HIP4_COIN_YES}</code> on HL mainnet. Trade
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
        <CompareStrip yesCents={yesCents} compare={compare} strike={strike} hyperodd={hyperodd} />
      </div>

      {/* main grid */}
      <main className="max-w-[1440px] mx-auto px-4 py-3 grid gap-3" style={{ gridTemplateColumns: "1fr 320px", alignItems: "start" }}>
        <div className="flex flex-col gap-3 min-w-0">
          <RiverChart
            probSeries={probSeries}
            settleTs={settleTs}
            userPrice={userPrice}
            yesCents={yesCents}
            setConvictionPct={setConvictionPct}
            kalshiCents={compare?.kalshi.available && compare.kalshi.last != null ? Math.round(compare.kalshi.last * 100) : null}
            kalshiStrike={compare?.kalshi.matchedStrike ?? null}
            polyCents={compare?.polymarket.available && compare.polymarket.yesPrice != null ? Math.round(compare.polymarket.yesPrice * 100) : null}
            polyStrike={compare?.polymarket.matchedStrike ?? null}
            hyperoddCents={hyperodd.mark != null ? Math.round(hyperodd.mark * 100) : null}
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
            userPrice={userPrice}
            shares={shares}
            maxPayout={maxPayout}
            profit={profit}
            convictionPct={convictionPct}
            setConvictionPct={setConvictionPct}
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
              <code className="mono" style={{ color: "var(--hl-accent)" }}>{HIP4_COIN_YES}</code> — &quot;BTC closes above
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
  settleTs,
  userPrice,
  yesCents,
  setConvictionPct,
  kalshiCents,
  kalshiStrike,
  polyCents,
  polyStrike,
  hyperoddCents,
}: {
  probSeries: { x: number; p: number }[];
  settleTs: number;
  userPrice: number;
  yesCents: number;
  setConvictionPct: (n: number | null) => void;
  kalshiCents: number | null;
  kalshiStrike: number | null;
  polyCents: number | null;
  polyStrike: number | null;
  hyperoddCents: number | null;
}) {
  // map prob series to viewbox 0..800 × 0..360 (top=100¢, bottom=0¢)
  const W = 800;
  const H = 360;
  const points = useMemo(() => {
    if (!probSeries.length) return "";
    const tMin = probSeries[0].x;
    const tMax = settleTs - 15 * 60 * 1000; // right edge ≈ now
    return probSeries
      .map((d) => {
        const x = ((d.x - tMin) / (tMax - tMin)) * W;
        const y = H - d.p * H;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [probSeries, settleTs]);

  const areaPath = useMemo(() => {
    if (!points) return "";
    const pts = points.split(" ");
    return `M ${pts[0]} L ${pts.slice(1).join(" L ")} L ${W},${H} L 0,${H} Z`;
  }, [points]);

  // current end of line position for the dashed projection
  const endY = H - (yesCents / 100) * H;
  const userY = H - (userPrice / 100) * H;
  const kalshiY = kalshiCents != null ? H - (kalshiCents / 100) * H : null;
  const polyY = polyCents != null ? H - (polyCents / 100) * H : null;
  const hyperoddY = hyperoddCents != null ? H - (hyperoddCents / 100) * H : null;

  // click anywhere on the right edge area to set conviction
  const onChartClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const yPx = e.clientY - rect.top;
    const yPct = 100 - (yPx / rect.height) * 100;
    setConvictionPct(Math.max(2, Math.min(98, Math.round(yPct))));
  };

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
        <div className="relative" style={{ height: 360 }} onClick={onChartClick}>
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
            {points && <path d={areaPath} fill="url(#rgrad)" />}
            {points && <polyline fill="none" stroke="#4ade80" strokeWidth="2.2" points={points} />}

            {/* Kalshi reference line (yellow dashed) — last trade price for closest strike */}
            {kalshiY != null && (
              <line x1="0" y1={kalshiY} x2={W} y2={kalshiY} stroke="#f5a524" strokeWidth="1.4" strokeDasharray="6,4" opacity="0.7" />
            )}
            {/* Polymarket reference line (purple dashed) — YES outcome price */}
            {polyY != null && (
              <line x1="0" y1={polyY} x2={W} y2={polyY} stroke="#a371f7" strokeWidth="1.4" strokeDasharray="6,4" opacity="0.7" />
            )}
            {/* HyperOdd testnet reference line (cyan solid) — actual HL prediction-perp mark */}
            {hyperoddY != null && (
              <line x1="0" y1={hyperoddY} x2={W} y2={hyperoddY} stroke="#00f0ff" strokeWidth="1.6" strokeDasharray="2,3" opacity="0.85" />
            )}
          </svg>

          {/* y-axis */}
          <div
            className="absolute right-0 top-0 bottom-4 flex flex-col justify-between items-end mono"
            style={{ width: 32, fontSize: 10, color: "var(--hl-muted)", padding: "2px 6px", pointerEvents: "none" }}
          >
            <span>100¢</span><span>75¢</span><span>50¢</span><span>25¢</span><span>0¢</span>
          </div>

          {/* x-axis */}
          <div
            className="absolute left-0 bottom-0 flex justify-between mono"
            style={{ right: 32, height: 16, fontSize: 9, color: "var(--hl-muted)", paddingTop: 4, borderTop: "1px solid var(--hl-border)" }}
          >
            <span>−24h</span><span>−18h</span><span>−12h</span><span>−6h</span><span>now ▶</span>
          </div>

          {/* dashed forward arc from line end → user thumb */}
          <svg
            className="absolute pointer-events-none"
            style={{ right: 32, top: 0, width: 80, height: "100%" }}
            viewBox={`0 0 80 ${H}`}
            preserveAspectRatio="none"
          >
            <path d={`M0,${endY} C20,${endY - (endY - userY) * 0.3} 40,${userY + (endY - userY) * 0.3} 60,${userY}`}
              stroke="#00f0ff" strokeWidth="1.6" strokeDasharray="3,3" fill="none" opacity="0.7"
            />
          </svg>

          {/* conviction thumb */}
          <div
            className="absolute"
            style={{
              right: 32, width: 14, height: 14, borderRadius: "50%",
              background: "var(--hl-accent)",
              boxShadow: "0 0 12px rgba(0,240,255,0.8), inset 0 0 0 2px var(--background)",
              transform: "translate(50%, -50%)", zIndex: 4,
              top: `${(userY / H) * 100}%`,
              transition: "top 0.12s ease",
            }}
          />
          <div
            className="absolute mono"
            style={{
              right: 50, top: `${(userY / H) * 100}%`,
              padding: "2px 7px", background: "var(--hl-accent)", color: "var(--background)",
              fontSize: 10, fontWeight: 700, borderRadius: 3,
              transform: "translateY(-50%)", whiteSpace: "nowrap", pointerEvents: "none", zIndex: 4,
            }}
          >
            YOU {userPrice}¢
          </div>

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

          {/* HIP-4 live mark label */}
          {hyperoddCents != null && hyperoddY != null && (
            <div
              className="absolute mono"
              style={{
                right: 0, top: `${(hyperoddY / H) * 100}%`,
                padding: "2px 6px", background: "var(--hl-accent)", color: "var(--background)",
                fontSize: 9, fontWeight: 700, borderRadius: 2,
                transform: "translateY(-50%)", whiteSpace: "nowrap", pointerEvents: "none", zIndex: 4,
              }}
              title={`HIP-4 mainnet ${HIP4_COIN_YES} mark`}
            >
              HIP-4 {hyperoddCents}¢
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-3 mt-2 pt-2 text-[10px]" style={{ borderTop: "1px solid var(--hl-border)", color: "var(--hl-muted)" }}>
          <span>Click chart to set conviction · cyan dot = your YES price</span>
          <span style={{ marginLeft: "auto", color: "var(--hl-text)" }}>
            line = implied YES probability over last 24h based on actual BTC closes vs strike
          </span>
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
          live · <span className="mono">{HIP4_COIN_YES}</span> · HIP-4 mainnet · YES side
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
  userPrice,
  shares,
  maxPayout,
  profit,
  convictionPct,
  setConvictionPct,
}: {
  yesCents: number;
  noCents: number;
  stake: string;
  setStake: (s: string) => void;
  side: "yes" | "no";
  setSide: (s: "yes" | "no") => void;
  userPrice: number;
  shares: number;
  maxPayout: number;
  profit: number;
  convictionPct: number | null;
  setConvictionPct: (n: number | null) => void;
}) {
  const edge = userPrice - yesCents;

  return (
    <div className="panel">
      <div className="px-3 py-2 flex items-center" style={{ borderBottom: "1px solid var(--hl-border)" }}>
        <span className="ptitle">Send conviction</span>
        <span className="psub ml-auto">drag dot on chart to set price</span>
      </div>
      <div className="p-3 flex flex-col gap-2">
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
            YES
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
            NO
            <span className="mono text-[14px]">{noCents}¢</span>
          </button>
        </div>

        <div
          className="px-2 py-2 flex items-center gap-2 text-[11px]"
          style={{ background: "rgba(0,240,255,0.06)", border: "1px solid rgba(0,240,255,0.2)" }}
        >
          <span style={{ color: "var(--hl-text)" }}>Your price</span>
          <span className="text-[10px]" style={{ color: "var(--hl-muted)" }}>vs market {yesCents}¢</span>
          <span className="ml-auto mono text-[16px] font-bold" style={{ color: "var(--hl-accent)" }}>{userPrice}¢</span>
          {convictionPct !== null && (
            <button onClick={() => setConvictionPct(null)} className="text-[10px]" style={{ color: "var(--hl-muted)" }}>reset</button>
          )}
        </div>

        <div className="flex items-center gap-2 px-2 py-1.5" style={{ background: "var(--background)", border: "1px solid var(--hl-border)" }}>
          <span className="cellL">Stake</span>
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

        <div className="px-2 py-2" style={{ background: "var(--background)", border: "1px solid var(--hl-border)" }}>
          <SumRow l="Shares" v={shares.toFixed(0)} />
          <SumRow l="Edge vs market" v={`${edge >= 0 ? "+" : ""}${edge}¢`} cls={edge >= 0 ? "text-[var(--hl-accent)]" : "text-[var(--hl-red)]"} />
          <SumRow l="Profit if win" v={`+$${profit.toFixed(2)}`} cls="text-[var(--hl-green)]" />
          <SumRow l="Max payout" v={`$${maxPayout.toFixed(2)}`} total />
        </div>

        <button
          className="py-2.5 text-[13px] font-bold tracking-wide"
          style={{ background: side === "yes" ? "var(--hl-green)" : "var(--hl-red)", color: "#001d0c", border: "none" }}
          onClick={() => alert("Trade execution disabled in prototype.")}
        >
          {side === "yes" ? `Buy ${shares.toFixed(0)} YES @ ${userPrice}¢ →` : `Buy ${shares.toFixed(0)} NO @ ${userPrice}¢ →`}
        </button>
        <div className="text-[9px] text-center tracking-wide" style={{ color: "var(--hl-muted)" }}>
          Synthetic · settles 23:59 UTC · execution disabled
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
}: {
  yesCents: number;
  compare: CompareData | null;
  strike: number | null;
  hyperodd: HyperOddState;
}) {
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
      <span className="cellL" style={{ color: "var(--hl-accent)", fontWeight: 600, letterSpacing: 0.6 }}>
        Cross-venue
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
            <span style={{ color: "var(--hl-muted)", fontSize: 10 }} title={HIP4_COIN_YES}>
              {HIP4_COIN_YES}
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
