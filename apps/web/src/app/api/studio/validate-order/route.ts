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
import { prisma } from "@/lib/prisma";
import crypto from "crypto";

const DEFAULT_BUILDER_WALLET = "0xbB0f753321e2B5FD29Bd1d14b532f5B54959ae63".toLowerCase();
const DEFAULT_BUILDER_FEE_TENTH_BPS = 15; // 0.015%

function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function isProduction(): boolean {
  if (process.env.IS_PRODUCTION === "1") return true;
  if (process.env.VERCEL_ENV) return process.env.VERCEL_ENV === "production";
  return process.env.NODE_ENV === "production";
}

// Very simple in-memory per-apiKey rate limit (60 req/min). An attacker who
// extracts an apiKey can't sustain more than 60 rpm of validation spam.
// (Serverless-friendly: at most a handful of isolates, each gets its own bucket.)
const rateBuckets = new Map<string, number[]>();
function rateAllow(key: string, max = 60, windowMs = 60_000): boolean {
  const now = Date.now();
  const arr = rateBuckets.get(key) ?? [];
  const fresh = arr.filter(t => now - t < windowMs);
  if (fresh.length >= max) {
    rateBuckets.set(key, fresh);
    return false;
  }
  fresh.push(now);
  rateBuckets.set(key, fresh);
  // Opportunistic eviction
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) {
      if (v.length === 0 || now - v[v.length - 1] > windowMs) rateBuckets.delete(k);
      if (rateBuckets.size < 2500) break;
    }
  }
  return true;
}

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

    if (!body.apiKey || !/^hlone_[a-f0-9]{32,}$/.test(body.apiKey)) {
      return NextResponse.json({ ok: false, error: "Missing or invalid API key" }, { status: 401 });
    }

    // Per-apiKey rate limit so a leaked key can't flood the DB.
    if (!rateAllow(body.apiKey)) {
      return NextResponse.json({ ok: false, error: "Rate limited" }, { status: 429 });
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

    await recordApiUsage(build.buildId, body.userWallet);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[validate-order] Error:", err);
    // Generic error — never leak internals to a caller we don't trust.
    return NextResponse.json({ ok: false, error: "Validation failed" }, { status: 500 });
  }
}

// ─── Persistence (Prisma + Postgres) ────────────────────────────────────────

async function lookupBuildByApiKey(apiKey: string): Promise<{
  buildId: string;
  deployId: string;
  wallet: string;
  slug: string;
  createdAt: Date;
} | null> {
  if (!prisma) {
    // Dev mode: allow stub so local flows work. ANY non-local environment
    // (prod or preview) MUST have a DB — Vercel previews were accepting
    // arbitrary `hlone_*` strings because their NODE_ENV is "development",
    // letting attackers bypass the builder-fee check.
    if (isProduction() || process.env.VERCEL_ENV === "preview") return null;
    return {
      buildId: "dev_stub",
      deployId: "dev_stub",
      wallet: "0x0000000000000000000000000000000000000000",
      slug: "dev",
      createdAt: new Date(),
    };
  }
  const build = await prisma.studioBuild.findUnique({
    where: { apiKeyHash: hashApiKey(apiKey) },
    select: { id: true, deployId: true, ownerWallet: true, slug: true, createdAt: true, status: true },
  });
  if (!build || build.status !== "ACTIVE") return null;
  return {
    buildId: build.id,
    deployId: build.deployId,
    wallet: build.ownerWallet,
    slug: build.slug,
    createdAt: build.createdAt,
  };
}

async function recordApiUsage(buildId: string, userWallet?: string, statusCode = 200): Promise<void> {
  if (!prisma || buildId === "dev_stub") return;
  try {
    await prisma.apiUsageEvent.create({
      data: {
        buildId,
        endpoint: "/api/studio/validate-order",
        userWallet: userWallet?.toLowerCase(),
        statusCode,
      },
    });
  } catch (err) {
    console.warn("[validate-order] usage log skipped:", (err as Error).message);
  }
}
