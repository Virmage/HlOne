/**
 * POST /api/studio/deploy
 *
 * After successful Stripe payment (or in dev mode), this endpoint:
 *   1. Forks the hlone-template repo into the builder's GitHub account
 *   2. Commits their studio.config.json + NEXT_PUBLIC_STUDIO_CONFIG env var
 *   3. Triggers a Vercel deploy of the fork
 *   4. Issues an API key and stores the build record
 *
 * Env vars needed (set in Vercel):
 *   GITHUB_STUDIO_TOKEN       - PAT with repo + fork scopes, belongs to @hlone-xyz bot
 *   GITHUB_TEMPLATE_REPO      - e.g. "hlone-xyz/hlone-template"
 *   VERCEL_API_TOKEN          - Vercel deploy token (belongs to @hlone org)
 *   VERCEL_TEAM_ID            - Vercel team/org ID
 *   STRIPE_SECRET_KEY         - for verifying checkout sessions
 *   DATABASE_URL              - Postgres (or Turso, etc.) for build records
 *
 * If creds are missing, returns a dev-mode response with placeholder URLs so
 * the UI flow works end-to-end locally.
 */

import { NextResponse } from "next/server";
import { validateConfig, type StudioConfig } from "@/lib/studio-config";
import crypto from "crypto";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const config = body.config as Partial<StudioConfig>;
    const wallet = body.wallet as string;
    const checkoutId = body.checkoutId as string | undefined;

    const validation = validateConfig(config);
    if (!validation.ok) {
      return NextResponse.json({ error: "Invalid config", details: validation.errors }, { status: 400 });
    }

    // Verify Stripe checkout (unless dev mode)
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    const isDev = !stripeKey || (checkoutId?.startsWith("dev_") ?? false);

    if (!isDev) {
      if (!checkoutId) {
        return NextResponse.json({ error: "Missing checkoutId" }, { status: 400 });
      }
      // @ts-expect-error — stripe is an optional peer dep, install to enable
      const StripeModule = await import("stripe").catch(() => null);
      if (!StripeModule) {
        return NextResponse.json({ error: "Stripe SDK not installed" }, { status: 500 });
      }
      const Stripe = StripeModule.default;
      const stripe = new Stripe(stripeKey);
      const session = await stripe.checkout.sessions.retrieve(checkoutId);
      if (session.payment_status !== "paid") {
        return NextResponse.json({ error: "Payment not completed" }, { status: 402 });
      }
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

    // Persist build record to DB (stubbed — TODO: wire to real DB)
    await saveBuildRecord({ deployId, apiKey, wallet, config: finalConfig });

    // Dev mode or missing creds — return placeholder URLs
    if (isDev || !githubToken || !vercelToken) {
      console.log("[studio/deploy] Dev mode — returning placeholder URLs");
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

// ─── Persistence (stubbed) ──────────────────────────────────────────────────
// TODO: replace with real DB (Postgres, Turso, Supabase)
async function saveBuildRecord(record: {
  deployId: string;
  apiKey: string;
  wallet: string;
  config: StudioConfig;
}): Promise<void> {
  // In dev, just log. In prod, upsert to DB.
  console.log("[studio/deploy] Would save build record:", {
    deployId: record.deployId,
    wallet: record.wallet,
    slug: record.config.slug,
    name: record.config.name,
    markupBps: record.config.fees.markupBps,
    // Don't log full API key
    apiKeyPrefix: record.apiKey.slice(0, 16) + "...",
  });
  // Example real impl:
  // await db.insert("studio_builds", { deploy_id, api_key_hash, wallet, config_json, created_at });
}
