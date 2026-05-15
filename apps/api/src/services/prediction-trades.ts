/**
 * Prediction-trades collector.
 *
 * HL doesn't expose a historical-trades endpoint for HIP-4 outcome contracts.
 * `recentTrades` returns only the last ~30s, and the WS `trades` channel only
 * delivers fills that happen AFTER subscription. So a fresh client load sees
 * an empty/clustered trade history.
 *
 * This service subscribes to HL's WS server-side, accumulates every trade on
 * the active HIP-4 binary into a ring buffer, and re-subscribes when the
 * daily contract rolls (every 06:00 UTC). The /api/market/predict-trades
 * endpoint serves this buffer so clients have a real history regardless of
 * when they opened the page.
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

const MAX_TRADES = 5_000;
const MAX_AGE_MS = 36 * 3600_000; // 36h — covers current contract + prev day overlap

let trades: PredictionTrade[] = [];
const seenTids = new Set<number>();

let activeCoin: string | null = null;
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let rolloverTimer: ReturnType<typeof setInterval> | null = null;

// ─── Discover the current live HIP-4 binary ─────────────────────────────────

async function fetchActiveBinaryCoin(): Promise<string | null> {
  try {
    const res = await fetch(HL_INFO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "outcomeMeta" }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { outcomes?: { outcome: number; description: string }[] };
    const binary = (data.outcomes ?? []).find((o) =>
      (o.description ?? "").includes("priceBinary"),
    );
    if (!binary) return null;
    return `#${binary.outcome}0`; // YES side = #<outcome>0
  } catch (err) {
    console.error("[predict-trades] outcomeMeta fetch failed:", (err as Error).message);
    return null;
  }
}

// ─── WebSocket subscription ─────────────────────────────────────────────────

function pruneOld() {
  const cutoff = Date.now() - MAX_AGE_MS;
  trades = trades.filter((t) => t.time >= cutoff);
  if (trades.length > MAX_TRADES) trades.length = MAX_TRADES;
}

function handleTrades(payload: unknown) {
  if (!Array.isArray(payload) || !activeCoin) return;
  const yesNum = activeCoin.slice(1, -1);
  const coinNo = `#${yesNum}1`;
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
    // Accept both #N0 (YES) and #N1 (NO) trades; coin field preserved.
    if (raw.coin !== activeCoin && raw.coin !== coinNo) continue;
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
  if (!activeCoin) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    if (ws) ws.removeAllListeners();
    const sock = new WebSocket(HL_WS);
    ws = sock;

    sock.on("open", () => {
      if (!activeCoin) return;
      // Subscribe to BOTH YES and NO trade channels for the active outcome.
      // YES coin name is "#<outcome>0"; NO is "#<outcome>1" (flip last char).
      const yesNum = activeCoin.slice(1, -1);
      const coinNo = `#${yesNum}1`;
      console.log(`[predict-trades] WS open, subscribing to ${activeCoin} + ${coinNo}`);
      sock.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin: activeCoin } }));
      sock.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin: coinNo } }));
    });

    sock.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { channel?: string; data?: unknown };
        if (msg.channel === "trades") {
          handleTrades(msg.data);
        }
      } catch { /* ignore */ }
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

async function syncActiveCoin() {
  const next = await fetchActiveBinaryCoin();
  if (!next) return;
  if (next === activeCoin) return;

  // Coin changed — drop the seenTids set (new contract = new tids universe)
  // but keep historical trades for the old contract in the buffer; they'll
  // age out naturally via the 36h prune.
  console.log(`[predict-trades] active coin: ${activeCoin ?? "(none)"} → ${next}`);
  activeCoin = next;
  // Reset only the seen-tids that don't appear in current trades
  // (we still want to dedupe within the same coin if WS reconnects).
  // Simpler: just clear and let the dedupe catch reconnect duplicates.
  seenTids.clear();
  for (const t of trades) seenTids.add(t.tid);

  // Reconnect WS to subscribe to the new coin
  try { ws?.close(); } catch { /* ignore */ }
  connectWs();
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function getPredictionTrades(limit = 500): PredictionTrade[] {
  pruneOld();
  return trades.slice(0, Math.min(limit, trades.length));
}

export function getActivePredictionCoin(): string | null {
  return activeCoin;
}

export async function startPredictionTradesTracking() {
  console.log("[predict-trades] starting collector");
  await syncActiveCoin();
  // Re-check the active contract every 60s — catches the 06:00 UTC daily
  // rollover within a minute of it happening.
  if (rolloverTimer) clearInterval(rolloverTimer);
  rolloverTimer = setInterval(() => {
    syncActiveCoin().catch((err) =>
      console.error("[predict-trades] syncActiveCoin:", (err as Error).message),
    );
  }, 60_000);
}
