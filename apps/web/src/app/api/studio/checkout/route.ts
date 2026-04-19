/**
 * POST /api/studio/checkout
 *
 * Creates a Stripe Checkout session for the $50 one-time HLOne Studio deploy fee.
 * On successful payment, Stripe redirects back to /studio?deploy=<sessionId>
 * which triggers /api/studio/deploy to actually fork + deploy the repo.
 *
 * Env vars needed (set in Vercel):
 *   STRIPE_SECRET_KEY          - sk_live_... or sk_test_...
 *   STRIPE_STUDIO_PRICE_ID     - price_... (for the $50 one-time product)
 *   NEXT_PUBLIC_BASE_URL       - https://hlone.xyz (for redirects)
 *
 * In dev (no STRIPE_SECRET_KEY set), returns { skipPayment: true } so the
 * frontend can call /api/studio/deploy directly.
 */

import { NextResponse } from "next/server";
import { validateConfig, type StudioConfig } from "@/lib/studio-config";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const config = body.config as Partial<StudioConfig>;
    const wallet = body.wallet as string | undefined;

    const validation = validateConfig(config);
    if (!validation.ok) {
      return NextResponse.json({ error: "Invalid config", details: validation.errors }, { status: 400 });
    }

    if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
    }

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    const stripePriceId = process.env.STRIPE_STUDIO_PRICE_ID;
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";

    // Dev mode: no Stripe → skip payment, deploy immediately
    if (!stripeKey || !stripePriceId) {
      console.log("[studio/checkout] Dev mode — no STRIPE_SECRET_KEY, skipping payment");
      return NextResponse.json({
        skipPayment: true,
        sessionId: `dev_${Date.now()}`,
      });
    }

    // Prod: create Stripe checkout session
    // (Dynamic-imported to avoid bundling the SDK into dev builds / when not installed.
    //  Run `pnpm add stripe` in apps/web to enable real payment processing.)
    // @ts-expect-error — stripe is an optional peer dep, install to enable
    const StripeModule = await import("stripe").catch(() => null);
    if (!StripeModule) {
      return NextResponse.json({
        error: "Stripe SDK not installed. Run 'pnpm add stripe' in apps/web to enable payments, or unset STRIPE_SECRET_KEY for dev mode.",
      }, { status: 500 });
    }
    const Stripe = StripeModule.default;
    const stripe = new Stripe(stripeKey);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{ price: stripePriceId, quantity: 1 }],
      success_url: `${baseUrl}/studio?deploy={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/studio?canceled=1`,
      metadata: {
        wallet,
        slug: validation.config.slug,
        name: validation.config.name,
        // Stash the full config so the webhook can deploy it
        config: JSON.stringify(validation.config).slice(0, 4900), // Stripe metadata limit is 500 chars per field; we'll store separately in prod
      },
    });

    return NextResponse.json({
      url: session.url,
      sessionId: session.id,
    });
  } catch (err) {
    console.error("[studio/checkout] Error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
