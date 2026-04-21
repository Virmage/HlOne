/**
 * POST /api/studio/deploy
 *
 * After successful crypto payment verification (via /api/studio/checkout),
 * this endpoint:
 *   1. Verifies the caller's wallet signature (binds the deploy to a wallet)
 *   2. Atomically consumes the PaymentSession (single-use, wallet-bound)
 *   3. Forks the hlone-template repo into the builder's GitHub account
 *   4. Commits their studio.config.json
 *   5. Triggers a Vercel deploy of the fork
 *   6. Issues an API key and stores the build record
 *
 * Security boundaries:
 *   - Anonymous callers are REJECTED (no wallet sig → 401)
 *   - The bot token is only used when the caller has a valid GitHub OAuth
 *     cookie, not as a default-on fallback (which would let anyone fork
 *     repos into our org).
 *   - sessionId is a DB-backed single-use token; prefix-matching is no
 *     longer sufficient.
 *
 * Env vars needed (set in Vercel — mark ALL sensitive):
 *   GITHUB_STUDIO_TOKEN       - PAT with repo scope
 *   GITHUB_TEMPLATE_REPO      - e.g. "hlone-xyz/hlone-template"
 *   VERCEL_API_TOKEN          - Vercel deploy token
 *   VERCEL_TEAM_ID            - Vercel team/org ID
 *   DATABASE_URL              - Postgres for build records
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { validateConfig, type StudioConfig } from "@/lib/studio-config";
import { prisma } from "@/lib/prisma";
import { verifyWalletSignature } from "@/lib/server-auth";
import crypto from "crypto";

function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function isProduction(): boolean {
  if (process.env.IS_PRODUCTION === "1") return true;
  if (process.env.VERCEL_ENV) return process.env.VERCEL_ENV === "production";
  return process.env.NODE_ENV === "production";
}

/** Strip any GitHub description content that could be used for phishing / log injection. */
function sanitizeDescription(input: string, maxLen = 200): string {
  return input
    .replace(/[\r\n\t\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const config = body.config as Partial<StudioConfig>;
    const wallet = body.wallet as string;
    const sessionId = body.sessionId as string | undefined;
    const signature = body.signature as string | undefined;
    const timestamp = body.timestamp as number | undefined;

    const validation = validateConfig(config);
    if (!validation.ok) {
      return NextResponse.json({ error: "Invalid config", details: validation.errors }, { status: 400 });
    }

    if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      return NextResponse.json({ error: "Invalid wallet" }, { status: 400 });
    }
    if (!sessionId || !/^(pay|dev)_[a-f0-9]{4,}$/.test(sessionId)) {
      return NextResponse.json({ error: "Missing or malformed payment session" }, { status: 402 });
    }

    // ── STEP 1: Verify wallet signature (bound to sessionId + timestamp) ─────
    if (!signature || typeof timestamp !== "number") {
      return NextResponse.json({ error: "Missing signature or timestamp — sign 'deploy' with your wallet" }, { status: 401 });
    }
    const verify = await verifyWalletSignature(
      {
        wallet,
        signature,
        timestamp,
        action: "studio-deploy",
        bodyHash: sessionId, // bind signature to this specific sessionId
      },
      { expectedAction: "studio-deploy", expectedWallet: wallet, expectedBodyHash: sessionId },
    );
    if (!verify.ok) {
      return NextResponse.json({ error: verify.error }, { status: verify.status });
    }
    const normalizedWallet = verify.wallet; // lowercased

    // ── STEP 2: Atomically consume the payment session ───────────────────────
    // If the session doesn't exist, already consumed, or belongs to another
    // wallet, this update affects 0 rows. We use updateMany + count to detect.
    if (!prisma) {
      if (isProduction()) {
        console.error("[studio/deploy] prisma null in production");
        return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
      }
      // Dev-only no-DB fallback: allow dev_ sessions
      if (!sessionId.startsWith("dev_")) {
        return NextResponse.json({ error: "Payment session invalid (no DB)" }, { status: 402 });
      }
    } else {
      const claim = await prisma.paymentSession.updateMany({
        where: {
          id: sessionId,
          consumedAt: null,
          wallet: normalizedWallet,
        },
        data: { consumedAt: new Date() },
      });
      if (claim.count !== 1) {
        // Could be: unknown sessionId, already consumed, or wallet mismatch
        return NextResponse.json({ error: "Payment session invalid, already used, or owned by another wallet" }, { status: 402 });
      }
    }

    // ── STEP 3: Resolve GitHub + Vercel credentials ──────────────────────────
    const cookieStore = await cookies();
    // __Host- prefix prevents cookie-fixation attacks via subdomains/preview URLs.
    const userGhToken = cookieStore.get("__Host-hlone-gh-token")?.value;
    const userGhLogin = cookieStore.get("__Host-hlone-gh-login")?.value;
    const botGhToken = process.env.GITHUB_STUDIO_TOKEN;

    // ANON users may NOT use the bot token. The bot is a fallback ONLY when
    // GITHUB_FORK_OWNER is explicitly configured (self-hosted enterprise case).
    const hasUserAuth = !!(userGhToken && userGhLogin);
    const hasBotFallback = !!(botGhToken && process.env.GITHUB_FORK_OWNER);

    const githubToken = hasUserAuth ? userGhToken : (hasBotFallback ? botGhToken : undefined);
    const templateRepo = process.env.GITHUB_TEMPLATE_REPO ?? "hlone-xyz/hlone-template";
    // Owner of the forked repo. Priority:
    //   1. OAuth'd user's GitHub login (preferred — fork lands in their account)
    //   2. GITHUB_FORK_OWNER env var (explicit self-hosted override)
    //   Never silently default to template's org.
    const forkOwner = hasUserAuth ? userGhLogin! : process.env.GITHUB_FORK_OWNER;
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

    // If credentials are missing, fail in production (do NOT silently issue
    // placeholder URLs — that would hide a broken deploy from the user).
    if (!githubToken || !vercelToken || !forkOwner) {
      if (isProduction()) {
        console.error("[studio/deploy] Missing GH/Vercel creds in production");
        return NextResponse.json({ error: "Deploy unavailable — administrator must connect GitHub" }, { status: 503 });
      }
      // Dev only: return placeholders so UI flows work end-to-end locally
      console.log("[studio/deploy] Dev mode — returning placeholder URLs");
      await saveBuildRecord({
        deployId, apiKey, wallet: normalizedWallet, config: finalConfig,
        paymentTxHash: sessionId, paymentAmountUsd: 50,
      }).catch(err => console.warn("[studio/deploy] save build skipped:", err));
      return NextResponse.json({
        deployId,
        apiKey,
        repoUrl: `https://github.com/${templateRepo} (would fork to your account)`,
        deployUrl: `https://${finalConfig.slug}.hlone.build (would be live after Vercel deploy)`,
        devMode: true,
        note: "Connect GitHub via /api/studio/github-auth to enable real deploys.",
      });
    }

    // ── STEP 4: Real deploy flow ─────────────────────────────────────────────
    const forkName = `hlone-${finalConfig.slug}-${deployId.slice(0, 6)}`;
    const safeDescription = sanitizeDescription(`${finalConfig.name} — powered by HLOne Studio`);

    const forkResp = await fetch(`https://api.github.com/repos/${templateRepo}/generate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "hlone-studio",
      },
      body: JSON.stringify({
        owner: forkOwner,
        name: forkName,
        description: safeDescription,
        private: false,
        include_all_branches: false,
      }),
    });

    if (!forkResp.ok) {
      const errText = await forkResp.text();
      console.error(`[studio/deploy] GitHub fork failed: ${forkResp.status}`, errText.slice(0, 300));
      return NextResponse.json({ error: "GitHub fork failed" }, { status: 502 });
    }

    const fork = await forkResp.json();
    // Sanity-check the fork shape before we use it in further API calls.
    if (typeof fork.full_name !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(fork.full_name)) {
      console.error("[studio/deploy] Unexpected GitHub fork response:", fork);
      return NextResponse.json({ error: "Unexpected GitHub response" }, { status: 502 });
    }
    const repoUrl = typeof fork.html_url === "string" && fork.html_url.startsWith("https://github.com/")
      ? fork.html_url
      : `https://github.com/${fork.full_name}`;

    // Commit studio.config.json to the fork
    const configB64 = Buffer.from(JSON.stringify(finalConfig, null, 2)).toString("base64");
    await fetch(`https://api.github.com/repos/${fork.full_name}/contents/studio.config.json`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "hlone-studio",
      },
      body: JSON.stringify({
        message: "chore: add studio.config.json from HLOne Studio",
        content: configB64,
      }),
    });

    // Trigger Vercel deploy
    // NOTE: API key is passed as a SERVER-ONLY env var (HLONE_API_KEY, no
    // NEXT_PUBLIC_ prefix) so it does NOT ship in the client bundle. Only the
    // fork's server routes can read it.
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
          // Sensitive — server-only, not inlined in the client bundle.
          { key: "HLONE_API_KEY", value: apiKey, target: ["production", "preview", "development"], type: "sensitive" },
        ],
      }),
    });

    if (!vercelResp.ok) {
      const errText = await vercelResp.text();
      console.error(`[studio/deploy] Vercel create failed: ${vercelResp.status}`, errText.slice(0, 300));
      return NextResponse.json({ error: "Vercel project creation failed" }, { status: 502 });
    }

    const vercelProject = await vercelResp.json();
    if (typeof vercelProject.name !== "string" || !/^[a-zA-Z0-9._-]+$/.test(vercelProject.name)) {
      console.error("[studio/deploy] Unexpected Vercel response:", vercelProject);
      return NextResponse.json({ error: "Unexpected Vercel response" }, { status: 502 });
    }
    const deployUrl = `https://${vercelProject.name}.vercel.app`;

    // Persist the build record
    await saveBuildRecord({
      deployId,
      apiKey,
      wallet: normalizedWallet,
      config: finalConfig,
      paymentTxHash: sessionId,
      paymentAmountUsd: 50,
      repoUrl,
      deployUrl,
      vercelProjectId: vercelProject.id,
      githubRepoId: String(fork.id),
    });

    // Link the PaymentSession → deployId (audit trail)
    if (prisma) {
      await prisma.paymentSession.update({
        where: { id: sessionId },
        data: { deployId },
      }).catch(() => { /* non-fatal */ });
    }

    return NextResponse.json({
      deployId,
      apiKey,
      repoUrl,
      deployUrl,
    });
  } catch (err) {
    console.error("[studio/deploy] Error:", err);
    // Generic error — don't leak stack / internal details.
    return NextResponse.json({ error: "Deploy failed. Please try again." }, { status: 500 });
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
    console.log("[studio/deploy] No DB — logging only:", {
      deployId: record.deployId,
      wallet: record.wallet.slice(0, 10) + "…",
      slug: record.config.slug,
      name: record.config.name,
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
