/**
 * POST /api/studio/validate-order
 *
 * API-key + rate-limit gate for Studio deploys. We no longer enforce on-chain
 * fee splits — HL only allows ONE builder per order, and we trust it to pay
 * the builder directly via their own builder code (no middleman). HLOne's
 * revenue comes from the $50 one-time + optional API subscription, not from
 * taking a cut of trades.
 *
 * This endpoint now just:
 *   1. Validates the API key is active (deploy is paid + not revoked)
 *   2. Checks the builder code in the order matches what's registered for this
 *      deploy (so a builder can't silently change their fee/recipient after deploy)
 *   3. Records usage for rate-limit accounting
 *
 * Env vars:
 *   DATABASE_URL          - Postgres for build records lookup
 */

import { NextResponse } from "next/server";

interface OrderValidationRequest {
  /** HLOne API key from Studio deploy */
  apiKey: string;
  /** The order object that would be submitted to HL */
  order: {
    builder?: { b?: string; f?: number };
    [k: string]: unknown;
  };
  /** Wallet placing the order (for rate-limit accounting) */
  userWallet?: string;
}

interface ValidationResult {
  ok: boolean;
  error?: string;
  /** Expected builder address (the deploy's builder wallet) */
  expectedBuilder?: string;
  /** Expected builder fee in tenths of a basis point (HL format) */
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

    // Verify the builder field matches what's registered for this deploy — prevents
    // silent post-deploy fee changes. We allow EITHER the builder's own wallet (with
    // their markup) or no builder field (user opted out via setting markup=0).
    const orderBuilder = (body.order.builder?.b ?? "").toLowerCase();
    const orderFee = body.order.builder?.f ?? 0;
    const expectedBuilder = build.builderWallet.toLowerCase();
    const expectedFee = build.markupBps * 10; // bps → HL's tenth-bps

    if (build.markupBps > 0) {
      if (orderBuilder !== expectedBuilder) {
        return NextResponse.json({
          ok: false,
          error: `Builder field mismatch. Expected ${expectedBuilder}, got ${orderBuilder || "none"}`,
          expectedBuilder,
          expectedFeeTenthBps: expectedFee,
        }, { status: 402 });
      }
      if (orderFee !== expectedFee) {
        return NextResponse.json({
          ok: false,
          error: `Builder fee mismatch. Expected ${expectedFee} (${build.markupBps}bps), got ${orderFee}`,
          expectedBuilder,
          expectedFeeTenthBps: expectedFee,
        }, { status: 402 });
      }
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
  markupBps: number;
  builderWallet: string;
  createdAt: string;
} | null> {
  if (process.env.NODE_ENV !== "production") {
    return {
      deployId: "dev_stub",
      wallet: "0x0000000000000000000000000000000000000000",
      slug: "dev",
      markupBps: 10,
      builderWallet: "0x0000000000000000000000000000000000000000",
      createdAt: new Date().toISOString(),
    };
  }
  return null;
}

async function recordApiUsage(apiKey: string, userWallet?: string): Promise<void> {
  console.log("[validate-order] usage:", apiKey.slice(0, 16) + "...", userWallet?.slice(0, 10));
}
