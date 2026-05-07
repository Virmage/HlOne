/**
 * Predictions price-comparison proxy.
 *
 * GET /api/predict/compare?strike=83000
 *   → fetches live BTC-daily markets from Kalshi + Polymarket,
 *     finds the closest-matching strike to ours, returns prices.
 *
 * Why server-side: Kalshi/Polymarket don't set CORS headers for browser fetches,
 * and we want a tight 5s cache to avoid hammering them.
 */
import { NextRequest, NextResponse } from "next/server";

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const POLY_BASE = "https://gamma-api.polymarket.com";

interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  floor_strike: number;
  yes_bid_dollars?: string | null;
  yes_ask_dollars?: string | null;
  no_bid_dollars?: string | null;
  no_ask_dollars?: string | null;
  last_price_dollars?: string | null;
  open_interest_fp?: string | null;
  close_time?: string;
}

interface CompareResponse {
  hlImplied?: number; // pre-computed by the client and echoed back, optional
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
    sample?: Array<{ question: string; yesPrice: number; endDate: string; volume24h: number; slug: string }>;
    error?: string;
  };
  fetchedAt: number;
}

// 5-second in-memory cache keyed by strike
const cache = new Map<number, { data: CompareResponse; ts: number }>();
const CACHE_MS = 5_000;

async function fetchKalshi(strike: number): Promise<CompareResponse["kalshi"]> {
  try {
    const res = await fetch(`${KALSHI_BASE}/markets?limit=400&series_ticker=KXBTCD&status=open`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return { available: false, requestedStrike: strike, error: `kalshi ${res.status}` };
    const data = (await res.json()) as { markets?: KalshiMarket[] };
    const markets = data.markets ?? [];
    if (!markets.length) return { available: false, requestedStrike: strike, error: "no markets" };

    // soonest event by close_time
    const events = new Map<string, string>(); // event_ticker -> close_time
    for (const m of markets) {
      if (m.event_ticker && m.close_time) {
        const existing = events.get(m.event_ticker);
        if (!existing || m.close_time < existing) events.set(m.event_ticker, m.close_time);
      }
    }
    const sortedEvents = [...events.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const soonestEvent = sortedEvents[0]?.[0];
    if (!soonestEvent) return { available: false, requestedStrike: strike, error: "no event" };

    const eventMarkets = markets.filter((m) => m.event_ticker === soonestEvent);
    // closest strike — prefer one ≥ our strike if tie
    let best: KalshiMarket | null = null;
    let bestDiff = Infinity;
    for (const m of eventMarkets) {
      if (typeof m.floor_strike !== "number") continue;
      const diff = Math.abs(m.floor_strike - strike);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = m;
      }
    }
    if (!best) return { available: false, requestedStrike: strike, error: "no strike match" };

    const yesBid = best.yes_bid_dollars != null ? parseFloat(best.yes_bid_dollars) : undefined;
    const yesAsk = best.yes_ask_dollars != null ? parseFloat(best.yes_ask_dollars) : undefined;
    const last = best.last_price_dollars != null ? parseFloat(best.last_price_dollars) : undefined;
    const yesMid = yesBid != null && yesAsk != null ? (yesBid + yesAsk) / 2 : undefined;

    return {
      available: true,
      matchedStrike: best.floor_strike,
      requestedStrike: strike,
      yesBid,
      yesAsk,
      yesMid,
      last,
      openInterest: best.open_interest_fp != null ? parseFloat(best.open_interest_fp) : undefined,
      closeTime: best.close_time,
      ticker: best.ticker,
      eventTicker: best.event_ticker,
    };
  } catch (e) {
    return { available: false, requestedStrike: strike, error: e instanceof Error ? e.message : "fetch failed" };
  }
}

async function fetchPolymarket(): Promise<CompareResponse["polymarket"]> {
  try {
    // Pull the active markets list, filter to BTC-related
    const res = await fetch(`${POLY_BASE}/markets?limit=500&active=true&closed=false`, {
      headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (HLOne)" },
      cache: "no-store",
    });
    if (!res.ok) return { available: false, error: `poly ${res.status}` };
    interface PolyMarket {
      question?: string;
      outcomePrices?: string;
      volume24hr?: number | string;
      endDate?: string;
      slug?: string;
    }
    const data = (await res.json()) as PolyMarket[];
    const btc = data.filter(
      (m) => typeof m.question === "string" && /\b(bitcoin|btc)\b/i.test(m.question),
    );
    btc.sort((a, b) => Number(b.volume24hr ?? 0) - Number(a.volume24hr ?? 0));
    const sample = btc.slice(0, 4).map((m) => {
      let yesPrice = NaN;
      try {
        const arr = JSON.parse(m.outcomePrices ?? "[]");
        if (Array.isArray(arr) && arr.length >= 1) yesPrice = parseFloat(arr[0]);
      } catch { /* ignore */ }
      return {
        question: m.question ?? "",
        yesPrice,
        endDate: m.endDate ?? "",
        volume24h: Number(m.volume24hr ?? 0),
        slug: m.slug ?? "",
      };
    });
    return { available: sample.length > 0, sample };
  } catch (e) {
    return { available: false, error: e instanceof Error ? e.message : "fetch failed" };
  }
}

export async function GET(req: NextRequest) {
  const strikeStr = req.nextUrl.searchParams.get("strike");
  const strike = strikeStr ? parseFloat(strikeStr) : NaN;
  if (!Number.isFinite(strike) || strike <= 0) {
    return NextResponse.json({ error: "strike query param required" }, { status: 400 });
  }

  const cached = cache.get(strike);
  if (cached && Date.now() - cached.ts < CACHE_MS) {
    return NextResponse.json(cached.data, {
      headers: { "x-cache": "hit", "cache-control": "public, max-age=5" },
    });
  }

  const [kalshi, polymarket] = await Promise.all([fetchKalshi(strike), fetchPolymarket()]);
  const body: CompareResponse = { kalshi, polymarket, fetchedAt: Date.now() };
  cache.set(strike, { data: body, ts: Date.now() });

  return NextResponse.json(body, {
    headers: { "x-cache": "miss", "cache-control": "public, max-age=5" },
  });
}
