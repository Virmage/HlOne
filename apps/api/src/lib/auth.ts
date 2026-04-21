/**
 * Wallet signature verification for authenticated endpoints.
 *
 * Flow:
 * 1. Frontend signs a message: "HLOne:<action>:<timestamp>" with the user's wallet
 * 2. Backend recovers the signer address from the signature
 * 3. If recovered address matches the claimed walletAddress, the request is authentic
 *
 * Security:
 * - Timestamps must be within 5 minutes (stale-signature protection)
 * - verifyMessage ensures signature was produced by the claimed wallet
 *
 * We intentionally DO NOT track a used-signatures set for replay detection.
 * Retries (network hiccups, user double-clicks, React re-renders) all produce
 * legitimate duplicate requests that we want to allow — the underlying actions
 * (start/stop/pause copy) are idempotent and DB-level uniqueness handles dedup.
 * The timestamp window is sufficient protection against stored-signature attacks.
 */

import { verifyMessage } from "viem";

const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

export interface SignedRequest {
  walletAddress: string;
  signature: string;
  timestamp: number;
}

/**
 * Verify that `signature` was produced by `walletAddress` signing the expected message.
 * Returns the lowercase wallet address if valid, or throws.
 */
export async function verifyWalletSignature(
  walletAddress: string,
  signature: string,
  timestamp: number,
  action: string,
): Promise<string> {
  // Check timestamp freshness
  const age = Math.abs(Date.now() - timestamp);
  if (age > MAX_AGE_MS) {
    throw new Error("Signature expired — must be within 5 minutes. Refresh and try again.");
  }

  const message = `HLOne:${action}:${timestamp}`;

  const recovered = await verifyMessage({
    address: walletAddress as `0x${string}`,
    message,
    signature: signature as `0x${string}`,
  });

  if (!recovered) {
    throw new Error("Invalid signature — wallet address does not match signer");
  }

  return walletAddress.toLowerCase();
}
