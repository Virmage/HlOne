/**
 * Derive API proxy — Cloudflare Worker
 *
 * Derive blocks cloud provider IPs (AWS, Vercel, etc.) but not Cloudflare's edge.
 * This worker proxies authenticated requests to api.lyra.finance.
 */

const DERIVE_URL = "https://api.lyra.finance";

const ALLOWED_ENDPOINTS = new Set([
  "/public/create_account",
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

// CORS headers for browser access
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request: Request): Promise<Response> {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405, headers: corsHeaders });
    }

    try {
      const { endpoint, body, wallet, authTimestamp, authSignature } = await request.json() as {
        endpoint: string;
        body: Record<string, unknown>;
        wallet?: string;
        authTimestamp?: string;
        authSignature?: string;
      };

      if (!endpoint || !ALLOWED_ENDPOINTS.has(endpoint)) {
        return Response.json({ error: "Invalid endpoint" }, { status: 400, headers: corsHeaders });
      }

      const walletLower = wallet?.toLowerCase();

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (walletLower) headers["X-LYRAWALLET"] = walletLower;
      if (authTimestamp) headers["X-LYRATIMESTAMP"] = authTimestamp;
      if (authSignature) headers["X-LYRASIGNATURE"] = authSignature;

      // Lowercase wallet + signer fields in body
      let fixedBody = body;
      if (fixedBody?.wallet && typeof fixedBody.wallet === "string") {
        fixedBody = { ...fixedBody, wallet: (fixedBody.wallet as string).toLowerCase() };
      }
      if (fixedBody?.signer && typeof fixedBody.signer === "string") {
        fixedBody = { ...fixedBody, signer: (fixedBody.signer as string).toLowerCase() };
      }

      const res = await fetch(`${DERIVE_URL}${endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify(fixedBody),
      });

      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("json")) {
        const text = await res.text();
        return Response.json(
          { error: `Derive API returned ${res.status}`, detail: text.slice(0, 200) },
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
  },
};
