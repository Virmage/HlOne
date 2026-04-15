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

    const walletLower = wallet?.toLowerCase();

    // Header casing matches official Derive Python SDK (X-LYRAWALLET etc.)
    // Origin/Referer mimic browser request to avoid nginx filtering
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Origin": "https://derive.xyz",
      "Referer": "https://derive.xyz/",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    };
    if (walletLower) {
      headers["X-LYRAWALLET"] = walletLower;
    }
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

    console.log(`[derive-proxy] ${endpoint} wallet=${walletLower?.slice(0, 10)} hasAuth=${!!authTimestamp}`);

    const res = await fetch(`${DERIVE_URL}${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(finalBody),
      signal: AbortSignal.timeout(15_000),
    });

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("json")) {
      const text = await res.text();
      console.log(`[derive-proxy] ${endpoint} non-JSON ${res.status}: ${text.slice(0, 100)}`);
      return NextResponse.json(
        { error: `Derive API returned ${res.status}`, needsAuth: res.status === 401, detail: text.slice(0, 200) },
        { status: res.status },
      );
    }

    const data = await res.json();
    console.log(`[derive-proxy] ${endpoint} ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error("[derive-proxy] Failed:", (err as Error).message);
    return NextResponse.json({ error: "Derive API unreachable" }, { status: 502 });
  }
}
