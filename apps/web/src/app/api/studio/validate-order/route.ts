/**
 * POST /api/studio/validate-order
 *
 * API-key + anti-tamper gate for Studio deploys. Ensures every order submitted
 * from a Studio build includes HLOne's builder code — so HL's native fee split
 * pays HLOne on every trade.
 *
 * Checks:
 *   1. API key is valid and deploy is active
 *   2. Order's `builder` field = HLONE_BUILDER_WALLET + HLONE_BUILDER_FEE_TENTH_BPS
 *   3. Records usage for rate-limit accounting
 *
 * If a builder tries to strip our fee by modifying their deploy, this endpoint
 * rejects their orders — and losing access to our data API (whale tracking,
 * sharp flow) makes the deploy useless.
 *
 * Env vars:
 *   HLONE_BUILDER_WALLET               - our wallet that collects builder fees
 *   HLONE_BUILDER_FEE_TENTH_BPS        - our fee (default 15 = 0.015%)
 *   DATABASE_URL                       - (later) Postgres for build records
 */

import { NextResponse } from "next/server";

const DEFAULT_BUILDER_WALLET = "0xbB0f753321e2B5FD29Bd1d14b532f5B54959ae63".toLowerCase();
const DEFAULT_BUILDER_FEE_TENTH_BPS = 15; // 0.015%

interface OrderValidationRequest {
  apiKey: string;
  order: {
    builder?: { b?: string; f?: number };
    [k: string]: unknown;
  };
  userWallet?: string;
}

interface ValidationResult {
  ok: boolean;
  error?: string;
  expectedBuilder?: string;
  expectedFeeTenthBps?: number;
}

export async function POST(req: Request): Promise<NextResponse<ValidationResult>> {
  try {
    const body = (await req.json()) as OrderValidationRequest;

    if (!body.apiKey || !body.apiKey.startsWith("hlone_")) {
      return NextResponse.json({ ok: false, error: "Missing or invalid API key" }, { status: 401 });
    }

    const build = await lookupBuildByApiKey(body.apiKey);
    if (!build) {
      return NextResponse.json({ ok: false, error: "Unknown or revoked API key" }, { status: 401 });
    }

    // HLOne's builder fee — HARDCODED to match hl-exchange.ts BUILDER_ADDRESS + BUILDER_FEE.
    // Every Studio deploy MUST route builder fees to our wallet or orders are rejected.
    const expectedBuilder = (process.env.HLONE_BUILDER_WALLET ?? DEFAULT_BUILDER_WALLET).toLowerCase();
    const expectedFee = parseInt(process.env.HLONE_BUILDER_FEE_TENTH_BPS ?? String(DEFAULT_BUILDER_FEE_TENTH_BPS), 10);

    const orderBuilder = (body.order.builder?.b ?? "").toLowerCase();
    const orderFee = body.order.builder?.f ?? 0;

    if (orderBuilder !== expectedBuilder) {
      return NextResponse.json({
        ok: false,
        error: `Builder field must be HLOne's wallet. Expected ${expectedBuilder}, got ${orderBuilder || "none"}. Your deploy may be out of sync with the template.`,
        expectedBuilder,
        expectedFeeTenthBps: expectedFee,
      }, { status: 402 });
    }

    if (orderFee < expectedFee) {
      return NextResponse.json({
        ok: false,
        error: `Builder fee must be >= ${expectedFee} (${expectedFee / 10} bps). Got ${orderFee}.`,
        expectedBuilder,
        expectedFeeTenthBps: expectedFee,
      }, { status: 402 });
    }

    await recordApiUsage(body.apiKey, body.userWallet);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[validate-order] Error:", err);
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}

// ─── Persistence (stubbed — replace with Prisma/Drizzle + Postgres) ────────

async function lookupBuildByApiKey(apiKey: string): Promise<{
  deployId: string;
  wallet: string;
  slug: string;
  createdAt: string;
} | null> {
  if (process.env.NODE_ENV !== "production") {
    return {
      deployId: "dev_stub",
      wallet: "0x0000000000000000000000000000000000000000",
      slug: "dev",
      createdAt: new Date().toISOString(),
    };
  }
  return null;
}

async function recordApiUsage(apiKey: string, userWallet?: string): Promise<void> {
  console.log("[validate-order] usage:", apiKey.slice(0, 16) + "...", userWallet?.slice(0, 10));
}
