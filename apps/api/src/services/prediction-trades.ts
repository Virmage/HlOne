/**
 * Prediction-trades collector.
 *
 * HL doesn't expose a historical-trades endpoint for HIP-4 outcome contracts.
 * `recentTrades` returns only the last ~30s, and the WS `trades` channel only
 * delivers fills that happen AFTER subscription. So a fresh client load sees
 * an empty/clustered trade history.
 *
 * This service subscribes to HL's WS server-side, accumulates every trade on
 * EVERY active HIP-4 outcome into a ring buffer, and re-subscribes when the
 * daily contracts roll (every 06:00 UTC). The /api/market/predict-trades
 * endpoint serves this buffer so clients have a real history regardless of
 * when they opened the page.
 *
 * Markets currently exposed by HL:
 *   - priceBinary outcome (e.g. #400/#401)  — "BTC > $X by expiry?"
 *   - priceBucket question with N named outcomes (e.g. #420…#440)
 *     "Which range does BTC close in?"
 *
 * We subscribe to every coin we discover so the client can switch markets
 * without re-warming the buffer.
 */

import WebSocket from "ws";

const HL_INFO = "https://api.hyperliquid.xyz/info";
const HL_WS = "wss://api.hyperliquid.xyz/ws";

export interface PredictionTrade {
  coin: string;     // e.g. "#400" (the live binary YES coin)
  side: string;     // "B" or "A"
  px: number;       // YES price 0..1
  sz: number;       // shares
  usd: number;      // px × sz
  time: number;     // unix ms
  tid: number;      // trade id from HL
  hash?: string;
}

// ─── Storage ────────────────────────────────────────────────────────────────

const MAX_TRADES = 10_000;          // 2× larger now that we track multiple markets
const MAX_AGE_MS = 36 * 3600_000;   // 36h — covers current contract + prev day overlap

let trades: PredictionTrade[] = [];
const seenTids = new Set<number>();

// All HIP-4 coins we're currently subscribed to (YES + NO across binary and
// every bucket outcome). The client can filter by coin when it queries.
let activeCoins: Set<string> = new Set();
// Identifier we compare in syncActiveCoins() to know when the set rolled —
// concatenated sorted-coin-list. Cheap and bullet-proof.
let activeCoinsKey = "";

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let rolloverTimer: ReturnType<typeof setInterval> | null = null;

// ─── Discover the current live HIP-4 outcomes ───────────────────────────────

/**
 * Returns the full list of YES/NO coins for every active HIP-4 outcome —
 * the binary one AND every named outcome inside the bucket question.
 */
async function fetchActiveCoins(): Promise<{ coins: Set<string>; primary: string | null }> {
  try {
    const res = await fetch(HL_INFO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "outcomeMeta" }),
    });
    if (!res.ok) return { coins: new Set(), primary: null };
    const data = (await res.json()) as {
      outcomes?: { outcome: number; description: string }[];
      questions?: { question: number; description: string; namedOutcomes: number[]; fallbackOutcome?: number }[];
    };

    const coins = new Set<string>();
    let primary: string | null = null;

    // 1. The binary outcome (single YES/NO market).
    const binary = (data.outcomes ?? []).find((o) =>
      (o.description ?? "").includes("priceBinary"),
    );
    if (binary) {
      coins.add(`#${binary.outcome}0`); // YES
      coins.add(`#${binary.outcome}1`); // NO
      primary = `#${binary.outcome}0`;
    }

    // 2. Every named outcome of every priceBucket question. The bucket
    // outcomes have description like `index:0`, but the question's
    // description carries the priceBucket / thresholds metadata.
    for (const q of data.questions ?? []) {
      if (!(q.description ?? "").includes("priceBucket")) continue;
      for (const outcomeId of q.namedOutcomes ?? []) {
        coins.add(`#${outcomeId}0`);
        coins.add(`#${outcomeId}1`);
      }
      // Subscribe to the fallback outcome too — fills there are rare but
      // we should still capture them if they happen.
      if (q.fallbackOutcome != null) {
        coins.add(`#${q.fallbackOutcome}0`);
        coins.add(`#${q.fallbackOutcome}1`);
      }
    }

    return { coins, primary };
  } catch (err) {
    console.error("[predict-trades] outcomeMeta fetch failed:", (err as Error).message);
    return { coins: new Set(), primary: null };
  }
}

// ─── WebSocket subscription ─────────────────────────────────────────────────

function pruneOld() {
  const cutoff = Date.now() - MAX_AGE_MS;
  trades = trades.filter((t) => t.time >= cutoff);
  if (trades.length > MAX_TRADES) trades.length = MAX_TRADES;
}

function handleTrades(payload: unknown) {
  if (!Array.isArray(payload) || activeCoins.size === 0) return;
  let appended = 0;
  for (const raw of payload as Array<{
    coin?: string;
    side?: string;
    px?: string;
    sz?: string;
    time?: number;
    tid?: number;
    hash?: string;
  }>) {
    if (!raw) continue;
    // Only accept trades for coins we're tracking — defence against HL
    // sending us cross-channel noise.
    if (!raw.coin || !activeCoins.has(raw.coin)) continue;
    if (typeof raw.tid !== "number" || seenTids.has(raw.tid)) continue;
    if (typeof raw.px !== "string" || typeof raw.sz !== "string") continue;
    const px = parseFloat(raw.px);
    const sz = parseFloat(raw.sz);
    if (!Number.isFinite(px) || !Number.isFinite(sz)) continue;
    const trade: PredictionTrade = {
      coin: raw.coin,
      side: raw.side ?? "B",
      px,
      sz,
      usd: px * sz,
      time: raw.time ?? Date.now(),
      tid: raw.tid,
      hash: raw.hash,
    };
    seenTids.add(trade.tid);
    trades.unshift(trade); // newest first
    appended++;
  }
  if (appended > 0) {
    pruneOld();
    // bound seenTids to avoid unbounded growth across long uptime
    if (seenTids.size > 50_000) {
      const keep = new Set<number>();
      for (const t of trades) keep.add(t.tid);
      seenTids.clear();
      for (const tid of keep) seenTids.add(tid);
    }
  }
}

function connectWs() {
  if (activeCoins.size === 0) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    if (ws) ws.removeAllListeners();
    const sock = new WebSocket(HL_WS);
    ws = sock;

    sock.on("open", () => {
      if (activeCoins.size === 0) return;
      const coinList = [...activeCoins].sort();
      console.log(`[predict-trades] WS open, subscribing to ${coinList.length} coins: ${coinList.join(", ")}`);
      for (const coin of coinList) {
        sock.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin } }));
      }
    });

    sock.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { channel?: string; data?: unknown };
        if (msg.channel === "trades") {
          try {
            handleTrades(msg.data);
          } catch (err) {
            // Inner catch: a malformed trade payload should NEVER crash the
            // process — log it and keep the WS listener alive.
            console.error("[predict-trades] handleTrades threw:", (err as Error).message);
          }
        }
      } catch (err) {
        // Outer catch: JSON parse errors / unexpected payload shapes.
        console.error("[predict-trades] message parse failed:", (err as Error).message);
      }
    });

    sock.on("close", () => {
      console.log("[predict-trades] WS closed, reconnect in 3s");
      reconnectTimer = setTimeout(connectWs, 3_000);
    });

    sock.on("error", (err) => {
      console.error("[predict-trades] WS error:", (err as Error).message);
      try { sock.close(); } catch { /* ignore */ }
    });
  } catch (err) {
    console.error("[predict-trades] WS connect failed:", (err as Error).message);
    reconnectTimer = setTimeout(connectWs, 3_000);
  }
}

async function syncActiveCoins() {
  const { coins: next } = await fetchActiveCoins();
  if (next.size === 0) return;
  const nextKey = [...next].sort().join(",");
  if (nextKey === activeCoinsKey) return;

  console.log(`[predict-trades] active coins changed: ${activeCoinsKey || "(none)"} → ${nextKey}`);
  activeCoins = next;
  activeCoinsKey = nextKey;
  // Coin set changed — old tids may collide with new contract tids on
  // rollover. Clear and let the WS dedupe handle reconnect duplicates.
  seenTids.clear();
  for (const t of trades) seenTids.add(t.tid);

  // Reconnect WS to subscribe to the new coin set
  try { ws?.close(); } catch { /* ignore */ }
  connectWs();
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function getPredictionTrades(limit = 500): PredictionTrade[] {
  pruneOld();
  return trades.slice(0, Math.min(limit, trades.length));
}

/**
 * Trades filtered to a specific coin (caller passes "#400", "#401",
 * "#420", etc.) — saves the client doing the filtering when it only
 * cares about one market.
 */
export function getPredictionTradesForCoin(coin: string, limit = 500): PredictionTrade[] {
  pruneOld();
  const filtered = trades.filter((t) => t.coin === coin);
  return filtered.slice(0, Math.min(limit, filtered.length));
}

/**
 * Snapshot of which coins we're currently subscribed to. Mostly for
 * debugging / health endpoints.
 */
export function getActivePredictionCoins(): string[] {
  return [...activeCoins].sort();
}

/**
 * Back-compat with the old single-coin API — returns the primary
 * binary's YES coin (which is what callers used to use).
 */
export function getActivePredictionCoin(): string | null {
  for (const c of activeCoins) {
    // First #N0 we find that's NOT one of the bucket-style outcomes — but
    // we can't know without parsing. The primary binary is captured
    // separately during sync; expose it via a closure if a caller needs
    // it. For now, simplest: return the lowest-numbered #N0 coin we have.
    if (c.endsWith("0")) {
      const lowest = [...activeCoins].filter((x) => x.endsWith("0")).sort()[0];
      return lowest ?? null;
    }
  }
  return null;
}

export async function startPredictionTradesTracking() {
  console.log("[predict-trades] starting collector");
  await syncActiveCoins();
  // Re-check the active contract every 60s — catches the 06:00 UTC daily
  // rollover within a minute of it happening.
  if (rolloverTimer) clearInterval(rolloverTimer);
  rolloverTimer = setInterval(() => {
    syncActiveCoins().catch((err) =>
      console.error("[predict-trades] syncActiveCoins:", (err as Error).message),
    );
  }, 60_000);
}
