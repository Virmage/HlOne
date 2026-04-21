/**
 * POST /api/studio/checkout
 *
 * Verifies a crypto payment for the $50 one-time HLOne Studio deploy fee.
 * Users pay in USDC on Arbitrum (same chain they already use for HL deposits).
 *
 * Flow:
 *   1. Frontend triggers USDC.transfer(HLONE_PAYMENTS_WALLET, 50 USDC) via wagmi
 *   2. Frontend submits the txHash to this endpoint
 *   3. We verify the tx on-chain: correct recipient, ≥ $50 USDC, from claimed wallet, confirmed
 *   4. We mark the txHash as "used" so it can't be replayed
 *   5. Return { ok: true, sessionId } — frontend then calls /api/studio/deploy
 *
 * Env vars needed (set in Vercel, mark SENSITIVE per the April 2026 breach):
 *   NEXT_PUBLIC_HLONE_PAYMENTS_WALLET  - where $50 payments land (public, OK to prefix)
 *   ARBITRUM_RPC_URL                    - (optional) RPC endpoint, else uses public
 *   DATABASE_URL                        - for tracking used txHashes (MUST be sensitive)
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

// Fallback in-memory cache when DB isn't available (dev mode)
const usedTxHashesMemory = new Set<string>();

async function isTxHashUsed(txHash: string): Promise<boolean> {
  const normalized = txHash.toLowerCase();
  if (!prisma) return usedTxHashesMemory.has(normalized);
  try {
    const existing = await prisma.usedPaymentTx.findUnique({ where: { txHash: normalized } });
    return existing !== null;
  } catch {
    return usedTxHashesMemory.has(normalized);
  }
}

async function markTxHashUsed(txHash: string, wallet: string, amountUsdc: number): Promise<void> {
  const normalized = txHash.toLowerCase();
  usedTxHashesMemory.add(normalized); // always track in-memory as a safety net
  if (!prisma) return;
  try {
    await prisma.usedPaymentTx.create({
      data: {
        txHash: normalized,
        wallet: wallet.toLowerCase(),
        amountUsdc,
      },
    });
  } catch (err) {
    // Race condition or duplicate — already marked. Ignore.
    console.warn("[checkout] mark tx used:", (err as Error).message);
  }
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

    // Dev mode: if no payments wallet configured, skip payment and deploy immediately
    if (!paymentsWallet) {
      console.log("[studio/checkout] Dev mode — no NEXT_PUBLIC_HLONE_PAYMENTS_WALLET set, skipping payment");
      return NextResponse.json({
        skipPayment: true,
        sessionId: `dev_${Date.now()}`,
        note: "Set NEXT_PUBLIC_HLONE_PAYMENTS_WALLET env var to enable payment verification.",
      });
    }

    // Real flow: require txHash from frontend
    if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      // No txHash yet — frontend is requesting payment instructions
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

    // Replay protection (DB-backed, falls back to in-memory cache)
    if (await isTxHashUsed(txHash)) {
      return NextResponse.json({ error: "Transaction already used for a previous deploy" }, { status: 409 });
    }

    // Verify on-chain
    const rpcUrl = process.env.ARBITRUM_RPC_URL ?? "https://arb1.arbitrum.io/rpc";
    const client = createPublicClient({ chain: arbitrum, transport: http(rpcUrl) });

    const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` }).catch(() => null);
    if (!receipt) {
      return NextResponse.json({ error: "Transaction not found or not yet mined. Wait ~30s and retry." }, { status: 404 });
    }
    if (receipt.status !== "success") {
      return NextResponse.json({ error: "Transaction reverted on-chain" }, { status: 400 });
    }
    if (receipt.to?.toLowerCase() !== USDC_ARBITRUM.toLowerCase()) {
      return NextResponse.json({ error: "Transaction is not a USDC transfer (wrong contract)" }, { status: 400 });
    }

    // Decode Transfer events from the receipt
    let matchingTransfer: { from: string; to: string; value: bigint } | null = null;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== USDC_ARBITRUM.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({
          abi: TRANSFER_EVENT_ABI,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === "Transfer") {
          matchingTransfer = {
            from: decoded.args.from,
            to: decoded.args.to,
            value: decoded.args.value,
          };
          break;
        }
      } catch {}
    }

    if (!matchingTransfer) {
      return NextResponse.json({ error: "No USDC Transfer event in transaction" }, { status: 400 });
    }

    if (matchingTransfer.from.toLowerCase() !== wallet.toLowerCase()) {
      return NextResponse.json({
        error: `Transfer from address (${matchingTransfer.from}) doesn't match connected wallet (${wallet})`,
      }, { status: 400 });
    }

    if (matchingTransfer.to.toLowerCase() !== paymentsWallet.toLowerCase()) {
      return NextResponse.json({
        error: `Transfer recipient (${matchingTransfer.to}) doesn't match HLOne payments wallet (${paymentsWallet})`,
      }, { status: 400 });
    }

    const requiredAmount = parseUnits(DEPLOY_FEE_USDC.toString(), USDC_DECIMALS);
    if (matchingTransfer.value < requiredAmount) {
      const paidUsdc = Number(matchingTransfer.value) / 10 ** USDC_DECIMALS;
      return NextResponse.json({
        error: `Payment below $${DEPLOY_FEE_USDC} (paid $${paidUsdc.toFixed(2)})`,
      }, { status: 402 });
    }

    // Mark tx as used (DB + in-memory)
    const paidAmount = Number(matchingTransfer.value) / 10 ** USDC_DECIMALS;
    await markTxHashUsed(txHash, wallet, paidAmount);

    const sessionId = `pay_${crypto.randomBytes(12).toString("hex")}`;
    console.log(`[studio/checkout] Payment verified: ${wallet} → ${txHash} → sessionId=${sessionId}`);

    return NextResponse.json({
      ok: true,
      sessionId,
      verified: {
        txHash,
        from: matchingTransfer.from,
        to: matchingTransfer.to,
        amountUsdc: Number(matchingTransfer.value) / 10 ** USDC_DECIMALS,
      },
    });
  } catch (err) {
    console.error("[studio/checkout] Error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
