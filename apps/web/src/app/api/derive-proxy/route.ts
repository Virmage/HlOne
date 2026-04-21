/**
 * Derive API proxy — runs as a Vercel Edge Function in a non-restricted region.
 *
 * Derive geo-blocks US, AU, CA, SG(?) and many other regions at the server IP level.
 * We try multiple non-restricted regions. Currently: Hong Kong.
 * This handles both read and write endpoints (create_subaccount, order, etc.).
 */

import { NextRequest, NextResponse } from "next/server";

// Force this function to run in a non-restricted region
export const runtime = "edge";
export const preferredRegion = ["hkg1", "hnd1", "kix1"];

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

export async function POST(req: NextRequest) {
  try {
    const { endpoint, body, wallet, authTimestamp, authSignature } = await req.json();

    if (!endpoint || !ALLOWED_ENDPOINTS.has(endpoint)) {
      return NextResponse.json({ error: "Invalid endpoint" }, { status: 400 });
    }

    // Require a valid-shaped wallet. For endpoints that can move funds or
    // create account-lifecycle entities, also require Derive's session-key
    // signature headers to be present (Derive itself validates them). We
    // refuse to act as a blind relay for anonymous callers.
    if (typeof wallet !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      return NextResponse.json({ error: "Valid wallet required" }, { status: 400 });
    }
    const SENSITIVE_ENDPOINTS = new Set([
      "/private/create_subaccount", "/private/deposit", "/private/order",
      "/private/cancel", "/private/create_account",
    ]);
    if (SENSITIVE_ENDPOINTS.has(endpoint) && (!authTimestamp || !authSignature)) {
      return NextResponse.json({ error: "Derive session signature required" }, { status: 401 });
    }

    const walletLower = wallet.toLowerCase();

    // Header casing matches official Derive Python SDK (X-LYRAWALLET etc.)
    // Origin/Referer mimic browser request to avoid nginx filtering
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Origin": "https://derive.xyz",
      "Referer": "https://derive.xyz/",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    };
    headers["X-LYRAWALLET"] = walletLower;
    if (authTimestamp) {
      headers["X-LYRATIMESTAMP"] = authTimestamp;
    }
    if (authSignature) {
      headers["X-LYRASIGNATURE"] = authSignature;
    }

    // Lowercase wallet in body too
    const fixedBody = body?.wallet && typeof body.wallet === "string"
      ? { ...body, wallet: body.wallet.toLowerCase() }
      : body;

    // Also lowercase signer field if present
    const finalBody = fixedBody?.signer && typeof fixedBody.signer === "string"
      ? { ...fixedBody, signer: fixedBody.signer.toLowerCase() }
      : fixedBody;

    const res = await fetch(`${DERIVE_URL}${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(finalBody),
      signal: AbortSignal.timeout(15_000),
    });

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("json")) {
      // Do NOT log response body — it may contain session keys / signatures.
      return NextResponse.json(
        { error: `Derive API returned ${res.status}`, needsAuth: res.status === 401 },
        { status: res.status },
      );
    }

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    // Log a terse line, not the error's full message (may echo request body).
    if (process.env.NODE_ENV !== "production") {
      console.error("[derive-proxy] Failed:", (err as Error).message);
    }
    return NextResponse.json({ error: "Derive API unreachable" }, { status: 502 });
  }
}
