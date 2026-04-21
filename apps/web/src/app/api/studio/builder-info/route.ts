/**
 * GET /api/studio/builder-info?apiKey=...
 *
 * Returns metadata about a Studio build. Used by forked builder deploys on
 * startup to verify their API key is active + fetch current fee config.
 */

import { NextResponse } from "next/server";
import { prisma, hasDatabase } from "@/lib/prisma";
import crypto from "crypto";

const HLONE_BUILDER_WALLET = (process.env.HLONE_BUILDER_WALLET ?? "0xbB0f753321e2B5FD29Bd1d14b532f5B54959ae63").toLowerCase();
const HLONE_FEE_TENTH_BPS = parseInt(process.env.HLONE_BUILDER_FEE_TENTH_BPS ?? "15", 10); // 0.015% default

function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const apiKey = url.searchParams.get("apiKey");

    if (!apiKey || !apiKey.startsWith("hlone_")) {
      return NextResponse.json({ error: "Missing or invalid apiKey" }, { status: 401 });
    }

    // Dev mode (no DB): return a stub so local testing works
    if (!hasDatabase()) {
      if (process.env.NODE_ENV === "production") {
        // In prod without a DB, every API key is invalid — fail loudly instead of
        // returning stub data that would misconfigure forked deploys' fee routing.
        return NextResponse.json(
          { error: "Studio database not configured. Contact the platform operator." },
          { status: 503 },
        );
      }
      return NextResponse.json({
        deployId: "dev_stub",
        slug: "dev",
        name: "Dev Build",
        builderWallet: HLONE_BUILDER_WALLET,
        markupBps: 0,
        hloneFeeTenthBps: HLONE_FEE_TENTH_BPS,
        hloneBuilderWallet: HLONE_BUILDER_WALLET,
      });
    }

    const build = await prisma!.studioBuild.findUnique({
      where: { apiKeyHash: hashApiKey(apiKey) },
      select: {
        deployId: true, slug: true, name: true, builderWallet: true,
        markupBps: true, status: true,
      },
    });

    if (!build || build.status !== "ACTIVE") {
      return NextResponse.json({ error: "Unknown or revoked API key" }, { status: 401 });
    }

    return NextResponse.json({
      deployId: build.deployId,
      slug: build.slug,
      name: build.name,
      builderWallet: build.builderWallet,
      markupBps: build.markupBps,
      hloneFeeTenthBps: HLONE_FEE_TENTH_BPS,
      hloneBuilderWallet: HLONE_BUILDER_WALLET,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
