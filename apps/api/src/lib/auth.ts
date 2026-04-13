/**
 * Wallet signature verification for authenticated endpoints.
 *
 * Flow:
 * 1. Frontend signs a message: "HLOne:<action>:<timestamp>" with the user's wallet
 * 2. Backend recovers the signer address from the signature
 * 3. If recovered address matches the claimed walletAddress, the request is authentic
 *
 * Timestamps must be within 5 minutes to prevent replay attacks.
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
    throw new Error("Signature expired — must be within 5 minutes");
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
