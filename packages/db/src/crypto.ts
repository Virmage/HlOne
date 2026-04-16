/**
 * AES-256-GCM encryption for agent private keys.
 *
 * Keys are encrypted before storage and decrypted when needed for signing.
 * The encryption key comes from the AGENT_ENCRYPTION_KEY env var (64 hex chars = 32 bytes).
 *
 * Format: base64(iv:authTag:ciphertext)
 *   - iv: 12 bytes (standard for GCM)
 *   - authTag: 16 bytes
 *   - ciphertext: variable length
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const key = process.env.AGENT_ENCRYPTION_KEY;
  if (!key) {
    throw new Error(
      "AGENT_ENCRYPTION_KEY not set — required for agent wallet security. " +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  if (!/^[a-fA-F0-9]{64}$/.test(key)) {
    throw new Error("AGENT_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)");
  }
  return Buffer.from(key, "hex");
}

/**
 * Encrypt a private key (hex string) for database storage.
 * Returns a base64-encoded string containing iv + authTag + ciphertext.
 */
export function encryptPrivateKey(privateKeyHex: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([
    cipher.update(privateKeyHex, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Pack: iv + authTag + ciphertext
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return packed.toString("base64");
}

/**
 * Decrypt a private key from database storage.
 * Input is the base64 string from encryptPrivateKey().
 * Returns the original hex private key string.
 */
export function decryptPrivateKey(encryptedBase64: string): string {
  const key = getEncryptionKey();

  const packed = Buffer.from(encryptedBase64, "base64");
  if (packed.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    throw new Error("Invalid encrypted key format — data too short");
  }

  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

/**
 * Check if a value looks like it's already encrypted (base64 format)
 * vs a raw hex private key (0x prefix, 66 chars).
 * Useful during migration from unencrypted to encrypted storage.
 */
export function isEncrypted(value: string): boolean {
  // Raw hex private keys start with 0x and are 66 chars
  if (value.startsWith("0x") && value.length === 66) return false;
  // Encrypted values are base64 and longer than a raw key
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.length >= IV_LENGTH + AUTH_TAG_LENGTH + 1;
  } catch {
    return false;
  }
}
