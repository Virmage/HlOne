/**
 * POST /api/studio/checkout
 *
 * Verifies a crypto payment for the $50 one-time HLOne Studio deploy fee.
 * Users pay in USDC on Arbitrum (same chain they already use for HL deposits).
 *
 * Flow:
 *   1. Frontend triggers USDC.transfer(HLONE_PAYMENTS_WALLET, 50 USDC) via wagmi
 *   2. Frontend submits the txHash to this endpoint
 *   3. We atomically claim the txHash (UsedPaymentTx unique-insert — fails fast
 *      on concurrent re-submits so one tx cannot fund two deploys)
 *   4. We verify the tx on-chain: correct recipient, ≥ $50 USDC, from claimed wallet
 *   5. We persist a PaymentSession (sessionId → wallet, unconsumed) so /deploy
 *      can atomically consume it. sessionIds are no longer trust-by-prefix.
 *   6. Return { ok: true, sessionId } — frontend then calls /api/studio/deploy
 *
 * Env vars needed (set in Vercel, mark SENSITIVE):
 *   NEXT_PUBLIC_HLONE_PAYMENTS_WALLET  - where $50 payments land (public, OK)
 *   ARBITRUM_RPC_URL                    - (optional) RPC endpoint, else public
 *   DATABASE_URL                        - for tracking used txHashes + sessions
 */

import { NextResponse } from "next/server";
import { createPublicClient, http, parseUnits, decodeEventLog, parseAbi } from "viem";
import { arbitrum } from "viem/chains";
import { validateConfig, type StudioConfig } from "@/lib/studio-config";
import { prisma } from "@/lib/prisma";
import crypto from "crypto";

// USDC on Arbitrum (native, not bridged)
const USDC_ARBITRUM = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
const USDC_DECIMALS = 6;
const DEPLOY_FEE_USDC = 50; // $50

const TRANSFER_EVENT_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/** Production = real Vercel prod (or user explicitly set IS_PRODUCTION=1).
 * We deliberately do NOT trust NODE_ENV alone — Vercel preview deploys set
 * NODE_ENV=production AND NODE_ENV=preview depending on config; the only
 * reliable gate is VERCEL_ENV (set by Vercel to one of development/preview/production).
 */
function isProduction(): boolean {
  if (process.env.IS_PRODUCTION === "1") return true;
  if (process.env.VERCEL_ENV) return process.env.VERCEL_ENV === "production";
  return process.env.NODE_ENV === "production";
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const config = body.config as Partial<StudioConfig>;
    const wallet = body.wallet as string | undefined;
    const txHash = body.txHash as string | undefined;

    const validation = validateConfig(config);
    if (!validation.ok) {
      return NextResponse.json({ error: "Invalid config", details: validation.errors }, { status: 400 });
    }

    if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
    }

    const paymentsWallet = process.env.NEXT_PUBLIC_HLONE_PAYMENTS_WALLET;
    const prod = isProduction();

    // Missing env in production is a deployment misconfiguration — we do NOT
    // fall through to a bypass. Fail closed with 503.
    if (!paymentsWallet) {
      if (prod) {
        console.error("[studio/checkout] NEXT_PUBLIC_HLONE_PAYMENTS_WALLET missing in production");
        return NextResponse.json({ error: "Payments unavailable. Please try again later." }, { status: 503 });
      }
      // Dev-only: skip payment (requires DB so the dev session is still consumable)
      if (!prisma) {
        return NextResponse.json({
          skipPayment: true,
          sessionId: `dev_${Date.now()}`,
          note: "Dev mode (no DB, no payments wallet).",
        });
      }
      const sessionId = `dev_${crypto.randomBytes(12).toString("hex")}`;
      await prisma.paymentSession.create({
        data: {
          id: sessionId,
          txHash: `devtx_${sessionId}`,
          wallet: wallet.toLowerCase(),
          amountUsdc: 0,
        },
      });
      return NextResponse.json({ skipPayment: true, sessionId, devMode: true });
    }

    // Real flow: require txHash from frontend
    if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return NextResponse.json({
        paymentRequired: true,
        amountUsdc: DEPLOY_FEE_USDC,
        tokenAddress: USDC_ARBITRUM,
        chainId: arbitrum.id,
        chainName: "Arbitrum",
        recipient: paymentsWallet,
        note: "Send 50 USDC on Arbitrum to the recipient, then submit txHash to complete deploy.",
      });
    }

    if (!prisma) {
      // DB is required for production payment flow (replay protection).
      console.error("[studio/checkout] prisma null in production-ish env");
      return NextResponse.json({ error: "Payments unavailable. Please try again later." }, { status: 503 });
    }

    const normalizedTxHash = txHash.toLowerCase();
    const normalizedWallet = wallet.toLowerCase();

    // ── STEP 1: Atomically claim the txHash ──────────────────────────────────
    // We insert into UsedPaymentTx BEFORE any verification. If two concurrent
    // requests submit the same txHash, exactly one wins (P2002 unique violation).
    // If on-chain verification later fails, we clean up the row.
    try {
      await prisma.usedPaymentTx.create({
        data: {
          txHash: normalizedTxHash,
          wallet: normalizedWallet,
          amountUsdc: 0, // placeholder — updated after verify
        },
      });
    } catch (err) {
      const msg = (err as Error).message || "";
      if (msg.includes("Unique") || msg.includes("P2002")) {
        return NextResponse.json({ error: "Transaction already used for a previous deploy" }, { status: 409 });
      }
      throw err;
    }

    // ── STEP 2: On-chain verification ─────────────────────────────────────────
    let verifyError: { code: number; msg: string } | null = null;
    let paidAmountUsdc = 0;
    try {
      const rpcUrl = process.env.ARBITRUM_RPC_URL ?? "https://arb1.arbitrum.io/rpc";
      const client = createPublicClient({ chain: arbitrum, transport: http(rpcUrl) });
      const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` }).catch(() => null);

      if (!receipt) verifyError = { code: 404, msg: "Transaction not found or not yet mined. Wait ~30s and retry." };
      else if (receipt.status !== "success") verifyError = { code: 400, msg: "Transaction reverted on-chain" };
      else if (receipt.to?.toLowerCase() !== USDC_ARBITRUM.toLowerCase())
        verifyError = { code: 400, msg: "Transaction is not a USDC transfer (wrong contract)" };

      if (!verifyError && receipt) {
        let matchingTransfer: { from: string; to: string; value: bigint } | null = null;
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== USDC_ARBITRUM.toLowerCase()) continue;
          try {
            const decoded = decodeEventLog({ abi: TRANSFER_EVENT_ABI, data: log.data, topics: log.topics });
            if (decoded.eventName === "Transfer") {
              matchingTransfer = {
                from: decoded.args.from,
                to: decoded.args.to,
                value: decoded.args.value,
              };
              break;
            }
          } catch { /* ignore log decode errors */ }
        }

        if (!matchingTransfer) verifyError = { code: 400, msg: "No USDC Transfer event in transaction" };
        else if (matchingTransfer.from.toLowerCase() !== normalizedWallet)
          verifyError = { code: 400, msg: "Transfer from address doesn't match connected wallet" };
        else if (matchingTransfer.to.toLowerCase() !== paymentsWallet.toLowerCase())
          verifyError = { code: 400, msg: "Transfer recipient doesn't match HLOne payments wallet" };
        else {
          const requiredAmount = parseUnits(DEPLOY_FEE_USDC.toString(), USDC_DECIMALS);
          if (matchingTransfer.value < requiredAmount) {
            const paid = Number(matchingTransfer.value) / 10 ** USDC_DECIMALS;
            verifyError = { code: 402, msg: `Payment below $${DEPLOY_FEE_USDC} (paid $${paid.toFixed(2)})` };
          } else {
            paidAmountUsdc = Number(matchingTransfer.value) / 10 ** USDC_DECIMALS;
          }
        }
      }
    } catch (err) {
      console.error("[studio/checkout] verify threw:", err);
      verifyError = { code: 500, msg: "On-chain verification failed; please try again." };
    }

    // ── STEP 3: Verification failed → unclaim the txHash so payer can retry ──
    if (verifyError) {
      await prisma.usedPaymentTx.delete({ where: { txHash: normalizedTxHash } }).catch(() => { /* best effort */ });
      return NextResponse.json({ error: verifyError.msg }, { status: verifyError.code });
    }

    // ── STEP 4: Update the UsedPaymentTx row with the real amount ────────────
    await prisma.usedPaymentTx.update({
      where: { txHash: normalizedTxHash },
      data: { amountUsdc: paidAmountUsdc },
    }).catch(() => { /* best effort */ });

    // ── STEP 5: Create the PaymentSession ────────────────────────────────────
    // This is the token /deploy will consume atomically. Bound to wallet + txHash.
    const sessionId = `pay_${crypto.randomBytes(12).toString("hex")}`;
    try {
      await prisma.paymentSession.create({
        data: {
          id: sessionId,
          txHash: normalizedTxHash,
          wallet: normalizedWallet,
          amountUsdc: paidAmountUsdc,
        },
      });
    } catch (err) {
      console.error("[studio/checkout] PaymentSession create failed:", err);
      return NextResponse.json({ error: "Failed to create payment session" }, { status: 500 });
    }

    console.log(`[studio/checkout] Payment verified: ${normalizedWallet.slice(0, 10)}… → session=${sessionId.slice(0, 10)}…`);

    return NextResponse.json({
      ok: true,
      sessionId,
      verified: {
        txHash: normalizedTxHash,
        from: normalizedWallet,
        to: paymentsWallet,
        amountUsdc: paidAmountUsdc,
      },
    });
  } catch (err) {
    // NEVER leak the error message to clients — log server-side, return generic.
    console.error("[studio/checkout] Error:", err);
    return NextResponse.json({ error: "Checkout failed. Please try again." }, { status: 500 });
  }
}
