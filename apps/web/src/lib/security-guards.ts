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
 * Sanity-check an order before signing. Catches obviously-wrong values that
 * might indicate parameter manipulation.
 */
export function verifyOrderParams(params: {
  asset: string;
  isBuy: boolean;
  size: number;
  limitPrice?: number;
  orderType: "market" | "limit";
  reduceOnly?: boolean;
  slippageBps?: number;
}, ctx: {
  marketPrice?: number;
  accountValue?: number;
}): { ok: boolean; warnings: string[]; critical: string[] } {
  const warnings: string[] = [];
  const critical: string[] = [];

  // Size must be positive and finite
  if (!Number.isFinite(params.size) || params.size <= 0) {
    critical.push(`Invalid size: ${params.size}`);
  }

  // Asset name sanity
  if (!params.asset || typeof params.asset !== "string" || params.asset.length > 20) {
    critical.push(`Suspicious asset name: ${params.asset}`);
  }

  // Limit price sanity
  if (params.orderType === "limit") {
    if (!params.limitPrice || !Number.isFinite(params.limitPrice) || params.limitPrice <= 0) {
      critical.push(`Invalid limit price: ${params.limitPrice}`);
    }
    // Warn if limit price is far from market
    if (ctx.marketPrice && params.limitPrice) {
      const deviation = Math.abs(params.limitPrice - ctx.marketPrice) / ctx.marketPrice;
      if (deviation > 0.5) {
        warnings.push(`Limit price (${params.limitPrice}) is ${(deviation * 100).toFixed(0)}% away from market (${ctx.marketPrice.toFixed(4)}). Double-check.`);
      }
    }
  }

  // Slippage bounds
  if (params.slippageBps !== undefined) {
    if (params.slippageBps < 0 || params.slippageBps > 5000) {
      critical.push(`Slippage out of range: ${params.slippageBps} bps (max 5000 = 50%)`);
    } else if (params.slippageBps > 500) {
      warnings.push(`Slippage is unusually high: ${params.slippageBps} bps (${(params.slippageBps / 100).toFixed(2)}%). Expected <5%.`);
    }
  }

  // Size vs account value sanity
  if (ctx.accountValue && ctx.marketPrice && params.size > 0) {
    const notionalUsd = params.size * ctx.marketPrice;
    if (notionalUsd > ctx.accountValue * 100) {
      warnings.push(`Order notional ($${notionalUsd.toFixed(0)}) is 100x+ your account value ($${ctx.accountValue.toFixed(0)}). Unusual.`);
    }
  }

  return {
    ok: critical.length === 0,
    warnings,
    critical,
  };
}

/**
 * Compute a human-readable summary of what's about to be signed. This is what
 * we show the user in the confirmation modal so they can verify reality matches
 * the UI they clicked.
 */
export function describeOrder(params: {
  asset: string;
  isBuy: boolean;
  size: number;
  limitPrice?: number;
  orderType: "market" | "limit";
  reduceOnly?: boolean;
}, marketPrice?: number): {
  title: string;
  direction: "Buy" | "Sell";
  asset: string;
  size: string;
  price: string;
  notionalUsd: string;
  type: string;
  details: Array<{ label: string; value: string; highlight?: boolean }>;
} {
  const direction = params.isBuy ? "Buy" : "Sell";
  const effectivePrice = params.orderType === "market" ? marketPrice : params.limitPrice;
  const notional = effectivePrice && params.size ? effectivePrice * params.size : 0;
  return {
    title: `${direction} ${params.size} ${params.asset} @ ${params.orderType === "market" ? "market" : params.limitPrice?.toFixed(4)}`,
    direction,
    asset: params.asset,
    size: params.size.toString(),
    price: params.orderType === "market" ? `Market (~${marketPrice?.toFixed(4) ?? "?"})` : `$${params.limitPrice?.toFixed(4)}`,
    notionalUsd: `$${notional.toFixed(2)}`,
    type: params.orderType === "market" ? "Market" : "Limit",
    details: [
      { label: "Direction", value: direction, highlight: true },
      { label: "Asset", value: params.asset },
      { label: "Size", value: params.size.toString() },
      { label: "Order type", value: params.orderType === "market" ? "Market" : "Limit" },
      ...(params.orderType === "limit" ? [{ label: "Limit price", value: `$${params.limitPrice?.toFixed(4)}` }] : []),
      { label: "Est. notional", value: `$${notional.toFixed(2)}` },
      { label: "Reduce-only", value: params.reduceOnly ? "Yes" : "No" },
    ],
  };
}

/**
 * Threshold (USD notional) above which we require explicit confirmation before signing.
 * Users can override via localStorage; default $500.
 */
const CONFIRM_THRESHOLD_KEY = "hlone-confirm-threshold-usd";
const DEFAULT_CONFIRM_THRESHOLD = 500;

export function getConfirmThreshold(): number {
  try {
    const raw = localStorage.getItem(CONFIRM_THRESHOLD_KEY);
    if (raw) {
      const n = parseFloat(raw);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  } catch {}
  return DEFAULT_CONFIRM_THRESHOLD;
}

export function setConfirmThreshold(usd: number): void {
  try {
    localStorage.setItem(CONFIRM_THRESHOLD_KEY, usd.toString());
  } catch {}
}

export function shouldRequireConfirmation(notionalUsd: number): boolean {
  return notionalUsd >= getConfirmThreshold();
}

/**
 * Show a big, loud phishing warning in the browser console. Attackers often
 * trick users into pasting malicious JS into their console under the guise of
 * "unlocking features" or "verifying their wallet".
 */
export function showConsoleWarning(): void {
  if (typeof window === "undefined") return;
  try {
    const style1 = "color: #ff4444; font-size: 28px; font-weight: bold;";
    const style2 = "color: #ff4444; font-size: 14px;";
    const style3 = "color: #98fce4; font-size: 12px;";
    console.log("%cSTOP!", style1);
    console.log(
      "%cIf someone told you to paste something here, they are trying to steal your keys or your funds. DO NOT paste ANYTHING into this console unless you wrote it yourself and know exactly what it does.",
      style2,
    );
    console.log(
      "%cHLOne's team will NEVER ask you to run commands in your browser console. Report any such request to our Twitter/Discord immediately.",
      style3,
    );
  } catch {}
}
