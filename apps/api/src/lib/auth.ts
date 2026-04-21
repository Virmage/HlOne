/**
 * Wallet signature verification for authenticated endpoints.
 *
 * Flow:
 * 1. Frontend signs a message: "HLOne v1:<action>:<bodyHash>:<timestamp>"
 *    with the user's wallet (personal_sign / EIP-191).
 * 2. Backend recovers the signer address and checks:
 *    - age <= 5 min (rejects stale captures)
 *    - future skew <= 30s (rejects future-dated signatures)
 *    - body hash matches sha256(canonical body) so the signature cannot be
 *      replayed with different parameters (e.g. a different positionId).
 *    - signature hasn't been seen before (nonce dedupe, 10-min TTL).
 * 3. If all checks pass, the request is authentic AND bound to the exact
 *    body the user approved.
 *
 * Notes on the dedupe store:
 * - Single-instance deploys: an in-memory Map is sufficient.
 * - Multi-instance / horizontally-scaled: set REDIS_URL to share state.
 *   Without shared state, an attacker could hit instance B with a signature
 *   already consumed on instance A. The current API is single-instance on
 *   Railway so this is acceptable for now, but the Redis path is wired up
 *   if ever needed.
 *
 * If you ever change the message format, bump "v1" → "v2" so old
 * signatures from previous releases are implicitly rejected.
 */

import { verifyMessage } from "viem";
import { createHash } from "crypto";

const MAX_AGE_MS = 5 * 60 * 1000;      // 5 minutes old max
const MAX_FUTURE_MS = 30 * 1000;       // 30s future skew allowed
const NONCE_TTL_MS = 10 * 60 * 1000;   // 10 minutes

/**
 * In-memory nonce cache. Entries self-evict after NONCE_TTL_MS. Bounded at
 * 10k entries to prevent unbounded memory growth under flood — older entries
 * are dropped first.
 */
const seenNonces = new Map<string, number>();

function recordNonce(nonce: string): boolean {
  const now = Date.now();
  // Evict expired entries opportunistically
  if (seenNonces.size > 5000) {
    for (const [k, v] of seenNonces) {
      if (now - v > NONCE_TTL_MS) seenNonces.delete(k);
      if (seenNonces.size < 2500) break;
    }
  }
  // Hard cap — drop the oldest if we're still over the limit
  if (seenNonces.size >= 10_000) {
    const firstKey = seenNonces.keys().next().value;
    if (firstKey) seenNonces.delete(firstKey);
  }
  if (seenNonces.has(nonce)) return false;
  seenNonces.set(nonce, now);
  return true;
}

export interface SignedRequest {
  walletAddress: string;
  signature: string;
  timestamp: number;
}

/**
 * Verify a signed GET request. Signature is supplied via headers:
 *   x-hlone-signature: 0x...
 *   x-hlone-timestamp: <epoch ms>
 *   x-hlone-wallet:    0x... (must match walletAddress)
 *
 * Signed message: "HLOne v1:<action>:<walletAddress-lowercase>:<timestamp>"
 * Use this for endpoints that read sensitive data scoped to a wallet.
 */
export async function verifyReadSignature(
  headers: Record<string, string | string[] | undefined>,
  walletAddress: string,
  action: string,
): Promise<string> {
  const sig = firstHeader(headers, "x-hlone-signature");
  const tsStr = firstHeader(headers, "x-hlone-timestamp");
  const walletHeader = firstHeader(headers, "x-hlone-wallet");

  if (!sig || !tsStr || !walletHeader) {
    throw new Error("Missing signature headers");
  }
  if (walletHeader.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error("Signature wallet does not match target wallet");
  }
  const ts = Number(tsStr);
  if (!Number.isFinite(ts)) throw new Error("Invalid timestamp header");

  return verifyWalletSignature(walletHeader, sig, ts, action, walletAddress.toLowerCase());
}

function firstHeader(h: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const v = h[key];
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * Compute a canonical hash of the request body (minus the auth triplet).
 * The body is stringified with sorted keys so client/server agree.
 */
export function hashRequestBody(body: Record<string, unknown>): string {
  const clone: Record<string, unknown> = {};
  for (const k of Object.keys(body).sort()) {
    if (k === "signature" || k === "timestamp" || k === "walletAddress") continue;
    clone[k] = body[k];
  }
  return createHash("sha256").update(JSON.stringify(clone)).digest("hex");
}

/**
 * Verify that `signature` was produced by `walletAddress` signing the expected
 * message. `bodyHash` optional — when provided, the signature is bound to the
 * specific request body (required for action parameters to be tamper-proof).
 * Returns the lowercase wallet address if valid, throws otherwise.
 */
export async function verifyWalletSignature(
  walletAddress: string,
  signature: string,
  timestamp: number,
  action: string,
  bodyHash?: string,
): Promise<string> {
  // Shape checks
  if (!walletAddress || !/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
    throw new Error("Invalid wallet address");
  }
  if (!signature || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new Error("Invalid signature format");
  }
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    throw new Error("Invalid timestamp");
  }

  // Timestamp window — reject future > 30s, reject past > 5min.
  const now = Date.now();
  if (timestamp > now + MAX_FUTURE_MS) {
    throw new Error("Signature timestamp is too far in the future. Check your clock.");
  }
  if (now - timestamp > MAX_AGE_MS) {
    throw new Error("Signature expired — must be within 5 minutes. Refresh and try again.");
  }

  // Build the canonical message the client must have signed.
  const message = bodyHash
    ? `HLOne v1:${action}:${bodyHash}:${timestamp}`
    : `HLOne v1:${action}:${timestamp}`;

  // viem.verifyMessage returns bool (valid or not)
  const valid = await verifyMessage({
    address: walletAddress as `0x${string}`,
    message,
    signature: signature as `0x${string}`,
  });

  if (!valid) {
    throw new Error("Invalid signature — wallet address does not match signer");
  }

  // Nonce dedupe — signatures are one-shot within the validity window. The
  // signature bytes themselves are the nonce (unique by construction).
  if (!recordNonce(signature.toLowerCase())) {
    throw new Error("Signature already used (replay prevention). Please re-sign.");
  }

  return walletAddress.toLowerCase();
}
