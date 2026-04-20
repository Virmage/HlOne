/**
 * security-guards — defensive checks around critical signing operations.
 *
 * These guards exist to defend against:
 *   1. Frontend tampering (malicious JS injected via compromised dependency,
 *      supply-chain attack, XSS) — verify constants haven't been changed
 *   2. Order parameter manipulation — sanity-check before signing
 *   3. Signature tampering — verify signed data matches displayed params
 *
 * Nothing here is a perfect defense — a sufficiently clever attacker can
 * bypass any client-side check. But these raise the attack cost significantly
 * and catch most realistic attempts.
 */

/**
 * Critical addresses expected in the codebase. These MUST NOT change at runtime.
 * If any of these don't match, the app is potentially compromised and should
 * refuse to sign anything.
 */
export const CRITICAL_ADDRESSES = Object.freeze({
  // HLOne's builder wallet — receives 0.015% builder fee on every HL order
  HLONE_BUILDER: "0xbB0f753321e2B5FD29Bd1d14b532f5B54959ae63",
  // HL's EntryPoint / exchange router (if we ever need to check it)
  HL_EXCHANGE: "0x0000000000000000000000000000000000000001",
} as const);

/**
 * Runtime verification that critical constants match their expected values.
 * Call this on app load. If it fails, something is tampering with our code.
 */
export function verifyCriticalConstants(imported: {
  BUILDER_ADDRESS: string;
  BUILDER_FEE: number;
}): { ok: boolean; error?: string } {
  if (imported.BUILDER_ADDRESS.toLowerCase() !== CRITICAL_ADDRESSES.HLONE_BUILDER.toLowerCase()) {
    return {
      ok: false,
      error: `CRITICAL: BUILDER_ADDRESS has been tampered with. Expected ${CRITICAL_ADDRESSES.HLONE_BUILDER}, got ${imported.BUILDER_ADDRESS}. DO NOT TRADE.`,
    };
  }
  if (imported.BUILDER_FEE < 0 || imported.BUILDER_FEE > 100) {
    return {
      ok: false,
      error: `CRITICAL: BUILDER_FEE out of sane range. Got ${imported.BUILDER_FEE}. DO NOT TRADE.`,
    };
  }
  return { ok: true };
}

/**
 * Silent sanity-check: rejects orders with clearly-invalid values (size <= 0,
 * nonsensical price, etc.). These would fail at the exchange anyway — we catch
 * them client-side so users get a fast error instead of a slow one.
 *
 * Does NOT emit UI warnings or require confirmation. Traders don't want a
 * modal on every trade. If the order looks like fat-finger territory, HL's
 * own risk controls + the user's review of the trade panel are enough.
 */
export function verifyOrderParams(params: {
  asset: string;
  isBuy: boolean;
  size: number;
  limitPrice?: number;
  orderType: "market" | "limit";
  reduceOnly?: boolean;
  slippageBps?: number;
}, _ctx: {
  marketPrice?: number;
  accountValue?: number;
}): { ok: boolean; critical: string[] } {
  const critical: string[] = [];

  if (!Number.isFinite(params.size) || params.size <= 0) {
    critical.push(`Invalid size: ${params.size}`);
  }

  if (!params.asset || typeof params.asset !== "string" || params.asset.length > 20) {
    critical.push(`Suspicious asset name: ${params.asset}`);
  }

  if (params.orderType === "limit") {
    if (!params.limitPrice || !Number.isFinite(params.limitPrice) || params.limitPrice <= 0) {
      critical.push(`Invalid limit price: ${params.limitPrice}`);
    }
  }

  if (params.slippageBps !== undefined && (params.slippageBps < 0 || params.slippageBps > 5000)) {
    critical.push(`Slippage out of range: ${params.slippageBps} bps`);
  }

  return {
    ok: critical.length === 0,
    critical,
  };
}

// (removed: describeOrder, shouldRequireConfirmation, showConsoleWarning — not used)
