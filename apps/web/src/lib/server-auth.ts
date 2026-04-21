/**
 * Server-side wallet-signature verification.
 *
 * Sensitive API routes (deploy, builder payouts, studio management) require
 * the caller to sign a canonical message with their wallet. We verify via
 * viem's `verifyMessage` (EIP-191 personal_sign), reject if:
 *   - timestamp skewed more than ±5 minutes
 *   - signature doesn't recover to the claimed wallet
 *   - message doesn't match the expected canonical form
 *
 * For /deploy specifically we also bind the signature to the paymentSessionId
 * so a captured signature for session A cannot be used to consume session B.
 */

import { verifyMessage, type Address } from "viem";

const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

export interface SignedRequest {
  wallet: string;      // 0x... (case-insensitive)
  timestamp: number;   // epoch ms
  signature: string;   // 0x... 65-byte signature
  action: string;      // e.g. "deploy" — must match expected
  /** Optional body-hash binding for actions that sign-over a request body. */
  bodyHash?: string;
}

export interface VerifyOptions {
  expectedAction: string;
  /** If provided, the recovered signer must (case-insensitively) match this wallet. */
  expectedWallet?: string;
  /** If provided, the message must include this sha256(body) hex. */
  expectedBodyHash?: string;
}

/**
 * Canonical message signed by the wallet. Keep the format stable — if you ever
 * change it, bump a version prefix so old signatures are rejected.
 */
export function buildSignedMessage(action: string, timestamp: number, bodyHash?: string): string {
  if (bodyHash) return `HLOne v1:${action}:${bodyHash}:${timestamp}`;
  return `HLOne v1:${action}:${timestamp}`;
}

/**
 * Verify a signature and return the recovered (lowercased) wallet on success,
 * or an error string.
 */
export async function verifyWalletSignature(
  req: SignedRequest,
  opts: VerifyOptions,
): Promise<{ ok: true; wallet: string } | { ok: false; error: string; status: number }> {
  // 1. Shape checks
  if (!req.wallet || !/^0x[0-9a-fA-F]{40}$/.test(req.wallet)) {
    return { ok: false, error: "Invalid wallet", status: 400 };
  }
  if (!req.signature || !/^0x[0-9a-fA-F]{130}$/.test(req.signature)) {
    return { ok: false, error: "Invalid signature", status: 400 };
  }
  if (typeof req.timestamp !== "number" || !Number.isFinite(req.timestamp)) {
    return { ok: false, error: "Invalid timestamp", status: 400 };
  }
  if (req.action !== opts.expectedAction) {
    return { ok: false, error: "Action mismatch", status: 400 };
  }

  // 2. Timestamp window — reject skewed OR future-dated signatures. We allow
  //    a small clock-skew (30s) into the future to accommodate honest drift.
  const now = Date.now();
  if (req.timestamp > now + 30_000) {
    return { ok: false, error: "Signature timestamp too far in the future", status: 401 };
  }
  if (now - req.timestamp > TIMESTAMP_WINDOW_MS) {
    return { ok: false, error: "Signature expired (>5min old)", status: 401 };
  }

  // 3. Body-hash binding (if specified)
  if (opts.expectedBodyHash && req.bodyHash !== opts.expectedBodyHash) {
    return { ok: false, error: "Body hash mismatch", status: 401 };
  }

  // 4. Verify signature
  const message = buildSignedMessage(req.action, req.timestamp, req.bodyHash);
  let valid = false;
  try {
    valid = await verifyMessage({
      address: req.wallet as Address,
      message,
      signature: req.signature as `0x${string}`,
    });
  } catch (err) {
    return { ok: false, error: "Signature verification threw: " + (err as Error).message, status: 401 };
  }
  if (!valid) {
    return { ok: false, error: "Signature invalid for wallet", status: 401 };
  }

  const recovered = req.wallet.toLowerCase();
  if (opts.expectedWallet && opts.expectedWallet.toLowerCase() !== recovered) {
    return { ok: false, error: "Signer does not match expected wallet", status: 403 };
  }

  return { ok: true, wallet: recovered };
}
