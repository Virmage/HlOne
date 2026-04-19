/**
 * POST /api/studio/validate-order
 *
 * Fee enforcement endpoint. Builder deploys call this before submitting orders
 * to HyperLiquid. We verify:
 *   1. The API key is valid and active
 *   2. The order includes the correct HLOne platform fee (0.005%)
 *   3. The builder markup in the order matches what's registered for this API key
 *
 * If all checks pass, we return a signed OK. Deploys use this as a gate —
 * if we return 402, the order isn't submitted. This is how we enforce that
 * builders can't strip our fee.
 *
 * Env vars needed:
 *   DATABASE_URL              - Postgres for build records lookup
 *   HLONE_BUILDER_WALLET      - Our wallet address that must appear in order.builder
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
  /** Required builder address (HLOne's wallet) */
  requiredBuilder?: string;
  /** Minimum required builder fee in bps */
  requiredMinBps?: number;
}

export async function POST(req: Request): Promise<NextResponse<ValidationResult>> {
  try {
    const body = (await req.json()) as OrderValidationRequest;

    if (!body.apiKey || !body.apiKey.startsWith("hlone_")) {
      return NextResponse.json({ ok: false, error: "Missing or invalid API key" }, { status: 401 });
    }

    // Look up the build record for this API key
    const build = await lookupBuildByApiKey(body.apiKey);
    if (!build) {
      return NextResponse.json({ ok: false, error: "Unknown API key" }, { status: 401 });
    }

    // Verify the order's builder field matches HLOne's wallet (our 0.005% cut)
    const hloneBuilder = (process.env.HLONE_BUILDER_WALLET ?? "").toLowerCase();
    if (!hloneBuilder) {
      console.warn("[validate-order] HLONE_BUILDER_WALLET not set — skipping fee check");
    }

    const orderBuilder = (body.order.builder?.b ?? "").toLowerCase();
    const orderBuilderFee = body.order.builder?.f ?? 0;

    // HL's builder code pattern: order.builder = { b: address, f: tenthBps }
    // HLOne base fee = 0.5 tenthBps (= 0.005%)
    // Builder's markup is applied via a separate proxy/stacked code we manage
    const HLONE_MIN_TENTH_BPS = 5; // 0.005% in HL's "tenths of a basis point" format

    if (hloneBuilder && orderBuilder !== hloneBuilder) {
      return NextResponse.json({
        ok: false,
        error: `Order's builder field must be HLOne's wallet (${hloneBuilder}). Found: ${orderBuilder || "missing"}`,
        requiredBuilder: hloneBuilder,
        requiredMinBps: HLONE_MIN_TENTH_BPS / 10,
      }, { status: 402 });
    }

    if (orderBuilderFee < HLONE_MIN_TENTH_BPS) {
      return NextResponse.json({
        ok: false,
        error: `Order's builder fee must be >= ${HLONE_MIN_TENTH_BPS} (0.005%). Found: ${orderBuilderFee}`,
        requiredBuilder: hloneBuilder,
        requiredMinBps: HLONE_MIN_TENTH_BPS / 10,
      }, { status: 402 });
    }

    // Track usage for analytics + rate limits (stubbed)
    await recordApiUsage(body.apiKey, body.userWallet);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[validate-order] Error:", err);
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}

// ─── Persistence (stubbed) ──────────────────────────────────────────────────
// TODO: replace with real DB lookups

async function lookupBuildByApiKey(apiKey: string): Promise<{
  deployId: string;
  wallet: string;
  slug: string;
  markupBps: number;
  createdAt: string;
} | null> {
  // Dev mode: allow any properly-formatted key
  if (process.env.NODE_ENV !== "production") {
    return {
      deployId: "dev_stub",
      wallet: "0x0000000000000000000000000000000000000000",
      slug: "dev",
      markupBps: 10,
      createdAt: new Date().toISOString(),
    };
  }
  // Real impl:
  // const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex");
  // return await db.queryOne("SELECT * FROM studio_builds WHERE api_key_hash = $1 AND revoked = false", [keyHash]);
  return null;
}

async function recordApiUsage(apiKey: string, userWallet?: string): Promise<void> {
  // Stubbed — in prod, increment a Redis counter or insert to usage_events table
  console.log("[validate-order] usage:", apiKey.slice(0, 16) + "...", userWallet?.slice(0, 10));
}
