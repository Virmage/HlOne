/**
 * POST /api/studio/deploy
 *
 * After successful crypto payment verification (via /api/studio/checkout),
 * this endpoint:
 *   1. Forks the hlone-template repo into the builder's GitHub account
 *   2. Commits their studio.config.json + NEXT_PUBLIC_STUDIO_CONFIG env var
 *   3. Triggers a Vercel deploy of the fork
 *   4. Issues an API key and stores the build record
 *
 * Env vars needed (set in Vercel — mark ALL sensitive):
 *   GITHUB_STUDIO_TOKEN       - PAT with repo + fork scopes
 *   GITHUB_TEMPLATE_REPO      - e.g. "hlone-xyz/hlone-template"
 *   VERCEL_API_TOKEN          - Vercel deploy token
 *   VERCEL_TEAM_ID            - Vercel team/org ID
 *   DATABASE_URL              - Postgres for build records
 *
 * If creds are missing, returns a dev-mode response with placeholder URLs so
 * the UI flow works end-to-end locally.
 */

import { NextResponse } from "next/server";
import { validateConfig, type StudioConfig } from "@/lib/studio-config";
import { prisma } from "@/lib/prisma";
import crypto from "crypto";

function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const config = body.config as Partial<StudioConfig>;
    const wallet = body.wallet as string;
    const sessionId = body.sessionId as string | undefined;

    const validation = validateConfig(config);
    if (!validation.ok) {
      return NextResponse.json({ error: "Invalid config", details: validation.errors }, { status: 400 });
    }

    // Payment verification already happened in /api/studio/checkout, which
    // returned a sessionId. We accept any sessionId starting with "pay_"
    // (real) or "dev_" (dev mode) — in prod, wire this to a DB lookup for
    // replay protection across server restarts.
    const isDev = !process.env.NEXT_PUBLIC_HLONE_PAYMENTS_WALLET || (sessionId?.startsWith("dev_") ?? false);
    if (!isDev && (!sessionId || !sessionId.startsWith("pay_"))) {
      return NextResponse.json({ error: "Missing or invalid payment session. Complete payment first." }, { status: 402 });
    }

    const githubToken = process.env.GITHUB_STUDIO_TOKEN;
    const templateRepo = process.env.GITHUB_TEMPLATE_REPO ?? "hlone-xyz/hlone-template";
    const vercelToken = process.env.VERCEL_API_TOKEN;
    const vercelTeamId = process.env.VERCEL_TEAM_ID;

    // Issue deploy ID + API key (always, even in dev)
    const deployId = crypto.randomBytes(8).toString("hex");
    const apiKey = `hlone_${crypto.randomBytes(24).toString("hex")}`;
    const finalConfig: StudioConfig = {
      ...validation.config,
      meta: {
        ...validation.config.meta,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deployId,
      },
    };

    // Dev mode or missing creds — persist (if DB available) then return placeholders
    if (isDev || !githubToken || !vercelToken) {
      console.log("[studio/deploy] Dev mode — returning placeholder URLs");
      await saveBuildRecord({
        deployId, apiKey, wallet, config: finalConfig,
        paymentTxHash: sessionId?.startsWith("pay_") ? sessionId : undefined,
        paymentAmountUsd: 50,
      }).catch(err => console.warn("[studio/deploy] save build skipped:", err));
      return NextResponse.json({
        deployId,
        apiKey,
        repoUrl: `https://github.com/hlone-xyz/hlone-template (would fork to your account)`,
        deployUrl: `https://${finalConfig.slug}.hlone.build (would be live after Vercel deploy)`,
        devMode: true,
        note: "To enable real deploys, set GITHUB_STUDIO_TOKEN and VERCEL_API_TOKEN env vars.",
      });
    }

    // ── Real deploy flow ──────────────────────────────────────────────────
    // Step 1: Fork the template repo
    // NOTE: This requires the user to have authenticated via GitHub OAuth first.
    // For now, we fork into the HLOne org and transfer ownership later (or use
    // a different pattern). Alternative: use the GitHub Template Repository API
    // to create a new repo from the template in the user's account.
    const forkName = `hlone-${finalConfig.slug}-${deployId.slice(0, 6)}`;
    const forkResp = await fetch(`https://api.github.com/repos/${templateRepo}/generate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        owner: "hlone-xyz", // TODO: replace with OAuth'd user's login
        name: forkName,
        description: `${finalConfig.name} — powered by HLOne Studio`,
        private: false,
        include_all_branches: false,
      }),
    });

    if (!forkResp.ok) {
      const errText = await forkResp.text();
      throw new Error(`GitHub fork failed: ${forkResp.status} ${errText.slice(0, 200)}`);
    }

    const fork = await forkResp.json();
    const repoUrl = fork.html_url as string;

    // Step 2: Commit studio.config.json to the fork
    const configB64 = Buffer.from(JSON.stringify(finalConfig, null, 2)).toString("base64");
    await fetch(`https://api.github.com/repos/${fork.full_name}/contents/studio.config.json`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "chore: add studio.config.json from HLOne Studio",
        content: configB64,
      }),
    });

    // Step 3: Trigger Vercel deploy
    const envConfigB64 = Buffer.from(JSON.stringify(finalConfig)).toString("base64");
    const vercelResp = await fetch(`https://api.vercel.com/v10/projects?teamId=${vercelTeamId}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${vercelToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: forkName,
        framework: "nextjs",
        gitRepository: {
          type: "github",
          repo: fork.full_name,
        },
        environmentVariables: [
          { key: "NEXT_PUBLIC_STUDIO_CONFIG", value: envConfigB64, target: ["production", "preview", "development"], type: "plain" },
          { key: "NEXT_PUBLIC_HLONE_API_KEY", value: apiKey, target: ["production", "preview", "development"], type: "plain" },
        ],
      }),
    });

    if (!vercelResp.ok) {
      const errText = await vercelResp.text();
      throw new Error(`Vercel project create failed: ${vercelResp.status} ${errText.slice(0, 200)}`);
    }

    const vercelProject = await vercelResp.json();
    const deployUrl = `https://${vercelProject.name}.vercel.app`;

    // Persist the build record with real URLs
    await saveBuildRecord({
      deployId,
      apiKey,
      wallet,
      config: finalConfig,
      paymentTxHash: sessionId,
      paymentAmountUsd: 50,
      repoUrl,
      deployUrl,
      vercelProjectId: vercelProject.id,
      githubRepoId: String(fork.id),
    });

    return NextResponse.json({
      deployId,
      apiKey,
      repoUrl,
      deployUrl,
    });
  } catch (err) {
    console.error("[studio/deploy] Error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// ─── Persistence (Prisma + Postgres) ────────────────────────────────────────
async function saveBuildRecord(record: {
  deployId: string;
  apiKey: string;
  wallet: string;
  config: StudioConfig;
  paymentTxHash?: string;
  paymentAmountUsd?: number;
  repoUrl?: string | null;
  deployUrl?: string | null;
  vercelProjectId?: string | null;
  githubRepoId?: string | null;
}): Promise<void> {
  if (!prisma) {
    // Dev / no-DB mode: just log (still allows full UX testing without Postgres)
    console.log("[studio/deploy] No DB — logging only:", {
      deployId: record.deployId,
      wallet: record.wallet,
      slug: record.config.slug,
      name: record.config.name,
      apiKeyPrefix: record.apiKey.slice(0, 16) + "...",
    });
    return;
  }

  try {
    await prisma.studioBuild.create({
      data: {
        deployId: record.deployId,
        apiKeyHash: hashApiKey(record.apiKey),
        ownerWallet: record.wallet.toLowerCase(),
        slug: record.config.slug,
        name: record.config.name,
        configJson: record.config as unknown as object,
        builderWallet: (record.config.fees?.builderWallet ?? record.wallet).toLowerCase(),
        markupBps: record.config.fees?.markupBps ?? 0,
        repoUrl: record.repoUrl ?? null,
        deployUrl: record.deployUrl ?? null,
        vercelProjectId: record.vercelProjectId ?? null,
        githubRepoId: record.githubRepoId ?? null,
        paymentTxHash: record.paymentTxHash ?? `dev_${Date.now()}`,
        paymentAmount: record.paymentAmountUsd ?? 50,
        paidAt: new Date(),
        status: "ACTIVE",
      },
    });
    console.log(`[studio/deploy] Build saved: ${record.deployId}`);
  } catch (err) {
    console.error("[studio/deploy] Failed to save build:", err);
    throw err;
  }
}
