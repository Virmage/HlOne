/**
 * Derive (Lyra v2) Exchange — client-side order signing and submission.
 *
 * Users sign orders with their wallet (MetaMask/WalletConnect) using EIP-712.
 * Orders are submitted to Derive's REST API at https://api.lyra.finance.
 *
 * Supports options trading (calls/puts) on Derive protocol.
 * Uses session keys for authenticated trading and subaccounts for margin.
 */

import {
  type WalletClient,
  createPublicClient,
  http,
  encodeAbiParameters,
  parseAbiParameters,
  keccak256,
  concat,
  toHex,
  type Hex,
} from "viem";
import { dlog, dwarn, derror } from "./logger";
import { getDecrypted, setDecrypted } from "./crypto-storage";

const DERIVE_API = "https://api.lyra.finance";

// ─── Builder fee config ─────────────────────────────────────────────────────
// Extra fee in USDC charged per order (builder/integrator fee)
export const DERIVE_REFERRAL_CODE =
  process.env.NEXT_PUBLIC_DERIVE_REFERRAL_CODE ?? "";
export const DERIVE_EXTRA_FEE =
  process.env.NEXT_PUBLIC_DERIVE_EXTRA_FEE ?? "0.5"; // USDC
export const DERIVE_EXTRA_FEE_DISPLAY = `$${DERIVE_EXTRA_FEE} USDC`;

// ─── EIP-712 signing constants (from Derive protocol) ───────────────────────
// These are the on-chain constants used for order signing on Derive mainnet.
// ACTION_TYPEHASH = keccak256 of the Action struct type string
const ACTION_TYPEHASH =
  "0x4d7a9f27c403ff9c0f19bce61d76d82f9aa29f8d6d4b0c5474607d9770d1af17" as Hex;
const DOMAIN_SEPARATOR =
  "0xd96e5f90797da7ec8dc4e276260c7f3f87fedf68775fbe1ef116e996fc60441b" as Hex;

// Derive mainnet module addresses
const TRADE_MODULE_ADDRESS =
  "0xB8D20c2B7a1Ad2EE33Bc50eF10876eD3035b5e7b" as `0x${string}`;
const DEPOSIT_MODULE_ADDRESS =
  "0x9B3FE5E5a3bcEa5df4E08c41Ce89C4e3Ff01Ace3" as `0x${string}`;
// Cash asset (USDC representation on Derive L2)
const CASH_ASSET_ADDRESS =
  "0x57B03E14d409ADC7fAb6CFc44b5886CAD2D5f02b" as `0x${string}`;
// Standard Risk Manager — used as managerForNewAccount when creating subaccounts
const SRM_ADDRESS =
  "0x28c9ddF9A3B29c2E6a561c1BC520954e5A33de5D" as `0x${string}`;

// Well-known asset addresses (mainnet)
const ASSET_ADDRESSES: Record<string, `0x${string}`> = {
  ETH_OPTION: "0x4BB4C3CDc7562f08e9910A0C7D8bB7e108861eB4",
  BTC_OPTION: "0xd0711b9eBE84b778483709CDe62BacFDBAE13623",
  ETH_PERP: "0xAf65752C4643E25C02F693f9D4FE19cF23a095E3",
  BTC_PERP: "0xDBa83C0C654DB1cd914FA2710bA743e925B53086",
};

// ─── Derive wallet lookup (EOA → smart contract wallet) ────────────────────
// Derive uses Alchemy's LightAccountFactory on their L2 (chain 957).
// The smart contract wallet address is deterministic: factory.getAddress(owner, 0).
const DERIVE_CHAIN_RPC = "https://rpc.lyra.finance";
const LIGHT_ACCOUNT_FACTORY = "0x000000893A26168158fbeaDD9335Be5bC96592E2" as `0x${string}`;

const deriveRpcClient = createPublicClient({
  transport: http(DERIVE_CHAIN_RPC),
});

/**
 * Look up the Derive smart contract wallet for a given EOA.
 * Uses the LightAccountFactory's deterministic CREATE2 address.
 */
export async function lookupDeriveWallet(eoa: `0x${string}`): Promise<`0x${string}`> {
  const result = await deriveRpcClient.readContract({
    address: LIGHT_ACCOUNT_FACTORY,
    abi: [
      {
        name: "getAddress",
        type: "function",
        stateMutability: "view",
        inputs: [
          { name: "owner", type: "address" },
          { name: "salt", type: "uint256" },
        ],
        outputs: [{ name: "", type: "address" }],
      },
    ],
    functionName: "getAddress",
    args: [eoa, BigInt(0)],
  });
  dlog(`[derive] Looked up Derive wallet for ${eoa}: ${result}`);
  return result as `0x${string}`;
}

/**
 * Save a manually-entered Derive wallet address for a signer.
 */
export function saveDeriveWallet(signer: string, deriveWallet: string): void {
  const cacheKey = `derive-wallet-${signer.toLowerCase()}`;
  localStorage.setItem(cacheKey, deriveWallet); // keep checksummed
}

// ─── Scaling helpers (Derive uses 18-decimal fixed point) ───────────────────

function toWei(value: string | number): bigint {
  const str = typeof value === "number" ? value.toString() : value;
  const [whole, frac = ""] = str.split(".");
  const padded = frac.padEnd(18, "0").slice(0, 18);
  return BigInt(whole + padded);
}

/** Scale to 6-decimal (USDC native precision) */
function toWei6(value: string | number): bigint {
  const str = typeof value === "number" ? value.toString() : value;
  const [whole, frac = ""] = str.split(".");
  const padded = frac.padEnd(6, "0").slice(0, 6);
  return BigInt(whole + padded);
}

// ─── Nonce generation ───────────────────────────────────────────────────────

function generateNonce(): number {
  // Derive nonce format: UTC timestamp in ms + up to 3 random digits
  const ts = Date.now();
  const rand = Math.floor(Math.random() * 1000);
  return ts * 1000 + rand;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DeriveOrderParams {
  instrumentName: string;    // e.g. "ETH-20261231-5000-C"
  direction: "buy" | "sell";
  amount: string;            // in base units (e.g. "1.0" for 1 contract)
  limitPrice: string;        // in quote currency (USDC)
  maxFee: string;            // max fee per unit in USDC
  subaccountId: number;
  timeInForce?: "gtc" | "post_only" | "fok" | "ioc";
  orderType?: "limit" | "market";
  reduceOnly?: boolean;
  label?: string;
}

export interface DeriveOrderResult {
  success: boolean;
  orderId?: string;
  error?: string;
  rawResponse?: unknown;
}

export interface DeriveSubaccountResult {
  success: boolean;
  subaccountId?: number;
  error?: string;
}

// ─── Trade module data encoding ─────────────────────────────────────────────

/**
 * Encode trade module data for EIP-712 hashing.
 * TradeData struct: (address asset, uint256 subId, int256 limitPrice,
 *                    int256 amount, uint256 maxFee, uint256 subaccountId, bool isBid)
 */
function encodeTradeModuleData(params: {
  assetAddress: `0x${string}`;
  subId: bigint;
  limitPrice: bigint;  // 18-decimal signed
  amount: bigint;      // 18-decimal signed
  maxFee: bigint;      // 18-decimal unsigned
  subaccountId: bigint;
  isBid: boolean;
}): Hex {
  return encodeAbiParameters(
    parseAbiParameters(
      "address, uint256, int256, int256, uint256, uint256, bool",
    ),
    [
      params.assetAddress,
      params.subId,
      params.limitPrice,
      params.amount,
      params.maxFee,
      params.subaccountId,
      params.isBid,
    ],
  );
}

// ─── Deposit module data encoding ──────────────────────────────────────────

/**
 * Encode deposit module data for EIP-712 hashing.
 * DepositData struct: (uint256 amount, address asset, address managerForNewAccount)
 */
function encodeDepositModuleData(params: {
  amount: bigint;         // USDC in 6-decimal
  asset: `0x${string}`;  // Cash asset address
  managerForNewAccount: `0x${string}`; // SRM address (for new accounts), zero for existing
}): Hex {
  return encodeAbiParameters(
    parseAbiParameters("uint256, address, address"),
    [params.amount, params.asset, params.managerForNewAccount],
  );
}

// ─── Action hash (EIP-712) ──────────────────────────────────────────────────

/**
 * Compute the EIP-712 action hash for signing.
 *
 * ActionData struct:
 *   bytes32 actionTypehash
 *   uint256 subaccountId
 *   uint256 nonce
 *   address module
 *   bytes32 data        (keccak256 of encoded module data)
 *   uint256 expiry
 *   address owner
 *   address signer
 */
function computeActionHash(params: {
  subaccountId: bigint;
  nonce: bigint;
  module: `0x${string}`;
  encodedDataHash: Hex;
  expiry: bigint;
  owner: `0x${string}`;
  signer: `0x${string}`;
}): Hex {
  const encoded = encodeAbiParameters(
    parseAbiParameters(
      "bytes32, uint256, uint256, address, bytes32, uint256, address, address",
    ),
    [
      ACTION_TYPEHASH,
      params.subaccountId,
      params.nonce,
      params.module,
      params.encodedDataHash,
      params.expiry,
      params.owner,
      params.signer,
    ],
  );
  return keccak256(encoded);
}

/**
 * Compute the final EIP-712 hash: keccak256(0x1901 || domainSeparator || actionHash)
 */
function computeEip712Hash(actionHash: Hex): Hex {
  return keccak256(concat(["0x1901" as Hex, DOMAIN_SEPARATOR, actionHash]));
}

// ─── Parse instrument name ──────────────────────────────────────────────────

/**
 * Parse an instrument name to extract the underlying asset type.
 * e.g. "ETH-20261231-5000-C" -> { asset: "ETH", type: "OPTION" }
 * e.g. "ETH-PERP" -> { asset: "ETH", type: "PERP" }
 */
function parseInstrumentName(name: string): {
  asset: string;
  type: "OPTION" | "PERP";
  subId: bigint;
} {
  const parts = name.split("-");
  if (parts[1] === "PERP") {
    return {
      asset: parts[0]!,
      type: "PERP",
      subId: BigInt(0),
    };
  }
  // Options: ASSET-EXPIRY-STRIKE-TYPE (e.g. ETH-20261231-5000-C)
  // subId encodes the option parameters — for API submission we use 0
  // as the API resolves it from instrument_name
  return {
    asset: parts[0]!,
    type: "OPTION",
    subId: BigInt(0),
  };
}

function getAssetAddress(instrument: {
  asset: string;
  type: "OPTION" | "PERP";
}): `0x${string}` {
  const key = `${instrument.asset}_${instrument.type}`;
  const addr = ASSET_ADDRESSES[key];
  if (!addr) {
    throw new Error(
      `Unknown asset: ${key}. Supported: ${Object.keys(ASSET_ADDRESSES).join(", ")}`,
    );
  }
  return addr;
}

// ─── Sign order ─────────────────────────────────────────────────────────────

/**
 * Sign a Derive order using the stored session key. Throws
 * DeriveSessionKeyMissingError if no session key is available so the UI
 * can prompt the user to import one from derive.xyz.
 */
async function signOrder(
  _walletClient: WalletClient,
  address: `0x${string}`,
  params: {
    subaccountId: number;
    nonce: number;
    instrumentName: string;
    limitPrice: string;
    amount: string;
    maxFee: string;
    isBid: boolean;
    expiryTimestamp: number;
  },
): Promise<{ signature: Hex; signerAddress: `0x${string}` }> {
  const instrument = parseInstrumentName(params.instrumentName);
  const assetAddress = getAssetAddress(instrument);

  // Scale values to 18-decimal fixed point
  const limitPriceWei = toWei(params.limitPrice);
  const amountWei = toWei(params.amount);
  const maxFeeWei = toWei(params.maxFee);

  // Derive orders MUST be signed with a session key registered against the
  // subaccount on derive.xyz. EOA signatures are rejected by Derive's
  // validator as "signature invalid" — the EOA isn't on the signer list.
  // We used to silently fall back to EOA signing here, which produced that
  // exact confusing error. Now we throw a typed error so the UI can prompt
  // the user to (re-)import their session key from derive.xyz.
  const storedSessionKey = getStoredSessionKey(address);
  if (!storedSessionKey) {
    // Distinguish "no key at all" from "encrypted but locked".
    if (isSessionKeyEncrypted(address)) {
      throw new Error("Session key is locked. Open Security to unlock, then retry.");
    }
    throw new DeriveSessionKeyMissingError();
  }
  const { privateKeyToAccount } = await import("viem/accounts");
  const sessionAccount = privateKeyToAccount(storedSessionKey);
  const signerAddress = sessionAccount.address as `0x${string}`;
  const signFn = async (hash: Hex) => sessionAccount.signMessage({ message: { raw: hash } });
  dlog(`[derive] Signing order with session key: ${signerAddress}`);

  // Encode trade module data and hash it
  const encodedModuleData = encodeTradeModuleData({
    assetAddress,
    subId: instrument.subId,
    limitPrice: limitPriceWei,
    amount: amountWei,
    maxFee: maxFeeWei,
    subaccountId: BigInt(params.subaccountId),
    isBid: params.isBid,
  });
  const encodedDataHash = keccak256(encodedModuleData);

  // Compute the action hash (owner = Derive wallet or EOA, signer = session key or EOA)
  const actionHash = computeActionHash({
    subaccountId: BigInt(params.subaccountId),
    nonce: BigInt(params.nonce),
    module: TRADE_MODULE_ADDRESS,
    encodedDataHash,
    expiry: BigInt(params.expiryTimestamp),
    owner: address,
    signer: signerAddress,
  });

  // Compute the final EIP-712 hash and sign it
  const eip712Hash = computeEip712Hash(actionHash);
  const signature = await signFn(eip712Hash);

  return { signature, signerAddress };
}

// ─── API helpers ────────────────────────────────────────────────────────────

// ─── WebSocket transport ───────────────────────────────────────────────────
// All official Derive SDKs use WebSocket (not HTTP) for private endpoints.
// HTTP is blocked from datacenter IPs; WebSocket from the browser works
// because it uses the user's residential IP directly.
const DERIVE_WS_URL = "wss://api.lyra.finance/ws";

let ws: WebSocket | null = null;
let wsReady = false;
let wsLoggedIn = false;
let wsRequestId = 1;
const wsPending = new Map<number, {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

function ensureWs(): Promise<WebSocket> {
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(ws);
  if (ws && ws.readyState === WebSocket.CONNECTING) {
    return new Promise((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(ws!); };
      const onErr = (e: Event) => { cleanup(); reject(new Error("WebSocket connect failed")); };
      const cleanup = () => { ws!.removeEventListener("open", onOpen); ws!.removeEventListener("error", onErr); };
      ws!.addEventListener("open", onOpen);
      ws!.addEventListener("error", onErr);
    });
  }

  return new Promise((resolve, reject) => {
    wsReady = false;
    wsLoggedIn = false;
    ws = new WebSocket(DERIVE_WS_URL);

    ws.onopen = () => {
      wsReady = true;
      dlog("[derive-ws] Connected");
      resolve(ws!);
    };

    ws.onerror = (e) => {
      derror("[derive-ws] Error:", e);
      reject(new Error("WebSocket connection failed"));
    };

    ws.onclose = () => {
      dlog("[derive-ws] Closed");
      wsReady = false;
      wsLoggedIn = false;
      // Reject all pending requests
      for (const [id, p] of wsPending) {
        clearTimeout(p.timer);
        p.reject(new Error("WebSocket closed"));
      }
      wsPending.clear();
      ws = null;
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as Record<string, unknown>;
        const id = data.id as number;
        const pending = wsPending.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          wsPending.delete(id);
          pending.resolve(data);
        }
      } catch (err) {
        dwarn("[derive-ws] Failed to parse message:", err);
      }
    };
  });
}

// Login lock to prevent concurrent login attempts (race condition fix)
let wsLoginPromise: Promise<void> | null = null;

async function wsLogin(): Promise<void> {
  if (wsLoggedIn) return;
  // If another login is already in progress, wait for it
  if (wsLoginPromise) return wsLoginPromise;
  wsLoginPromise = wsLoginInner().finally(() => { wsLoginPromise = null; });
  return wsLoginPromise;
}

async function wsLoginInner(): Promise<void> {
  if (wsLoggedIn) return;
  const auth = getCachedDeriveAuth();
  if (!auth) throw new Error("No Derive auth cached — sign first");

  // Session key auth requires the Derive wallet address (the session key is registered against it)
  if (!auth.deriveWallet) {
    throw new Error("No Derive wallet address in cached auth — cannot login");
  }

  const sock = await ensureWs();

  // Only try the Derive smart contract wallet address.
  // The signature is from the session key, which is registered against this wallet.
  // Trying the EOA would fail because session keys aren't registered for it.
  const walletsToTry = [
    auth.deriveWallet,                    // checksummed from factory
    auth.deriveWallet.toLowerCase(),      // lowercased fallback
  ];
  // Deduplicate (case-insensitive dedup, keep first occurrence's casing)
  const seen = new Set<string>();
  const uniqueWallets = walletsToTry.filter(w => {
    const lower = w.toLowerCase();
    if (seen.has(lower)) return false;
    seen.add(lower);
    return true;
  });

  let lastError = "";
  for (const wallet of uniqueWallets) {
    const id = wsRequestId++;
    const loginParams = {
      wallet,
      timestamp: auth.timestamp,
      signature: auth.signature,
    };

    dlog(`[derive-ws] Trying login with wallet: ${wallet} (session key auth)`);

    const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const timer = setTimeout(() => {
        wsPending.delete(id);
        resolve({ ok: false, error: "Login timeout" });
      }, 10_000);

      wsPending.set(id, {
        resolve: (data) => {
          dlog(`[derive-ws] Login response (wallet=${wallet}):`, JSON.stringify(data).slice(0, 400));
          if (data.error) {
            const errObj = data.error as { code?: number; message?: string; data?: string };
            resolve({ ok: false, error: `[${errObj.code}] ${errObj.message}${errObj.data ? ` — ${errObj.data}` : ""}` });
          } else {
            resolve({ ok: true });
          }
        },
        reject: (err) => resolve({ ok: false, error: err.message }),
        timer,
      });

      sock.send(JSON.stringify({ method: "public/login", params: loginParams, id }));
    });

    if (result.ok) {
      wsLoggedIn = true;
      dlog(`[derive-ws] Login SUCCESS with wallet: ${wallet}`);
      return;
    }

    lastError = result.error || "Unknown error";
    dwarn(`[derive-ws] Login failed with wallet ${wallet}: ${lastError}`);
  }

  // If session key was rejected or account not found, clear stored session key
  // so next attempt re-generates and re-registers one
  if (lastError.includes("14000") || lastError.includes("session") || lastError.includes("signer")) {
    const eoa = cachedAuth?.signer;
    if (eoa) {
      try {
        localStorage.removeItem(`${DERIVE_SESSION_KEY_PREFIX}${eoa.toLowerCase()}`);
      } catch {}
      // Also clear the wallet cache
      try {
        localStorage.removeItem(`derive-wallet-${eoa.toLowerCase()}`);
      } catch {}
      dwarn(`[derive-ws] Cleared stale session key + wallet cache for ${eoa}`);
    }
    // Clear cached auth so getDeriveAuth() re-runs the full session key flow
    cachedAuth = null;
  }

  throw new Error(`Login failed (tried ${uniqueWallets.length} wallets): ${lastError}`);
}

async function wsSend(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  await ensureWs();
  if (method.startsWith("private/")) await wsLogin();

  const id = wsRequestId++;
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      wsPending.delete(id);
      reject(new Error(`Timeout: ${method}`));
    }, 15_000);

    wsPending.set(id, { resolve, reject, timer });

    ws!.send(JSON.stringify({ method, params, id }));
  });
}

/**
 * Send a request to Derive via WebSocket.
 * For private endpoints, auto-logs in with cached auth.
 * For public endpoints, no login needed.
 */
async function derivePost(
  endpoint: string,
  body: Record<string, unknown>,
  walletAddress?: string,
  _authHeaders?: { timestamp: string; signature: string },
): Promise<Record<string, unknown>> {
  // Convert endpoint path to method name: "/private/get_subaccounts" → "private/get_subaccounts"
  const method = endpoint.startsWith("/") ? endpoint.slice(1) : endpoint;

  // Pass wallet fields as-is (Derive API may be case-sensitive on checksummed addresses)
  const fixedBody = body;

  const data = await wsSend(method, fixedBody);

  // Handle error responses
  if (data.error && typeof data.error === "object") {
    const err = data.error as { code?: number; message?: string };
    if (err.code !== 14000) {
      throw new Error(err.message || `Derive error ${err.code}`);
    }
  }

  return data;
}

// ─── Session key management ─────────────────────────────────────────────────
// Derive requires a registered session key to sign timestamps for login.
// The EOA (MetaMask) cannot sign login requests directly — only session keys work.
// Flow: generate keypair → user approves registration via MetaMask → store locally.

export const DERIVE_SESSION_KEY_PREFIX = "hlone-derive-sk-";

/**
 * Reads the stored session key. Supports both plaintext and encrypted storage.
 * - If plaintext → returned directly (legacy / security disabled)
 * - If encrypted + unlocked (session password in memory) → decrypted via cache
 * - If encrypted + locked → returns null (UI prompts unlock)
 */
function getStoredSessionKey(eoa: string): `0x${string}` | null {
  try {
    const storageKey = `${DERIVE_SESSION_KEY_PREFIX}${eoa.toLowerCase()}`;
    // Check decrypted cache first (fast path, no crypto).
    // NOTE: cache is module-scoped in crypto-storage (not globalThis) to
    // prevent enumeration by any script on the page.
    const cached = getDecrypted(storageKey);
    if (cached && cached.startsWith("0x") && cached.length === 66) {
      return cached as `0x${string}`;
    }

    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;

    // Try parse as encrypted blob
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.v === 1 && parsed?.alg === "aes-gcm") {
        // Encrypted — can't decrypt synchronously here, caller must unlock first
        return null;
      }
    } catch {
      // Not JSON — treat as plaintext
    }

    // Plaintext legacy format
    if (raw.startsWith("0x") && raw.length === 66) return raw as `0x${string}`;
  } catch {}
  return null;
}

/**
 * Unlock encrypted session keys using the session password. Decrypted values
 * go into an in-memory cache for fast sync access. Must be called once after
 * page load before calling signing functions that depend on the session key.
 */
export async function unlockSessionKey(eoa: string, password: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const storageKey = `${DERIVE_SESSION_KEY_PREFIX}${eoa.toLowerCase()}`;
    const crypto = await import("./crypto-storage");
    const stored = crypto.readStoredValue(storageKey);
    if (!stored) return { ok: false, error: "No session key stored for this wallet" };
    if (!stored.encrypted) return { ok: true }; // already plaintext
    const plaintext = await crypto.decryptString(stored.blob, password);
    // Populate the module-scoped decrypted cache (NOT globalThis).
    setDecrypted(storageKey, plaintext);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Check if the stored session key is encrypted (needs unlocking).
 */
export function isSessionKeyEncrypted(eoa: string): boolean {
  try {
    const raw = localStorage.getItem(`${DERIVE_SESSION_KEY_PREFIX}${eoa.toLowerCase()}`);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return parsed?.v === 1 && parsed?.alg === "aes-gcm";
  } catch {
    return false;
  }
}

/**
 * Stores session key. If password is provided (security enabled), encrypts first.
 * Also populates the decrypted cache so the same-session reads work.
 */
function storeSessionKey(eoa: string, privateKey: `0x${string}`, password?: string): void {
  try {
    const storageKey = `${DERIVE_SESSION_KEY_PREFIX}${eoa.toLowerCase()}`;
    if (password) {
      // Encrypt async — we handle that via dynamic import below (fire and forget).
      // The decrypted cache is set synchronously so immediate reads work.
      setDecrypted(storageKey, privateKey);

      import("./crypto-storage").then(crypto =>
        crypto.writeStoredValue(storageKey, privateKey, password)
      ).catch(err => dwarn("[derive] Encrypted store failed:", err));
    } else {
      localStorage.setItem(storageKey, privateKey);
    }
  } catch {}
}

/**
 * Custom error thrown when no session key is stored — signals the UI to show
 * the import modal. Derive's session key registration requires a UserOp flow
 * with their private paymaster (SIWE-gated), so we can't register session keys
 * from a third-party domain. Users register via derive.xyz and paste here.
 */
export class DeriveSessionKeyMissingError extends Error {
  constructor() {
    super("No Derive session key found — user must import one from derive.xyz");
    this.name = "DeriveSessionKeyMissingError";
  }
}

/**
 * Get a Derive session key for this user, throwing if none is stored.
 * Session keys are imported from derive.xyz, not generated locally.
 *
 * Why? Derive's session key registration uses ERC-4337 UserOps with their
 * own paymaster. The paymaster endpoint (pro.derive.xyz/api/paymaster) is
 * SIWE-gated to derive.xyz's own frontend. We cannot register session keys
 * from a third-party domain without deploying our own paymaster.
 *
 * Workaround: user creates a session key via derive.xyz (Settings → Developer
 * → Create Session Key), copies the private key, pastes it into our app.
 * This is the same flow used by Hummingbot, CCXT, 8ball030/derive_client, etc.
 */
export async function ensureDeriveSessionKey(
  _walletClient: WalletClient,
  address: `0x${string}`,
  _deriveWallet: string,
): Promise<{ sessionKey: `0x${string}`; sessionAddress: string }> {
  const existing = getStoredSessionKey(address);
  if (!existing) {
    throw new DeriveSessionKeyMissingError();
  }
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(existing);
  dlog(`[derive] Using stored session key: ${account.address}`);
  return { sessionKey: existing, sessionAddress: account.address };
}

/**
 * Import a session key private key that the user created on derive.xyz.
 * Validates the key, derives the public address, and stores it in localStorage.
 * Returns the session address so the UI can display it.
 */
export async function importDeriveSessionKey(
  eoa: `0x${string}`,
  privateKeyHex: string,
): Promise<{ sessionAddress: string }> {
  const trimmed = privateKeyHex.trim();
  const key = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  if (key.length !== 66 || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("Invalid session key — must be a 64-character hex string (optionally 0x-prefixed)");
  }
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(key as `0x${string}`);

  // If user has security enabled, encrypt with their session password
  const crypto = await import("./crypto-storage");
  const password = crypto.getSessionPassword();
  storeSessionKey(eoa, key as `0x${string}`, password ?? undefined);
  dlog(`[derive] Imported session key: ${account.address} (${password ? "encrypted" : "plaintext"})`);
  return { sessionAddress: account.address };
}

/**
 * Remove a stored session key (e.g. when the user wants to re-import).
 */
export function clearDeriveSessionKey(eoa: string): void {
  try {
    localStorage.removeItem(`${DERIVE_SESSION_KEY_PREFIX}${eoa.toLowerCase()}`);
  } catch {}
}

/**
 * Check if a session key is stored for this EOA without revealing it.
 */
export function hasStoredSessionKey(eoa: string): boolean {
  return getStoredSessionKey(eoa) !== null;
}

// ─── Derive auth session ────────────────────────────────────────────────────
// Uses session key to sign timestamps for WebSocket login.
// Session key signs locally (no MetaMask popup on each login).

let cachedAuth: {
  signer: string;        // EOA that owns the account
  deriveWallet: string;  // Derive smart contract wallet
  sessionAddress: string; // Session key public address (the signer for login)
  timestamp: string;
  signature: string;
  expiresAt: number;
} | null = null;

/**
 * Get or create cached auth for Derive private endpoints.
 * Uses the session key (not EOA) to sign timestamps for login.
 * First-time setup requires one MetaMask popup to register the session key.
 */
export async function getDeriveAuth(
  walletClient: WalletClient,
  address: `0x${string}`,
  deriveWallet?: string,
): Promise<{ timestamp: string; signature: string }> {
  if (cachedAuth && cachedAuth.signer.toLowerCase() === address.toLowerCase() && Date.now() < cachedAuth.expiresAt) {
    return { timestamp: cachedAuth.timestamp, signature: cachedAuth.signature };
  }

  // Look up the Derive wallet automatically if not provided
  const resolvedDeriveWallet = deriveWallet || (await lookupDeriveWallet(address));

  // Ensure we have a session key (registers one if needed — one-time MetaMask popup)
  const { sessionKey, sessionAddress } = await ensureDeriveSessionKey(walletClient, address, resolvedDeriveWallet);

  // Sign the timestamp with the SESSION KEY (not EOA) — no MetaMask popup
  const { privateKeyToAccount } = await import("viem/accounts");
  const sessionAccount = privateKeyToAccount(sessionKey);
  const timestamp = Date.now().toString();
  const signature = await sessionAccount.signMessage({ message: timestamp });

  cachedAuth = {
    signer: address,
    deriveWallet: resolvedDeriveWallet,
    sessionAddress,
    timestamp,
    signature,
    expiresAt: Date.now() + 4 * 60_000, // 4 min (renew before 5 min limit)
  };

  return { timestamp, signature };
}

/**
 * Check if we have valid cached auth (avoid prompting wallet).
 */
export function hasCachedDeriveAuth(address: string): boolean {
  return !!cachedAuth && cachedAuth.signer.toLowerCase() === address.toLowerCase() && Date.now() < cachedAuth.expiresAt;
}

/**
 * Get cached auth without prompting (returns null if expired).
 */
export function getCachedDeriveAuth(): { timestamp: string; signature: string; deriveWallet?: string } | null {
  if (cachedAuth && Date.now() < cachedAuth.expiresAt) {
    return { timestamp: cachedAuth.timestamp, signature: cachedAuth.signature, deriveWallet: cachedAuth.deriveWallet };
  }
  return null;
}

/**
 * Get the cached Derive wallet address (returns null if no auth cached).
 */
export function getCachedDeriveWallet(): string | null {
  if (cachedAuth && Date.now() < cachedAuth.expiresAt) {
    return cachedAuth.deriveWallet;
  }
  return null;
}

/**
 * Raw version of derivePost — returns whatever the API sends back,
 * including error responses. Never throws. For debugging.
 */
export async function derivePostRaw(
  endpoint: string,
  body: Record<string, unknown>,
  walletAddress?: string,
): Promise<Record<string, unknown>> {
  try {
    const method = endpoint.startsWith("/") ? endpoint.slice(1) : endpoint;
    // Pass wallet fields as-is (Derive API may be case-sensitive on checksummed addresses)
    const data = await wsSend(method, body);
    return { _transport: "ws", ...data };
  } catch (err) {
    return { _transport: "ws", _error: (err as Error).message };
  }
}

// ─── Place order (main function) ────────────────────────────────────────────

/**
 * Place an options order on Derive.
 *
 * The user signs the order with their Ethereum wallet (via wagmi/viem).
 * The order is submitted to Derive's REST API with optional builder fee.
 */
export async function placeOrder(
  walletClient: WalletClient,
  address: `0x${string}`,
  params: DeriveOrderParams,
): Promise<DeriveOrderResult> {
  try {
    const nonce = generateNonce();
    const expiryTimestamp = Math.floor(Date.now() / 1000) + 600; // 10 min

    const isBid = params.direction === "buy";

    const { signature, signerAddress } = await signOrder(walletClient, address, {
      subaccountId: params.subaccountId,
      nonce,
      instrumentName: params.instrumentName,
      limitPrice: params.limitPrice,
      amount: params.amount,
      maxFee: params.maxFee,
      isBid,
      expiryTimestamp,
    });

    const body: Record<string, unknown> = {
      instrument_name: params.instrumentName,
      subaccount_id: params.subaccountId,
      direction: params.direction,
      amount: params.amount,
      limit_price: params.limitPrice,
      max_fee: params.maxFee,
      nonce,
      signature,
      signature_expiry_sec: expiryTimestamp,
      signer: signerAddress,
      order_type: params.orderType ?? "limit",
      time_in_force: params.timeInForce ?? "gtc",
      reduce_only: params.reduceOnly ?? false,
    };

    // Add builder fee if configured
    if (DERIVE_EXTRA_FEE && parseFloat(DERIVE_EXTRA_FEE) > 0) {
      body.extra_fee = DERIVE_EXTRA_FEE;
      body.referral_code = DERIVE_REFERRAL_CODE;
    }

    // Add optional label
    if (params.label) {
      body.label = params.label;
    }

    const result = await derivePost("/private/order", body, address);

    return {
      success: true,
      orderId: (result as { order_id?: string }).order_id,
      rawResponse: result,
    };
  } catch (err) {
    // Re-throw the missing-session-key sentinel so the UI can open the
    // import modal instead of just showing a generic failure string.
    if (err instanceof DeriveSessionKeyMissingError) throw err;
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

// ─── Place options order (convenience wrapper) ──────────────────────────────

export interface PlaceOptionOrderParams {
  underlying: "ETH" | "BTC" | "SOL" | "HYPE";
  expiry: string;           // e.g. "20261231"
  strike: string;           // e.g. "5000"
  optionType: "C" | "P";   // call or put
  direction: "buy" | "sell";
  amount: string;           // number of contracts
  limitPrice: string;       // price per contract in USDC
  maxFee: string;           // max fee per unit in USDC
  subaccountId: number;
  timeInForce?: "gtc" | "post_only" | "fok" | "ioc";
  reduceOnly?: boolean;
  label?: string;
}

/**
 * Place an options order with a friendlier interface.
 * Constructs the instrument_name from individual components.
 */
export async function placeOptionOrder(
  walletClient: WalletClient,
  address: `0x${string}`,
  params: PlaceOptionOrderParams,
): Promise<DeriveOrderResult> {
  const instrumentName = `${params.underlying}-${params.expiry}-${params.strike}-${params.optionType}`;

  return placeOrder(walletClient, address, {
    instrumentName,
    direction: params.direction,
    amount: params.amount,
    limitPrice: params.limitPrice,
    maxFee: params.maxFee,
    subaccountId: params.subaccountId,
    timeInForce: params.timeInForce,
    reduceOnly: params.reduceOnly,
    label: params.label,
  });
}

// ─── Deposit signing helper ─────────────────────────────────────────────────

/**
 * Sign a deposit action (used for both createSubaccount and deposit).
 * Uses session key if available (no MetaMask popup), otherwise falls back to EOA.
 */
async function signDepositAction(
  walletClient: WalletClient,
  address: `0x${string}`,
  params: {
    subaccountId: number; // 0 for new accounts
    amount: string;       // USDC amount as string
    nonce: number;
    expiryTimestamp: number;
    isNewAccount: boolean;
  },
): Promise<{ signature: Hex; signerAddress: `0x${string}` }> {
  const amountWei = toWei6(params.amount);

  // Determine signer: session key (no popup) or EOA (MetaMask popup)
  const storedSessionKey = getStoredSessionKey(address);
  let signerAddress: `0x${string}`;
  let signFn: (hash: Hex) => Promise<Hex>;

  if (storedSessionKey) {
    const { privateKeyToAccount } = await import("viem/accounts");
    const sessionAccount = privateKeyToAccount(storedSessionKey);
    signerAddress = sessionAccount.address as `0x${string}`;
    signFn = async (hash: Hex) => sessionAccount.signMessage({ message: { raw: hash } });
  } else {
    signerAddress = address;
    signFn = async (hash: Hex) => walletClient.signMessage({ account: address, message: { raw: hash } });
  }

  const encodedModuleData = encodeDepositModuleData({
    amount: amountWei,
    asset: CASH_ASSET_ADDRESS,
    managerForNewAccount: params.isNewAccount
      ? SRM_ADDRESS
      : ("0x0000000000000000000000000000000000000000" as `0x${string}`),
  });
  const encodedDataHash = keccak256(encodedModuleData);

  const actionHash = computeActionHash({
    subaccountId: BigInt(params.subaccountId),
    nonce: BigInt(params.nonce),
    module: DEPOSIT_MODULE_ADDRESS,
    encodedDataHash,
    expiry: BigInt(params.expiryTimestamp),
    owner: address,
    signer: signerAddress,
  });

  const eip712Hash = computeEip712Hash(actionHash);
  const signature = await signFn(eip712Hash);

  return { signature, signerAddress };
}

// ─── Create subaccount ──────────────────────────────────────────────────────

/**
 * Create a new subaccount on Derive with an initial deposit.
 * NOTE: Requires the wallet to already be registered on Derive (via derive.xyz).
 * Derive does not expose a public account creation API — users must onboard
 * through derive.xyz first.
 */
export async function createSubaccount(
  walletClient: WalletClient,
  address: `0x${string}`,
  params: {
    amount: string;        // initial deposit amount in USDC
    marginType: "PM" | "SM";
  },
): Promise<DeriveSubaccountResult> {
  try {
    const nonce = generateNonce();
    const expiryTimestamp = Math.floor(Date.now() / 1000) + 600;

    const { signature, signerAddress } = await signDepositAction(walletClient, address, {
      subaccountId: 0, // new account
      amount: params.amount,
      nonce,
      expiryTimestamp,
      isNewAccount: true,
    });

    const body: Record<string, unknown> = {
      amount: params.amount,
      asset_name: "USDC",
      margin_type: params.marginType,
      nonce,
      signature,
      signature_expiry_sec: expiryTimestamp,
      signer: signerAddress,
      wallet: address,
    };

    const result = await derivePost(
      "/private/create_subaccount",
      body,
      address,
    );

    // Check for subaccount_id in response
    const r = result as Record<string, unknown>;
    const subId = (r.subaccount_id as number) ??
      ((r.result as Record<string, unknown>)?.subaccount_id as number);

    return {
      success: true,
      subaccountId: subId,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

// ─── Deposit to existing subaccount ─────────────────────────────────────────

/**
 * Deposit USDC into an existing Derive subaccount.
 */
export async function depositToSubaccount(
  walletClient: WalletClient,
  address: `0x${string}`,
  params: {
    subaccountId: number;
    amount: string; // USDC amount
  },
): Promise<{ success: boolean; error?: string }> {
  try {
    const nonce = generateNonce();
    const expiryTimestamp = Math.floor(Date.now() / 1000) + 600;

    const { signature, signerAddress } = await signDepositAction(walletClient, address, {
      subaccountId: params.subaccountId,
      amount: params.amount,
      nonce,
      expiryTimestamp,
      isNewAccount: false,
    });

    await derivePost(
      "/private/deposit",
      {
        subaccount_id: params.subaccountId,
        amount: params.amount,
        asset_name: "USDC",
        nonce,
        signature,
        signature_expiry_sec: expiryTimestamp,
        signer: signerAddress,
      },
      address,
    );

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

// ─── Get account ───────────────────────────────────────────────────────────

/**
 * Check if a Derive account exists for this wallet.
 * Returns the account info or null if no account (error 14000).
 * THROWS on auth/network errors — callers must handle.
 */
export async function getAccount(
  walletAddress: string,
): Promise<Record<string, unknown> | null> {
  const result = await derivePost(
    "/private/get_account",
    { wallet: walletAddress },
    walletAddress,
    getCachedDeriveAuth() ?? undefined,
  );

  dlog("[derive] getAccount raw:", JSON.stringify(result).slice(0, 500));

  // Check for error response (code 14000 = account not found)
  if (result.error && typeof result.error === "object") {
    const err = result.error as { code?: number; message?: string };
    if (err.code === 14000) return null;
    throw new Error(err.message || `Derive error ${err.code}`);
  }

  const r = result as Record<string, unknown>;
  const inner = (r.result as Record<string, unknown>) ?? r;
  return inner;
}

// ─── Get subaccounts ────────────────────────────────────────────────────────

export async function getSubaccounts(
  walletAddress: string,
  auth?: { timestamp: string; signature: string },
): Promise<{ subaccountId: number; marginType: string; label: string }[]> {
  try {
    const result = await derivePost(
      "/private/get_subaccounts",
      { wallet: walletAddress },
      walletAddress,
      auth ?? getCachedDeriveAuth() ?? undefined,
    );

    dlog("[derive] getSubaccounts raw response:", JSON.stringify(result).slice(0, 800));

    // Check for error response (code 14000 = account not found)
    if (result.error && typeof result.error === "object") {
      const err = result.error as { code?: number; message?: string };
      dwarn("[derive] getSubaccounts API error:", err.code, err.message);
      return [];
    }

    // API may return { result: { subaccount_ids: [...] } } or { subaccounts: [...] }
    const r = result as Record<string, unknown>;
    const inner = (r.result as Record<string, unknown>) ?? r;
    const subaccountIds = (inner.subaccount_ids as number[]) ?? [];
    const subaccounts = (inner.subaccounts as Array<Record<string, unknown>>) ?? [];

    dlog("[derive] parsed: subaccountIds=", subaccountIds, "subaccounts=", subaccounts.length);

    if (subaccountIds.length > 0) {
      return subaccountIds.map((id) => ({
        subaccountId: id,
        marginType: "SM",
        label: "",
      }));
    }

    return subaccounts.map((s) => ({
      subaccountId: s.subaccount_id as number,
      marginType: (s.margin_type as string) ?? "SM",
      label: (s.label as string) ?? "",
    }));
  } catch (err) {
    derror("[derive] getSubaccounts failed:", (err as Error).message);
    return [];
  }
}

// ─── Get subaccount collaterals (balance check) ────────────────────────────

export interface DeriveCollateral {
  amount: number;
  assetName: string;
  markValue: number;
}

/**
 * Get USDC balance for a subaccount.
 * Returns the collateral amount (primarily USDC).
 */
export async function getCollaterals(
  walletAddress: string,
  subaccountId: number,
): Promise<DeriveCollateral[]> {
  try {
    const result = await derivePost(
      "/private/get_collaterals",
      { subaccount_id: subaccountId },
      walletAddress,
      getCachedDeriveAuth() ?? undefined,
    );

    const collaterals =
      ((result as Record<string, unknown>).result as Record<string, unknown>)
        ?.collaterals as Array<Record<string, unknown>> ??
      (result as { collaterals?: Array<Record<string, unknown>> })
        .collaterals ?? [];

    return collaterals.map((c) => ({
      amount: parseFloat((c.amount as string) ?? "0"),
      assetName: (c.asset_name as string) ?? "USDC",
      markValue: parseFloat((c.mark_value as string) ?? "0"),
    }));
  } catch {
    return [];
  }
}

/**
 * Get USDC balance for a subaccount (convenience wrapper).
 */
export async function getUsdcBalance(
  walletAddress: string,
  subaccountId: number,
): Promise<number> {
  const collaterals = await getCollaterals(walletAddress, subaccountId);
  const usdc = collaterals.find((c) => c.assetName === "USDC");
  return usdc?.amount ?? 0;
}

// ─── Get positions ─────────────────────────────────────────────────────────

export interface DerivePosition {
  instrumentName: string;
  direction: "buy" | "sell";
  amount: number;
  averagePrice: number;
  markPrice: number;
  indexPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  liquidationPrice: number;
  maintenanceMargin: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

/**
 * Get open positions for a subaccount.
 */
export async function getPositions(
  walletAddress: string,
  subaccountId: number,
): Promise<DerivePosition[]> {
  try {
    const result = await derivePost(
      "/private/get_positions",
      { subaccount_id: subaccountId },
      walletAddress,
      getCachedDeriveAuth() ?? undefined,
    );

    const r = result as Record<string, unknown>;
    const inner = (r.result as Record<string, unknown>) ?? r;
    const positions = (inner.positions as Array<Record<string, unknown>>) ?? [];

    return positions.map((p) => ({
      instrumentName: (p.instrument_name as string) ?? "",
      direction: (p.direction as "buy" | "sell") ?? "buy",
      amount: parseFloat((p.amount as string) ?? "0"),
      averagePrice: parseFloat((p.average_price as string) ?? "0"),
      markPrice: parseFloat((p.mark_price as string) ?? "0"),
      indexPrice: parseFloat((p.index_price as string) ?? "0"),
      unrealizedPnl: parseFloat((p.unrealized_pnl as string) ?? "0"),
      realizedPnl: parseFloat((p.realized_pnl as string) ?? "0"),
      liquidationPrice: parseFloat((p.liquidation_price as string) ?? "0"),
      maintenanceMargin: parseFloat((p.maintenance_margin as string) ?? "0"),
      delta: parseFloat((p.delta as string) ?? "0"),
      gamma: parseFloat((p.gamma as string) ?? "0"),
      theta: parseFloat((p.theta as string) ?? "0"),
      vega: parseFloat((p.vega as string) ?? "0"),
    }));
  } catch (err) {
    derror("[derive] getPositions failed:", (err as Error).message);
    return [];
  }
}

// ─── Get open orders ──────────────────────────────────────────────────────

export interface DeriveOpenOrder {
  orderId: string;
  instrumentName: string;
  direction: "buy" | "sell";
  amount: number;
  filledAmount: number;
  limitPrice: number;
  orderType: string;
  timeInForce: string;
  status: string;
  createdAt: number;
}

/**
 * Get open orders for a subaccount.
 */
export async function getOpenOrders(
  walletAddress: string,
  subaccountId: number,
): Promise<DeriveOpenOrder[]> {
  try {
    const result = await derivePost(
      "/private/get_open_orders",
      { subaccount_id: subaccountId },
      walletAddress,
      getCachedDeriveAuth() ?? undefined,
    );

    const r = result as Record<string, unknown>;
    const inner = (r.result as Record<string, unknown>) ?? r;
    const orders = (inner.orders as Array<Record<string, unknown>>) ?? [];

    return orders.map((o) => ({
      orderId: (o.order_id as string) ?? "",
      instrumentName: (o.instrument_name as string) ?? "",
      direction: (o.direction as "buy" | "sell") ?? "buy",
      amount: parseFloat((o.amount as string) ?? "0"),
      filledAmount: parseFloat((o.filled_amount as string) ?? "0"),
      limitPrice: parseFloat((o.limit_price as string) ?? "0"),
      orderType: (o.order_type as string) ?? "limit",
      timeInForce: (o.time_in_force as string) ?? "gtc",
      status: (o.status as string) ?? "open",
      createdAt: (o.created_timestamp_ms as number) ?? 0,
    }));
  } catch (err) {
    derror("[derive] getOpenOrders failed:", (err as Error).message);
    return [];
  }
}

// ─── Get instruments (for option discovery) ─────────────────────────────────

export interface DeriveInstrument {
  instrumentName: string;
  underlying: string;
  expiry: string;
  strike: string;
  optionType: "C" | "P" | null;
  isActive: boolean;
}

/**
 * Fetch available instruments from Derive.
 * Useful for discovering tradeable options contracts.
 */
export async function getInstruments(
  currency: string = "ETH",
  kind: "option" | "perp" = "option",
): Promise<DeriveInstrument[]> {
  try {
    const result = await derivePost("/public/get_instruments", {
      currency,
      kind,
      expired: false,
    });

    const instruments =
      (result as { result?: Array<Record<string, unknown>> }).result ?? [];

    return instruments.map((i) => ({
      instrumentName: i.instrument_name as string,
      underlying: currency,
      expiry: (i.expiry as string) ?? "",
      strike: (i.strike as string) ?? "",
      optionType: (i.option_type as "C" | "P" | null) ?? null,
      isActive: (i.is_active as boolean) ?? true,
    }));
  } catch {
    return [];
  }
}

// ─── Get ticker (for pricing) ───────────────────────────────────────────────

export interface DeriveTicker {
  instrumentName: string;
  bestBidPrice: string;
  bestAskPrice: string;
  markPrice: string;
  indexPrice: string;
  lastTradePrice: string;
  openInterest: string;
  iv: string; // implied volatility
}

export async function getTicker(
  instrumentName: string,
): Promise<DeriveTicker | null> {
  try {
    const result = await derivePost("/public/get_ticker", {
      instrument_name: instrumentName,
    });

    const data = result as Record<string, unknown>;
    return {
      instrumentName: data.instrument_name as string,
      bestBidPrice: (data.best_bid_price as string) ?? "0",
      bestAskPrice: (data.best_ask_price as string) ?? "0",
      markPrice: (data.mark_price as string) ?? "0",
      indexPrice: (data.index_price as string) ?? "0",
      lastTradePrice: (data.last_trade_price as string) ?? "0",
      openInterest: (data.open_interest as string) ?? "0",
      iv: (data.iv as string) ?? "0",
    };
  } catch {
    return null;
  }
}

// ─── Cancel order ───────────────────────────────────────────────────────────

export async function cancelOrder(
  walletClient: WalletClient,
  address: `0x${string}`,
  params: {
    orderId: string;
    subaccountId: number;
    instrumentName: string;
  },
): Promise<{ success: boolean; error?: string }> {
  try {
    const nonce = generateNonce();
    const expiryTimestamp = Math.floor(Date.now() / 1000) + 600;

    const signature = await walletClient.signMessage({
      account: address,
      message: {
        raw: toHex(
          `Cancel order: ${params.orderId} on ${params.instrumentName}`,
        ),
      },
    });

    await derivePost(
      "/private/cancel",
      {
        order_id: params.orderId,
        subaccount_id: params.subaccountId,
        instrument_name: params.instrumentName,
        nonce,
        signature,
        signature_expiry_sec: expiryTimestamp,
        signer: address,
      },
      address,
    );

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

// ─── Cancel all orders ──────────────────────────────────────────────────────

export async function cancelAllOrders(
  walletClient: WalletClient,
  address: `0x${string}`,
  subaccountId: number,
): Promise<{ success: boolean; error?: string }> {
  try {
    const nonce = generateNonce();
    const expiryTimestamp = Math.floor(Date.now() / 1000) + 600;

    const signature = await walletClient.signMessage({
      account: address,
      message: {
        raw: toHex(`Cancel all orders for subaccount: ${subaccountId}`),
      },
    });

    await derivePost(
      "/private/cancel_all",
      {
        subaccount_id: subaccountId,
        nonce,
        signature,
        signature_expiry_sec: expiryTimestamp,
        signer: address,
      },
      address,
    );

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
