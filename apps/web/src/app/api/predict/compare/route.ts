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
    matchedStrike?: number;
    requestedStrike: number;
    yesPrice?: number; // the YES outcome price (0..1)
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

async function fetchPolymarket(strike: number): Promise<CompareResponse["polymarket"]> {
  try {
    // Polymarket organises strike-ladder markets inside an Event:
    //   "Bitcoin above ___ on May 7?" → 11 child markets at $66k/68k/.../102k.
    // We scan events sorted by 24h volume for the soonest BTC-daily-strike
    // event, then pick the closest strike within it.
    interface PolyEvent {
      title?: string;
      slug?: string;
      endDate?: string;
      volume24hr?: number | string;
      markets?: Array<{
        question?: string;
        outcomePrices?: string;
        slug?: string;
      }>;
    }
    const res = await fetch(
      `${POLY_BASE}/events?limit=200&active=true&closed=false&order=volume24hr&ascending=false`,
      {
        headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (HLOne)" },
        cache: "no-store",
      },
    );
    if (!res.ok) return { available: false, requestedStrike: strike, error: `poly ${res.status}` };
    const data = (await res.json()) as PolyEvent[];
    if (!Array.isArray(data)) return { available: false, requestedStrike: strike, error: "bad shape" };

    // Find events titled like "Bitcoin above ___ on <date>?" — that's the daily
    // strike-ladder format. Prefer the one with the soonest endDate.
    const dailyEvents = data.filter(
      (e) =>
        typeof e.title === "string" &&
        /bitcoin\s+above\s+___\s+on/i.test(e.title) &&
        Array.isArray(e.markets) &&
        e.markets.length > 0,
    );
    dailyEvents.sort((a, b) => (a.endDate ?? "").localeCompare(b.endDate ?? ""));
    const soonest = dailyEvents[0];

    if (!soonest) {
      // Fallback: nearest "Bitcoin reach $X" weekly event
      const weeklyEvents = data.filter(
        (e) =>
          typeof e.title === "string" &&
          /what\s+price\s+will\s+bitcoin\s+hit/i.test(e.title) &&
          Array.isArray(e.markets) &&
          e.markets.length > 0,
      );
      weeklyEvents.sort((a, b) => (a.endDate ?? "").localeCompare(b.endDate ?? ""));
      const wk = weeklyEvents[0];
      if (!wk) return { available: false, requestedStrike: strike, error: "no daily/weekly event" };
      return matchStrikeInEvent(wk, strike);
    }

    return matchStrikeInEvent(soonest, strike);
  } catch (e) {
    return { available: false, requestedStrike: strike, error: e instanceof Error ? e.message : "fetch failed" };
  }
}

function matchStrikeInEvent(
  event: {
    title?: string;
    slug?: string;
    endDate?: string;
    volume24hr?: number | string;
    markets?: Array<{ question?: string; outcomePrices?: string; slug?: string }>;
  },
  strike: number,
): CompareResponse["polymarket"] {
  const markets = event.markets ?? [];
  if (!markets.length) return { available: false, requestedStrike: strike, error: "no child markets" };

  // Parse the strike out of each market question; e.g.
  //   "Will the price of Bitcoin be above $82,000 on May 7?" → 82000
  //   "Will Bitcoin reach $115,000 in May?" → 115000
  const parsed = markets
    .map((m) => {
      const q = m.question ?? "";
      const match = q.match(/\$([\d,]+)/);
      if (!match) return null;
      const s = parseFloat(match[1].replace(/,/g, ""));
      if (!Number.isFinite(s)) return null;
      let yes = NaN;
      try {
        const arr = JSON.parse(m.outcomePrices ?? "[]");
        if (Array.isArray(arr) && arr.length >= 1) yes = parseFloat(arr[0]);
      } catch { /* ignore */ }
      return { strike: s, yes, slug: m.slug ?? "", question: q };
    })
    .filter((x): x is { strike: number; yes: number; slug: string; question: string } => x !== null);

  if (!parsed.length) return { available: false, requestedStrike: strike, error: "no parseable strikes" };

  parsed.sort((a, b) => Math.abs(a.strike - strike) - Math.abs(b.strike - strike));
  const best = parsed[0];

  return {
    available: Number.isFinite(best.yes),
    matchedStrike: best.strike,
    requestedStrike: strike,
    yesPrice: Number.isFinite(best.yes) ? best.yes : undefined,
    eventTitle: event.title,
    marketQuestion: best.question,
    eventEndDate: event.endDate,
    eventSlug: event.slug,
    marketSlug: best.slug,
    eventVolume24h: Number(event.volume24hr ?? 0),
  };
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

  const [kalshi, polymarket] = await Promise.all([fetchKalshi(strike), fetchPolymarket(strike)]);
  const body: CompareResponse = { kalshi, polymarket, fetchedAt: Date.now() };
  cache.set(strike, { data: body, ts: Date.now() });

  return NextResponse.json(body, {
    headers: { "x-cache": "miss", "cache-control": "public, max-age=5" },
  });
}
