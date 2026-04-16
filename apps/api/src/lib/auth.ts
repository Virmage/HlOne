/**
 * Wallet signature verification for authenticated endpoints.
 *
 * Flow:
 * 1. Frontend signs a message: "HLOne:<action>:<timestamp>" with the user's wallet
 * 2. Backend recovers the signer address from the signature
 * 3. If recovered address matches the claimed walletAddress, the request is authentic
 *
 * Timestamps must be within 5 minutes to prevent replay attacks.
 * Signature hashes are tracked to prevent replay within the window.
 */

import { verifyMessage } from "viem";

const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

// ─── Replay protection ──────────────────────────────────────────────────────
// Track used signature hashes to prevent replay attacks within the timestamp window.
// Each entry auto-expires after MAX_AGE_MS to avoid unbounded memory growth.
const usedSignatures = new Map<string, number>(); // signature hash → timestamp

// Prune expired signatures every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [sig, ts] of usedSignatures) {
    if (now - ts > MAX_AGE_MS + 10_000) { // 10s buffer
      usedSignatures.delete(sig);
    }
  }
}, 60_000);

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
    throw new Error("Signature expired — must be within 5 minutes");
  }

  // Check replay — same signature can't be used twice
  const sigKey = `${signature}:${action}`;
  if (usedSignatures.has(sigKey)) {
    throw new Error("Replay detected — this signature has already been used");
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

  // Mark signature as used (only after successful verification)
  usedSignatures.set(sigKey, Date.now());

  return walletAddress.toLowerCase();
}
