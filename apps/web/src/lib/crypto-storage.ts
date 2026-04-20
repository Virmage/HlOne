/**
 * crypto-storage — AES-GCM encryption for sensitive localStorage values.
 *
 * Used to encrypt Derive session keys + HL agent wallet private keys so XSS
 * or a compromised browser extension can't read them as plaintext.
 *
 * Scheme:
 *   - AES-GCM-256 (authenticated encryption, tamper-proof)
 *   - PBKDF2 key derivation (100k iterations, SHA-256) from user password
 *   - Fresh random salt (16 bytes) per encryption
 *   - Fresh random IV (12 bytes) per encryption
 *   - All via native Web Crypto API — no dependencies
 *
 * Stored format (JSON in localStorage):
 *   {
 *     "v": 1,           // format version
 *     "alg": "aes-gcm", // algorithm hint for future migrations
 *     "salt": "base64",
 *     "iv": "base64",
 *     "ct": "base64"    // ciphertext
 *   }
 *
 * Plaintext fallback: if a localStorage value doesn't parse as JSON or has no
 * `v` field, it's treated as plaintext (backward compat with unencrypted keys).
 */

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BITS = 256;

// ─── Encoding helpers ───────────────────────────────────────────────────────

function toB64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromB64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ─── Key derivation ─────────────────────────────────────────────────────────

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const passwordBytes = enc.encode(password);
  // Copy bytes into a dedicated ArrayBuffer to satisfy strict BufferSource typing
  const passwordBuffer = new ArrayBuffer(passwordBytes.byteLength);
  new Uint8Array(passwordBuffer).set(passwordBytes);
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    passwordBuffer,
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  const saltBuffer = new ArrayBuffer(salt.byteLength);
  new Uint8Array(saltBuffer).set(salt);
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    passwordKey,
    { name: "AES-GCM", length: KEY_BITS },
    false,
    ["encrypt", "decrypt"],
  );
}

// ─── Encrypt / decrypt ──────────────────────────────────────────────────────

export interface EncryptedBlob {
  v: 1;
  alg: "aes-gcm";
  salt: string;
  iv: string;
  ct: string;
}

/** Convert a Uint8Array to a fresh ArrayBuffer (for strict BufferSource typing). */
function toArrayBuffer(arr: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(arr.byteLength);
  new Uint8Array(buf).set(arr);
  return buf;
}

export async function encryptString(plaintext: string, password: string): Promise<EncryptedBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt);
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(plaintextBytes),
  );
  return {
    v: 1,
    alg: "aes-gcm",
    salt: toB64(salt),
    iv: toB64(iv),
    ct: toB64(new Uint8Array(ciphertext)),
  };
}

export async function decryptString(blob: EncryptedBlob, password: string): Promise<string> {
  if (blob.v !== 1 || blob.alg !== "aes-gcm") {
    throw new Error(`Unsupported encryption format: v${blob.v} ${blob.alg}`);
  }
  const salt = fromB64(blob.salt);
  const iv = fromB64(blob.iv);
  const ct = fromB64(blob.ct);
  const key = await deriveKey(password, salt);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(ct),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    // AES-GCM auth failure = wrong password or tampered data
    throw new Error("Decryption failed — wrong password or corrupted data");
  }
}

// ─── Storage wrappers ───────────────────────────────────────────────────────

/**
 * Check if a stored value is encrypted (vs plaintext).
 */
export function isEncryptedBlob(raw: string): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.v === 1 && parsed?.alg === "aes-gcm" && typeof parsed?.salt === "string";
  } catch {
    return false;
  }
}

/**
 * Read raw value from localStorage without decryption. Returns:
 *   - { encrypted: true, blob } if it's an encrypted blob (caller must decrypt)
 *   - { encrypted: false, plaintext } if it's unencrypted (legacy / unencrypted mode)
 *   - null if nothing stored
 */
export function readStoredValue(key: string): { encrypted: true; blob: EncryptedBlob } | { encrypted: false; plaintext: string } | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    if (isEncryptedBlob(raw)) {
      return { encrypted: true, blob: JSON.parse(raw) as EncryptedBlob };
    }
    return { encrypted: false, plaintext: raw };
  } catch {
    return null;
  }
}

/**
 * Write a value to localStorage, encrypting if password is provided.
 */
export async function writeStoredValue(key: string, value: string, password?: string): Promise<void> {
  if (!password) {
    localStorage.setItem(key, value);
    return;
  }
  const blob = await encryptString(value, password);
  localStorage.setItem(key, JSON.stringify(blob));
}

/**
 * Re-encrypt all matching keys with a new password (or decrypt to plaintext).
 * Used when user enables, disables, or changes their security password.
 *
 * @param keyPrefix  localStorage key prefix to match (e.g. "hlone-derive-sk-")
 * @param oldPassword Current password (undefined if currently plaintext)
 * @param newPassword New password (undefined to decrypt to plaintext)
 */
export async function rekeyStoredValues(
  keyPrefix: string,
  oldPassword: string | undefined,
  newPassword: string | undefined,
): Promise<{ rekeyed: number; errors: string[] }> {
  const errors: string[] = [];
  let rekeyed = 0;
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(keyPrefix)) keys.push(k);
  }

  for (const k of keys) {
    try {
      const current = readStoredValue(k);
      if (!current) continue;
      let plaintext: string;
      if (current.encrypted) {
        if (!oldPassword) {
          errors.push(`${k} is encrypted but no password provided`);
          continue;
        }
        plaintext = await decryptString(current.blob, oldPassword);
      } else {
        plaintext = current.plaintext;
      }
      await writeStoredValue(k, plaintext, newPassword);
      rekeyed++;
    } catch (err) {
      errors.push(`${k}: ${(err as Error).message}`);
    }
  }
  return { rekeyed, errors };
}

// ─── Security state marker ──────────────────────────────────────────────────
// A tiny sentinel we encrypt on enable, so we can verify the password later
// without needing to decrypt a real key.

const VERIFY_KEY = "hlone-security-verify";
const VERIFY_PLAINTEXT = "hlone-ok";

export async function setSecurityPassword(password: string): Promise<void> {
  const blob = await encryptString(VERIFY_PLAINTEXT, password);
  localStorage.setItem(VERIFY_KEY, JSON.stringify(blob));
}

export async function verifySecurityPassword(password: string): Promise<boolean> {
  try {
    const raw = localStorage.getItem(VERIFY_KEY);
    if (!raw) return false;
    const blob = JSON.parse(raw) as EncryptedBlob;
    const plaintext = await decryptString(blob, password);
    return plaintext === VERIFY_PLAINTEXT;
  } catch {
    return false;
  }
}

export function isSecurityEnabled(): boolean {
  try {
    return !!localStorage.getItem(VERIFY_KEY);
  } catch {
    return false;
  }
}

export function disableSecurityPassword(): void {
  try {
    localStorage.removeItem(VERIFY_KEY);
  } catch {}
}

// ─── In-memory decrypted key cache ──────────────────────────────────────────
// When the user unlocks, we hold decrypted keys here for the session.
// Module-level, cleared on page refresh. Never persisted.

const decryptedCache = new Map<string, string>();

export function getDecrypted(key: string): string | null {
  return decryptedCache.get(key) ?? null;
}

export function setDecrypted(key: string, value: string): void {
  decryptedCache.set(key, value);
}

export function clearDecryptedCache(): void {
  decryptedCache.clear();
}

// ─── Session password cache ─────────────────────────────────────────────────
// The password itself lives in memory only (not localStorage / sessionStorage)
// for the lifetime of the tab. User re-enters after refresh.

let sessionPassword: string | null = null;

export function getSessionPassword(): string | null {
  return sessionPassword;
}

export function setSessionPassword(password: string | null): void {
  sessionPassword = password;
}
