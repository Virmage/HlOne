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
  encodeAbiParameters,
  parseAbiParameters,
  keccak256,
  concat,
  toHex,
  type Hex,
} from "viem";

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

export interface DeriveSessionKeyResult {
  success: boolean;
  sessionKey?: string;
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
 * Sign a Derive order using the user's wallet via EIP-712.
 * Returns the signature hex string.
 */
async function signOrder(
  walletClient: WalletClient,
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
    signerAddress: `0x${string}`;
  },
): Promise<Hex> {
  const instrument = parseInstrumentName(params.instrumentName);
  const assetAddress = getAssetAddress(instrument);

  // Scale values to 18-decimal fixed point
  const limitPriceWei = toWei(params.limitPrice);
  const amountWei = toWei(params.amount);
  const maxFeeWei = toWei(params.maxFee);

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

  // Compute the action hash
  const actionHash = computeActionHash({
    subaccountId: BigInt(params.subaccountId),
    nonce: BigInt(params.nonce),
    module: TRADE_MODULE_ADDRESS,
    encodedDataHash,
    expiry: BigInt(params.expiryTimestamp),
    owner: address,
    signer: params.signerAddress,
  });

  // Compute the final EIP-712 hash
  const eip712Hash = computeEip712Hash(actionHash);

  // Sign the raw hash with the user's wallet
  // Derive expects a signature of the pre-hashed EIP-712 message
  const signature = await walletClient.signMessage({
    account: address,
    message: { raw: eip712Hash },
  });

  return signature;
}

// ─── API helpers ────────────────────────────────────────────────────────────

// Derive proxy runs as a Next.js API route (Vercel serverless, US region).
// This avoids Derive's geo-blocking of AU/restricted server IPs on Railway.
// In production: same-origin "/api/derive-proxy". Dev: local Next.js server.
const DERIVE_PROXY_URL = "";

async function derivePost(
  endpoint: string,
  body: Record<string, unknown>,
  walletAddress?: string,
  authHeaders?: { timestamp: string; signature: string },
): Promise<Record<string, unknown>> {
  // Private endpoints go through our backend proxy to avoid CORS
  if (endpoint.startsWith("/private/")) {
    // Auto-attach cached auth if none provided
    const auth = authHeaders ?? getCachedDeriveAuth() ?? undefined;
    // Derive requires lowercase wallet addresses everywhere
    const walletLower = walletAddress?.toLowerCase();
    // Also lowercase any wallet field in the body
    const fixedBody = body.wallet && typeof body.wallet === "string"
      ? { ...body, wallet: (body.wallet as string).toLowerCase() }
      : body;
    const res = await fetch(`${DERIVE_PROXY_URL}/api/derive-proxy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint,
        body: fixedBody,
        wallet: walletLower,
        authTimestamp: auth?.timestamp,
        authSignature: auth?.signature,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Derive proxy error: ${res.status} ${text}`);
    }

    const data = await res.json() as Record<string, unknown>;
    // Derive returns 200 with { error: { code, message } } for app-level errors
    if (data.error && typeof data.error === "object") {
      const err = data.error as { code?: number; message?: string };
      // 14000 = "Account not found" — not a hard error, just means no account yet
      if (err.code !== 14000) {
        throw new Error(err.message || `Derive error ${err.code}`);
      }
    }
    return data;
  }

  // Public endpoints can go direct
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const res = await fetch(`${DERIVE_API}${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Derive API error: ${res.status} ${text}`);
  }

  const data = await res.json() as Record<string, unknown>;
  if (data.error && typeof data.error === "object") {
    const err = data.error as { code?: number; message?: string };
    if (err.code !== 14000) {
      throw new Error(err.message || `Derive error ${err.code}`);
    }
  }
  return data;
}

// ─── Derive auth session ────────────────────────────────────────────────────
// Sign a timestamp once, cache it for up to 5 minutes so we can poll
// private endpoints without prompting the user for every request.

let cachedAuth: { wallet: string; timestamp: string; signature: string; expiresAt: number } | null = null;

/**
 * Get or create cached auth headers for Derive private endpoints.
 * Signs once with the wallet, reuses for ~5 minutes.
 */
export async function getDeriveAuth(
  walletClient: WalletClient,
  address: `0x${string}`,
): Promise<{ timestamp: string; signature: string }> {
  if (cachedAuth && cachedAuth.wallet.toLowerCase() === address.toLowerCase() && Date.now() < cachedAuth.expiresAt) {
    return { timestamp: cachedAuth.timestamp, signature: cachedAuth.signature };
  }

  const timestamp = Date.now().toString();
  const signature = await walletClient.signMessage({
    account: address,
    message: timestamp,
  });

  cachedAuth = {
    wallet: address,
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
  return !!cachedAuth && cachedAuth.wallet.toLowerCase() === address.toLowerCase() && Date.now() < cachedAuth.expiresAt;
}

/**
 * Get cached auth without prompting (returns null if expired).
 */
export function getCachedDeriveAuth(): { timestamp: string; signature: string } | null {
  if (cachedAuth && Date.now() < cachedAuth.expiresAt) {
    return { timestamp: cachedAuth.timestamp, signature: cachedAuth.signature };
  }
  return null;
}

/**
 * Authenticated version of derivePost for private endpoints.
 */
async function derivePostAuth(
  endpoint: string,
  body: Record<string, unknown>,
  walletAddress: string,
  auth: { timestamp: string; signature: string },
): Promise<Record<string, unknown>> {
  return derivePost(endpoint, body, walletAddress, auth);
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

    const signature = await signOrder(walletClient, address, {
      subaccountId: params.subaccountId,
      nonce,
      instrumentName: params.instrumentName,
      limitPrice: params.limitPrice,
      amount: params.amount,
      maxFee: params.maxFee,
      isBid,
      expiryTimestamp,
      signerAddress: address,
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
      signer: address,
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
 * Uses proper EIP-712 hashing with the Deposit Module.
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
): Promise<Hex> {
  const amountWei = toWei6(params.amount);

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
    signer: address,
  });

  const eip712Hash = computeEip712Hash(actionHash);

  return walletClient.signMessage({
    account: address,
    message: { raw: eip712Hash },
  });
}

// ─── Create subaccount ──────────────────────────────────────────────────────

/**
 * Create a new subaccount on Derive with an initial deposit.
 * Uses proper EIP-712 signing with the Deposit Module.
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

    const signature = await signDepositAction(walletClient, address, {
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
      signer: address,
      wallet: address,
    };

    const result = await derivePost(
      "/private/create_subaccount",
      body,
      address,
    );

    return {
      success: true,
      subaccountId: (result as { subaccount_id?: number }).subaccount_id,
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

    const signature = await signDepositAction(walletClient, address, {
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

    // API may return { result: { subaccount_ids: [...] } } or { subaccounts: [...] }
    const r = result as Record<string, unknown>;
    const inner = (r.result as Record<string, unknown>) ?? r;
    const subaccountIds = (inner.subaccount_ids as number[]) ?? [];
    const subaccounts = (inner.subaccounts as Array<Record<string, unknown>>) ?? [];

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
    console.error("[derive] getSubaccounts failed:", (err as Error).message);
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

// ─── Session key management ─────────────────────────────────────────────────

/**
 * Register a session key for the user's account.
 *
 * Session keys allow programmatic trading without requiring the user's
 * main wallet to sign every order. The session key is simply another
 * Ethereum wallet that gets temporary admin access.
 *
 * Derive requires a signed raw transaction (RLP-encoded) to register
 * an admin-level session key. The user signs a special transaction
 * that grants the session key access.
 */
export async function registerSessionKey(
  walletClient: WalletClient,
  address: `0x${string}`,
  params: {
    sessionPublicKey: `0x${string}`;  // the session key's address
    label?: string;
    expiryTimestamp?: number;          // when the session key expires
  },
): Promise<DeriveSessionKeyResult> {
  try {
    const expiry =
      params.expiryTimestamp ??
      Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30; // 30 days default

    // Derive registers admin session keys via a signed raw transaction.
    // The transaction encodes the session key registration parameters.
    // We construct and sign a typed transaction to register the key.
    const registrationData = encodeAbiParameters(
      parseAbiParameters("address, uint256"),
      [params.sessionPublicKey, BigInt(expiry)],
    );

    // Sign the registration with the user's wallet
    const signature = await walletClient.signMessage({
      account: address,
      message: { raw: keccak256(registrationData) },
    });

    // The API expects a signed raw transaction hex
    const body: Record<string, unknown> = {
      wallet: address,
      public_session_key: params.sessionPublicKey,
      label: params.label ?? "derive-exchange-sdk",
      expiry_sec: expiry,
      signed_raw_tx: signature,
    };

    const result = await derivePost("/public/register_session_key", body);

    return {
      success: true,
      sessionKey: params.sessionPublicKey,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Register a scoped (non-admin) session key.
 * Useful for read-only or account-level access without full trading permissions.
 */
export async function registerScopedSessionKey(
  walletClient: WalletClient,
  address: `0x${string}`,
  params: {
    sessionPublicKey: `0x${string}`;
    scope: "read_only" | "account";
    label?: string;
    expiryTimestamp?: number;
  },
): Promise<DeriveSessionKeyResult> {
  try {
    const expiry =
      params.expiryTimestamp ??
      Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
    const nonce = generateNonce();
    const signatureExpiry = Math.floor(Date.now() / 1000) + 600;

    const signature = await walletClient.signMessage({
      account: address,
      message: {
        raw: toHex(
          `Register session key: ${params.sessionPublicKey} scope: ${params.scope}`,
        ),
      },
    });

    const body: Record<string, unknown> = {
      wallet: address,
      public_session_key: params.sessionPublicKey,
      label: params.label ?? "derive-exchange-sdk",
      expiry_sec: expiry,
      nonce,
      signature,
      signature_expiry_sec: signatureExpiry,
      signer: address,
      scope: params.scope,
    };

    const result = await derivePost(
      "/private/register_scoped_session_key",
      body,
      address,
    );

    return {
      success: true,
      sessionKey: params.sessionPublicKey,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
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
