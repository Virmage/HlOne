/**
 * Derive API proxy — Cloudflare Worker
 *
 * Derive geo-blocks certain regions (AU, JP, etc.) on private/login endpoints.
 * Public WS endpoints work everywhere, but `public/login` checks IP region.
 *
 * This worker proxies WebSocket connections to wss://api.lyra.finance/ws
 * so the geo-check sees Cloudflare's edge IP (US/EU) instead of the user's IP.
 *
 * Also supports HTTP POST proxying for REST endpoints.
 */

const DERIVE_WS_URL = "wss://api.lyra.finance/ws";
const DERIVE_HTTP_URL = "https://api.lyra.finance";

// CORS headers for browser access
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Upgrade, Connection",
};

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ─── WebSocket upgrade ──────────────────────────────────────────────
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader?.toLowerCase() === "websocket") {
      return handleWebSocket(request);
    }

    // ─── HTTP POST proxy (legacy, for non-WS endpoints) ────────────────
    if (request.method === "POST") {
      return handleHttpPost(request);
    }

    // Health check
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(
        JSON.stringify({ status: "ok", proxy: "derive-ws-proxy", ws: "/ws" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return Response.json(
      { error: "Method not allowed. Use WebSocket upgrade or POST." },
      { status: 405, headers: corsHeaders },
    );
  },
};

// ─── WebSocket proxy ─────────────────────────────────────────────────────────
// Browser connects to this worker via WebSocket.
// Worker connects to Derive's WS and relays messages bidirectionally.

async function handleWebSocket(_request: Request): Promise<Response> {
  // Create a WebSocket pair: client ↔ server
  const [clientWs, serverWs] = Object.values(new WebSocketPair());

  // Connect to Derive's upstream WebSocket
  const deriveWs = new WebSocket(DERIVE_WS_URL);

  // Accept the server side so we can send/receive
  serverWs.accept();

  let deriveReady = false;
  const pendingMessages: string[] = [];

  // When Derive upstream opens, flush any queued messages
  deriveWs.addEventListener("open", () => {
    deriveReady = true;
    for (const msg of pendingMessages) {
      deriveWs.send(msg);
    }
    pendingMessages.length = 0;
  });

  // Relay: browser → Derive
  serverWs.addEventListener("message", (event) => {
    const data = typeof event.data === "string" ? event.data : "";
    if (deriveReady) {
      deriveWs.send(data);
    } else {
      pendingMessages.push(data);
    }
  });

  // Relay: Derive → browser
  deriveWs.addEventListener("message", (event) => {
    try {
      const data = typeof event.data === "string" ? event.data : "";
      serverWs.send(data);
    } catch {
      // Client may have disconnected
    }
  });

  // Handle close from browser
  serverWs.addEventListener("close", (event) => {
    try {
      deriveWs.close(event.code, event.reason);
    } catch {
      // Already closed
    }
  });

  // Handle close from Derive
  deriveWs.addEventListener("close", (event) => {
    try {
      serverWs.close(event.code, event.reason);
    } catch {
      // Already closed
    }
  });

  // Handle errors
  deriveWs.addEventListener("error", () => {
    try {
      serverWs.close(1011, "Upstream error");
    } catch {
      // Already closed
    }
  });

  serverWs.addEventListener("error", () => {
    try {
      deriveWs.close(1011, "Client error");
    } catch {
      // Already closed
    }
  });

  // Return the client side of the WebSocket pair with 101 Switching Protocols
  return new Response(null, {
    status: 101,
    webSocket: clientWs,
  });
}

// ─── HTTP POST proxy (unchanged from original) ──────────────────────────────

const ALLOWED_ENDPOINTS = new Set([
  "/public/create_account",
  "/public/get_instruments",
  "/public/get_ticker",
  "/private/create_account",
  "/private/get_account",
  "/private/get_subaccounts",
  "/private/get_subaccount",
  "/private/get_collaterals",
  "/private/get_positions",
  "/private/get_open_orders",
  "/private/create_subaccount",
  "/private/deposit",
  "/private/order",
  "/private/cancel",
]);

async function handleHttpPost(request: Request): Promise<Response> {
  try {
    const { endpoint, body, wallet, authTimestamp, authSignature } =
      (await request.json()) as {
        endpoint: string;
        body: Record<string, unknown>;
        wallet?: string;
        authTimestamp?: string;
        authSignature?: string;
      };

    if (!endpoint || !ALLOWED_ENDPOINTS.has(endpoint)) {
      return Response.json(
        { error: "Invalid endpoint" },
        { status: 400, headers: corsHeaders },
      );
    }

    const walletLower = wallet?.toLowerCase();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (walletLower) headers["X-LYRAWALLET"] = walletLower;
    if (authTimestamp) headers["X-LYRATIMESTAMP"] = authTimestamp;
    if (authSignature) headers["X-LYRASIGNATURE"] = authSignature;

    let fixedBody = body;
    if (fixedBody?.wallet && typeof fixedBody.wallet === "string") {
      fixedBody = {
        ...fixedBody,
        wallet: (fixedBody.wallet as string).toLowerCase(),
      };
    }
    if (fixedBody?.signer && typeof fixedBody.signer === "string") {
      fixedBody = {
        ...fixedBody,
        signer: (fixedBody.signer as string).toLowerCase(),
      };
    }

    const res = await fetch(`${DERIVE_HTTP_URL}${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(fixedBody),
    });

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("json")) {
      const text = await res.text();
      return Response.json(
        {
          error: `Derive API returned ${res.status}`,
          detail: text.slice(0, 200),
        },
        { status: res.status, headers: corsHeaders },
      );
    }

    const data = await res.json();
    return Response.json(data, { status: res.status, headers: corsHeaders });
  } catch (err) {
    return Response.json(
      { error: "Derive API unreachable", detail: (err as Error).message },
      { status: 502, headers: corsHeaders },
    );
  }
}
