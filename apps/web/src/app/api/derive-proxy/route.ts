/**
 * Derive API proxy — runs as a Vercel serverless function (US region).
 *
 * Derive geo-blocks certain regions (AU, etc.) at the server IP level.
 * This proxy runs on Vercel (US-East by default) so Derive private API
 * calls always originate from a non-restricted IP, regardless of where
 * the Railway backend or the user is located.
 */

import { NextRequest, NextResponse } from "next/server";

const DERIVE_URL = "https://api.lyra.finance";

const ALLOWED_ENDPOINTS = new Set([
  "/private/get_subaccounts",
  "/private/get_subaccount",
  "/private/get_collaterals",
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

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (walletLower) {
      headers["X-LyraWallet"] = walletLower;
    }
    if (authTimestamp) {
      headers["X-LyraTimestamp"] = authTimestamp;
    }
    if (authSignature) {
      headers["X-LyraSignature"] = authSignature;
    }

    // Lowercase wallet in body too
    const fixedBody = body?.wallet && typeof body.wallet === "string"
      ? { ...body, wallet: body.wallet.toLowerCase() }
      : body;

    const res = await fetch(`${DERIVE_URL}${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(fixedBody),
      signal: AbortSignal.timeout(10_000),
    });

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("json")) {
      const text = await res.text();
      return NextResponse.json(
        { error: `Derive API returned ${res.status}`, needsAuth: res.status === 401, detail: text.slice(0, 200) },
        { status: res.status },
      );
    }

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error("[derive-proxy] Failed:", (err as Error).message);
    return NextResponse.json({ error: "Derive API unreachable" }, { status: 502 });
  }
}
