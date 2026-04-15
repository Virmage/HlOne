/**
 * Hyperliquid Exchange — client-side order signing and submission.
 *
 * Uses the "agent wallet" pattern:
 * 1. First trade: generate a local keypair, MetaMask signs approveAgent (chainId 42161)
 * 2. All subsequent trades: sign locally with the agent key (no MetaMask popup)
 *
 * This bypasses MetaMask's chainId validation for L1 actions (which require 1337).
 */

import type { WalletClient } from "viem";
import { keccak256 } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { encode as msgpackEncode } from "@msgpack/msgpack";
import { getAccount } from "@wagmi/core";
import { config } from "@/config/wagmi";

const HL_API = "https://api.hyperliquid.xyz";

// ─── Builder fee config ─────────────────────────────────────────────────────
export const BUILDER_ADDRESS = "0xbB0f753321e2B5FD29Bd1d14b532f5B54959ae63";
export const BUILDER_FEE = 15; // 1.5 bps in tenths-of-bps
export const BUILDER_FEE_PERCENT = 0.00015;
export const BUILDER_FEE_DISPLAY = "0.015%";

// ─── Agent wallet management ────────────────────────────────────────────────
// Agent wallets are local keypairs authorized by the user's main wallet.
// They sign L1 actions locally (no MetaMask popup, no chainId validation).

const AGENT_STORAGE_PREFIX = "hlone-agent-";

function getStoredAgent(userAddress: string): `0x${string}` | null {
  try {
    const key = localStorage.getItem(`${AGENT_STORAGE_PREFIX}${userAddress.toLowerCase()}`);
    if (key && key.startsWith("0x") && key.length === 66) return key as `0x${string}`;
  } catch {}
  return null;
}

function storeAgent(userAddress: string, privateKey: `0x${string}`): void {
  try {
    localStorage.setItem(`${AGENT_STORAGE_PREFIX}${userAddress.toLowerCase()}`, privateKey);
  } catch {}
}

function clearStoredAgent(userAddress: string): void {
  try {
    localStorage.removeItem(`${AGENT_STORAGE_PREFIX}${userAddress.toLowerCase()}`);
    console.log("[agent] Cleared stored agent for", userAddress.slice(0, 8) + "...");
  } catch {}
}

/** Normalize v to 27/28 — some wallets return 0/1 */
function normalizeV(v: number): number {
  return v < 27 ? v + 27 : v;
}

async function approveAgentOnChain(
  walletClient: WalletClient,
  userAddress: string,
  agentAddress: string,
): Promise<{ success: boolean; error?: string }> {
  const nonce = Date.now();
  const agentAddr = agentAddress;

  const action = {
    type: "approveAgent",
    hyperliquidChain: "Mainnet",
    signatureChainId: "0xa4b1",
    agentAddress: agentAddr,
    agentName: "HLOne",
    nonce,
  };

  // Use viem's signTypedData — handles wallet compatibility natively
  console.log("[approveAgent] Requesting signature for agent:", agentAddr.slice(0, 10) + "...", "user:", userAddress.slice(0, 10) + "...");

  const signature = await walletClient.signTypedData({
    account: userAddress as `0x${string}`,
    domain: {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: 42161,
      verifyingContract: "0x0000000000000000000000000000000000000000" as `0x${string}`,
    },
    types: {
      "HyperliquidTransaction:ApproveAgent": [
        { name: "hyperliquidChain", type: "string" },
        { name: "agentAddress", type: "address" },
        { name: "agentName", type: "string" },
        { name: "nonce", type: "uint64" },
      ],
    },
    primaryType: "HyperliquidTransaction:ApproveAgent",
    message: {
      hyperliquidChain: "Mainnet",
      agentAddress: agentAddr as `0x${string}`,
      agentName: "HLOne",
      nonce: BigInt(nonce),
    },
  });

  console.log("[approveAgent] Got signature:", signature.slice(0, 12) + "...");

  const r = signature.slice(0, 66);
  const s = `0x${signature.slice(66, 130)}`;
  const v = normalizeV(parseInt(signature.slice(130, 132), 16));

  const res = await fetch(`${HL_API}/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action,
      nonce,
      signature: { r, s, v },
      vaultAddress: null,
    }),
  });

  const result = await res.json();
  console.log("[approveAgent] API response:", JSON.stringify(result));

  if ((result as { status?: string }).status === "ok") {
    return { success: true };
  }
  const apiErr = (result as { response?: string }).response
    || (result as { error?: string }).error
    || JSON.stringify(result);
  return { success: false, error: `Agent approval API: ${apiErr}` };
}

/**
 * Get or create an agent wallet for the user.
 * First call triggers a MetaMask popup to approve the agent.
 * Subsequent calls return the stored agent key instantly.
 */
export async function ensureAgent(
  walletClient: WalletClient,
  userAddress: `0x${string}`,
): Promise<{ agentKey: `0x${string}`; error?: string }> {
  // Check if we already have an agent
  const stored = getStoredAgent(userAddress);
  if (stored) {
    console.log("[agent] Using stored agent for", userAddress.slice(0, 8) + "...");
    return { agentKey: stored };
  }

  // Generate new agent keypair
  console.log("[agent] Generating new agent wallet...");
  const agentKey = generatePrivateKey();
  const agentAccount = privateKeyToAccount(agentKey);
  console.log("[agent] Agent address:", agentAccount.address, "for user:", userAddress.slice(0, 10) + "...");

  // Approve agent on-chain (MetaMask popup — one time only)
  const result = await approveAgentOnChain(walletClient, userAddress, agentAccount.address);
  if (!result.success) {
    return { agentKey: "0x" as `0x${string}`, error: result.error };
  }

  // Wait for HL to register the new agent before we use it
  console.log("[agent] Approval OK, waiting 2s for propagation...");
  await new Promise(r => setTimeout(r, 2000));

  // Verify the agent works by trying a simple leverage set on ETH
  console.log("[agent] Verifying agent with setLeverage test...");
  const testResult = await setLeverage(agentKey, userAddress as `0x${string}`, "ETH", 5, true);
  console.log("[agent] Verification result:", JSON.stringify(testResult));
  if (!testResult.success && testResult.error === STALE_AGENT_MSG) {
    console.error("[agent] Agent NOT recognized by HL after approval!");
    return { agentKey: "0x" as `0x${string}`, error: "Agent approval succeeded but HL doesn't recognize it. Check browser console for details." };
  }
  // Even if leverage set fails for other reasons (e.g. no balance), the agent itself is valid
  console.log("[agent] Agent verified — storing");

  // Store for future use
  storeAgent(userAddress, agentKey);
  console.log("[agent] Agent stored successfully");
  return { agentKey };
}

// ─── Phantom agent hash ─────────────────────────────────────────────────────

function actionHash(
  action: Record<string, unknown>,
  nonce: number,
  vaultAddress: string | null = null,
): `0x${string}` {
  const actionBytes = msgpackEncode(action);

  const nonceBytes = new Uint8Array(8);
  new DataView(nonceBytes.buffer).setBigUint64(0, BigInt(nonce));

  let vaultBytes: Uint8Array;
  if (!vaultAddress) {
    vaultBytes = new Uint8Array([0x00]);
  } else {
    const addrHex = vaultAddress.toLowerCase().replace("0x", "");
    const addrBytes = new Uint8Array(20);
    for (let i = 0; i < 20; i++) {
      addrBytes[i] = parseInt(addrHex.slice(i * 2, i * 2 + 2), 16);
    }
    vaultBytes = new Uint8Array(21);
    vaultBytes[0] = 0x01;
    vaultBytes.set(addrBytes, 1);
  }

  const total = new Uint8Array(actionBytes.length + nonceBytes.length + vaultBytes.length);
  total.set(actionBytes, 0);
  total.set(nonceBytes, actionBytes.length);
  total.set(vaultBytes, actionBytes.length + nonceBytes.length);

  return keccak256(total);
}

// ─── Asset index mapping ─────────────────────────────────────────────────────

let assetIndexCache: Map<string, number> | null = null;
let szDecimalsCache: Map<string, number> | null = null;

async function loadMeta() {
  if (assetIndexCache && szDecimalsCache) return;
  const res = await fetch(`${HL_API}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "meta" }),
  });
  const meta = await res.json();
  assetIndexCache = new Map();
  szDecimalsCache = new Map();
  meta.universe.forEach((u: { name: string; szDecimals: number }, i: number) => {
    assetIndexCache!.set(u.name, i);
    szDecimalsCache!.set(u.name, u.szDecimals);
  });
}

async function getAssetIndex(asset: string): Promise<number> {
  await loadMeta();
  const idx = assetIndexCache!.get(asset);
  if (idx === undefined) throw new Error(`Unknown asset: ${asset}`);
  return idx;
}

async function getSzDecimals(asset: string): Promise<number> {
  await loadMeta();
  return szDecimalsCache!.get(asset) ?? 3;
}

// ─── Float to wire format ────────────────────────────────────────────────────

/**
 * Match Python SDK: Decimal(f"{x:.8f}").normalize() → string
 * Formats to 8 decimals, strips trailing zeros (but keeps "0" not "0E+2").
 */
function floatToWire(x: number): string {
  if (Math.abs(x) < 1e-8) return "0";
  // Format to 8 decimal places like Python f"{x:.8f}"
  const fixed = x.toFixed(8);
  // Strip trailing zeros after decimal point, then trailing dot
  const stripped = fixed.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return stripped;
}

function roundSize(size: number, szDecimals: number): number {
  const factor = 10 ** szDecimals;
  return Math.round(size * factor) / factor;
}

function roundPrice(price: number): number {
  // HL uses 5 significant figures for prices
  const magnitude = Math.floor(Math.log10(Math.abs(price))) + 1;
  const decimals = Math.max(0, 5 - magnitude);
  const factor = 10 ** decimals;
  return Math.round(price * factor) / factor;
}

// ─── Get mid price ───────────────────────────────────────────────────────────

async function getMidPrice(asset: string): Promise<number> {
  const res = await fetch(`${HL_API}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "allMids" }),
  });
  const mids = await res.json();
  const mid = parseFloat(mids[asset]);
  if (!mid || isNaN(mid)) throw new Error(`Cannot get price for ${asset}`);
  return mid;
}

// ─── Order types ─────────────────────────────────────────────────────────────

export interface PlaceOrderParams {
  asset: string;
  isBuy: boolean;
  size: number;
  orderType: "market" | "limit";
  limitPrice?: number;
  reduceOnly?: boolean;
  slippageBps?: number;
  tpPrice?: number;
  slPrice?: number;
}

export interface PlaceOrderResult {
  success: boolean;
  orderId?: string;
  filledSize?: string;
  avgPrice?: string;
  error?: string;
}

// ─── Raw signing for user-signed actions (MetaMask) ─────────────────────────
// Used for approveAgent and approveBuilderFee (chainId 42161, MetaMask accepts)

type EIP1193Provider = { request: (args: { method: string; params: unknown[] }) => Promise<unknown> };

async function getRawProvider(): Promise<EIP1193Provider> {
  const account = getAccount(config);
  if (account.connector) {
    try {
      const provider = await account.connector.getProvider();
      if (provider && typeof (provider as Record<string, unknown>).request === "function") {
        return provider as EIP1193Provider;
      }
    } catch (err) {
      console.warn("[signing] connector.getProvider() failed:", err);
    }
  }
  if (typeof window !== "undefined" && (window as unknown as { ethereum?: EIP1193Provider }).ethereum) {
    return (window as unknown as { ethereum: EIP1193Provider }).ethereum;
  }
  throw new Error("No wallet provider found — is your wallet connected?");
}

async function rawSignTypedData(
  _walletClient: WalletClient,
  address: string,
  typedData: Record<string, unknown>,
): Promise<string> {
  const provider = await getRawProvider();
  const dataStr = JSON.stringify(typedData);
  console.log("[signing] Requesting eth_signTypedData_v4 for", address.slice(0, 8) + "...");

  const sig = await withTimeout(
    provider.request({
      method: "eth_signTypedData_v4",
      params: [address, dataStr],
    }),
    30_000,
    "Signing",
  );

  if (typeof sig !== "string" || !sig.startsWith("0x")) {
    throw new Error(`Invalid signature returned: ${String(sig).slice(0, 20)}`);
  }
  return sig;
}

function extractError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (obj.message) return String(obj.message);
    if (obj.shortMessage) return String(obj.shortMessage);
    return JSON.stringify(err);
  }
  return "Unknown error — check browser console";
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s — check your wallet popup`)), ms)
    ),
  ]);
}

// ─── L1 signing with agent key (local, no MetaMask) ─────────────────────────

async function signL1Action(
  agentKey: `0x${string}`,
  action: Record<string, unknown>,
  nonce: number,
): Promise<`0x${string}`> {
  const connectionId = actionHash(action, nonce);
  const account = privateKeyToAccount(agentKey);

  const signature = await account.signTypedData({
    domain: {
      name: "Exchange",
      version: "1",
      chainId: 1337,
      verifyingContract: "0x0000000000000000000000000000000000000000" as `0x${string}`,
    },
    types: {
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent",
    message: {
      source: "a",
      connectionId,
    },
  });

  console.log("[signL1Action] Signed locally with agent, connectionId:", connectionId.slice(0, 10) + "...");
  return signature;
}

// ─── Submit to exchange ──────────────────────────────────────────────────────

function splitSig(sig: `0x${string}`): { r: string; s: string; v: number } {
  return {
    r: sig.slice(0, 66),
    s: `0x${sig.slice(66, 130)}`,
    v: normalizeV(parseInt(sig.slice(130, 132), 16)),
  };
}

/** Error thrown when the agent wallet is not recognized by HL API */
class StaleAgentError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "StaleAgentError";
  }
}

async function submitToExchange(
  action: Record<string, unknown>,
  nonce: number,
  signature: `0x${string}`,
  retries = 2,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(`${HL_API}/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        nonce,
        signature: splitSig(signature),
        vaultAddress: null,
      }),
    });

    // Retry on rate limit (429)
    if (res.status === 429 && attempt < retries) {
      console.log(`[exchange] 429 rate limited, retrying in ${(attempt + 1) * 1000}ms...`);
      await new Promise(r => setTimeout(r, (attempt + 1) * 1000));
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      // Detect stale/unrecognized agent wallet — must be agent-specific, not generic "not found"
      const lower = text.toLowerCase();
      if (lower.includes("does not exist") || lower.includes("unknown wallet")) {
        throw new StaleAgentError(`Exchange API error: ${res.status} ${text}`);
      }
      throw new Error(`Exchange API error: ${res.status} ${text}`);
    }

    const result = await res.json();
    // Also check for agent-specific errors in response body
    const responseStr = typeof result.response === "string" ? result.response.toLowerCase() : "";
    if (responseStr.includes("does not exist") || responseStr.includes("unknown wallet")) {
      throw new StaleAgentError(typeof result.response === "string" ? result.response : responseStr);
    }

    return result;
  }

  throw new Error("Exchange API error: 429 rate limited after retries");
}

// ─── Set leverage ────────────────────────────────────────────────────────────

export const STALE_AGENT_MSG = "STALE_AGENT";

export async function setLeverage(
  agentKey: `0x${string}`,
  address: `0x${string}`,
  asset: string,
  leverage: number,
  isCross: boolean = true,
): Promise<{ success: boolean; error?: string }> {
  try {
    const assetIndex = await getAssetIndex(asset);
    const nonce = Date.now();

    const action = {
      type: "updateLeverage",
      asset: assetIndex,
      isCross,
      leverage,
    };

    const signature = await signL1Action(agentKey, action, nonce);
    const result = await submitToExchange(action, nonce, signature);

    return { success: (result as { status?: string }).status === "ok" };
  } catch (err) {
    if (err instanceof StaleAgentError) {
      clearStoredAgent(address);
      return { success: false, error: STALE_AGENT_MSG };
    }
    return { success: false, error: extractError(err) };
  }
}

// ─── Place order (main function) ─────────────────────────────────────────────

export async function placeOrder(
  agentKey: `0x${string}`,
  address: `0x${string}`,
  params: PlaceOrderParams,
): Promise<PlaceOrderResult> {
  try {
    const assetIndex = await getAssetIndex(params.asset);
    const szDecimals = await getSzDecimals(params.asset);
    const nonce = Date.now();

    let limitPrice: number;
    if (params.orderType === "market") {
      const midPrice = await getMidPrice(params.asset);
      const slippage = (params.slippageBps ?? 50) / 10000;
      limitPrice = params.isBuy
        ? midPrice * (1 + slippage)
        : midPrice * (1 - slippage);
    } else {
      if (!params.limitPrice) throw new Error("Limit price required for limit orders");
      limitPrice = params.limitPrice;
    }

    const size = roundSize(params.size, szDecimals);
    if (size <= 0) throw new Error("Size must be positive");

    const orderWire = {
      a: assetIndex,
      b: params.isBuy,
      p: floatToWire(roundPrice(limitPrice)),
      s: floatToWire(size),
      r: params.reduceOnly ?? false,
      t: params.orderType === "market"
        ? { limit: { tif: "Ioc" } }
        : { limit: { tif: "Gtc" } },
    };

    const action: Record<string, unknown> = {
      type: "order",
      orders: [orderWire],
      grouping: "na",
      builder: {
        b: BUILDER_ADDRESS.toLowerCase(),
        f: BUILDER_FEE,
      },
    };

    const signature = await signL1Action(agentKey, action, nonce);
    const result = await submitToExchange(action, nonce, signature) as {
      status?: string;
      response?: {
        type?: string;
        data?: {
          statuses?: Array<{
            resting?: { oid: number };
            filled?: { oid: number; totalSz: string; avgPx: string };
            error?: string;
          }>;
        };
      };
    };

    if (result.status === "ok") {
      const status = result.response?.data?.statuses?.[0];
      if (status?.error) {
        return { success: false, error: status.error };
      }
      const filled = status?.filled;
      const resting = status?.resting;
      return {
        success: true,
        orderId: (filled?.oid || resting?.oid)?.toString(),
        filledSize: filled?.totalSz,
        avgPrice: filled?.avgPx,
      };
    }

    return {
      success: false,
      error: typeof result.response === "string" ? result.response : JSON.stringify(result),
    };
  } catch (err) {
    if (err instanceof StaleAgentError) {
      clearStoredAgent(address);
      return { success: false, error: STALE_AGENT_MSG };
    }
    return {
      success: false,
      error: extractError(err),
    };
  }
}

// ─── Close position (market) ─────────────────────────────────────────────────

export async function closePosition(
  agentKey: `0x${string}`,
  address: `0x${string}`,
  asset: string,
  size: number,
  isLong: boolean,
  slippageBps = 100,
): Promise<PlaceOrderResult> {
  return placeOrder(agentKey, address, {
    asset,
    isBuy: !isLong,
    size: Math.abs(size),
    orderType: "market",
    reduceOnly: true,
    slippageBps,
  });
}

// ─── Trigger orders (TP / SL) ───────────────────────────────────────────────

export interface TriggerOrderParams {
  asset: string;
  isLong: boolean;
  size: number;
  triggerPrice: number;
  type: "tp" | "sl";
}

export async function placeTriggerOrder(
  agentKey: `0x${string}`,
  address: `0x${string}`,
  params: TriggerOrderParams,
): Promise<PlaceOrderResult> {
  // For TP: use reduce-only limit order (reliable, no trigger needed)
  // For SL: use trigger order format
  if (params.type === "tp") {
    console.log("[tpsl] Placing TP as reduce-only limit order");
    return placeOrder(agentKey, address, {
      asset: params.asset,
      isBuy: !params.isLong, // opposite side to close
      size: Math.abs(params.size),
      orderType: "limit",
      limitPrice: params.triggerPrice,
      reduceOnly: true,
    });
  }

  console.log("[tpsl] Placing SL as trigger order");
  try {
    const assetIndex = await getAssetIndex(params.asset);
    const szDecimals = await getSzDecimals(params.asset);
    const nonce = Date.now();

    const size = roundSize(Math.abs(params.size), szDecimals);
    if (size <= 0) throw new Error("Size must be positive");

    // Key order MUST match Python SDK exactly — msgpack is order-dependent
    const orderWire = {
      a: assetIndex,
      b: !params.isLong,
      p: floatToWire(roundPrice(params.triggerPrice)),
      s: floatToWire(size),
      r: true,
      t: {
        trigger: {
          isMarket: true,
          triggerPx: floatToWire(roundPrice(params.triggerPrice)),
          tpsl: "sl" as const,
        },
      },
    };

    const action: Record<string, unknown> = {
      type: "order",
      orders: [orderWire],
      grouping: "na",
    };

    // NOTE: no builder fee on trigger orders — HL doesn't support it and it
    // changes the msgpack hash causing "does not exist" signature errors.
    console.log("[tpsl] SL action:", JSON.stringify(action));
    const connectionId = actionHash(action, nonce);
    console.log("[tpsl] SL connectionId:", connectionId);
    console.log("[tpsl] SL nonce:", nonce);
    console.log("[tpsl] SL agent address:", privateKeyToAccount(agentKey).address);

    const signature = await signL1Action(agentKey, action, nonce);
    console.log("[tpsl] SL signature:", signature);

    // Direct fetch to see raw response (bypass submitToExchange error wrapping)
    const sigParts = splitSig(signature);
    console.log("[tpsl] SL sig parts:", JSON.stringify(sigParts));

    const res = await fetch(`${HL_API}/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        nonce,
        signature: sigParts,
        vaultAddress: null,
      }),
    });

    const rawText = await res.text();
    console.log("[tpsl] SL raw response status:", res.status);
    console.log("[tpsl] SL raw response body:", rawText);

    if (!res.ok) {
      // Don't throw StaleAgentError — return the raw error so we can debug
      return { success: false, error: `HL API ${res.status}: ${rawText}` };
    }

    const result = JSON.parse(rawText) as {
      status?: string;
      response?: {
        type?: string;
        data?: {
          statuses?: Array<{
            resting?: { oid: number };
            filled?: { oid: number; totalSz: string; avgPx: string };
            error?: string;
          }>;
        };
      } | string;
    };

    console.log("[tpsl] SL parsed result:", JSON.stringify(result));

    if (result.status === "ok") {
      const resp = result.response;
      if (typeof resp === "object" && resp?.data?.statuses?.[0]) {
        const status = resp.data.statuses[0];
        if (status?.error) {
          return { success: false, error: status.error };
        }
        return {
          success: true,
          orderId: (status?.resting?.oid || status?.filled?.oid)?.toString(),
        };
      }
    }

    return {
      success: false,
      error: typeof result.response === "string" ? result.response : JSON.stringify(result),
    };
  } catch (err) {
    if (err instanceof StaleAgentError) {
      clearStoredAgent(address);
      return { success: false, error: STALE_AGENT_MSG };
    }
    return {
      success: false,
      error: extractError(err),
    };
  }
}

// ─── Cancel order ────────────────────────────────────────────────────────────

export async function cancelOrder(
  agentKey: `0x${string}`,
  address: `0x${string}`,
  asset: string,
  orderId: number,
): Promise<{ success: boolean; error?: string }> {
  try {
    const assetIndex = await getAssetIndex(asset);
    const nonce = Date.now();

    const action = {
      type: "cancel",
      cancels: [{ a: assetIndex, o: orderId }],
    };

    const signature = await signL1Action(agentKey, action, nonce);
    const result = await submitToExchange(action, nonce, signature);

    return { success: (result as { status?: string }).status === "ok" };
  } catch (err) {
    if (err instanceof StaleAgentError) {
      clearStoredAgent(address);
      return { success: false, error: STALE_AGENT_MSG };
    }
    return { success: false, error: extractError(err) };
  }
}

// ─── Check builder fee approval ─────────────────────────────────────────────

export async function checkBuilderApproval(
  userAddress: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${HL_API}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "maxBuilderFee",
        user: userAddress,
        builder: BUILDER_ADDRESS,
      }),
    });
    const maxFee = await res.json();
    return typeof maxFee === "number" && maxFee >= BUILDER_FEE;
  } catch {
    return false;
  }
}

// ─── Approve builder fee (MetaMask, one-time) ───────────────────────────────

export async function approveBuilderFee(
  walletClient: WalletClient,
  address: `0x${string}`,
): Promise<{ success: boolean; error?: string }> {
  try {
    const nonce = Date.now();

    const action = {
      type: "approveBuilderFee",
      hyperliquidChain: "Mainnet",
      signatureChainId: "0xa4b1",
      maxFeeRate: "0.02%",
      builder: BUILDER_ADDRESS,
      nonce,
    };

    console.log("[approveBuilderFee] Requesting signature...");
    const signature = await walletClient.signTypedData({
      account: address,
      domain: {
        name: "HyperliquidSignTransaction",
        version: "1",
        chainId: 42161,
        verifyingContract: "0x0000000000000000000000000000000000000000" as `0x${string}`,
      },
      types: {
        "HyperliquidTransaction:ApproveBuilderFee": [
          { name: "hyperliquidChain", type: "string" },
          { name: "maxFeeRate", type: "string" },
          { name: "builder", type: "address" },
          { name: "nonce", type: "uint64" },
        ],
      },
      primaryType: "HyperliquidTransaction:ApproveBuilderFee",
      message: {
        hyperliquidChain: "Mainnet",
        maxFeeRate: "0.02%",
        builder: BUILDER_ADDRESS as `0x${string}`,
        nonce: BigInt(nonce),
      },
    });

    const r = signature.slice(0, 66);
    const s = `0x${signature.slice(66, 130)}`;
    const v = normalizeV(parseInt(signature.slice(130, 132), 16));

    const res = await fetch(`${HL_API}/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        nonce,
        signature: { r, s, v },
        vaultAddress: null,
      }),
    });

    const result = await res.json();
    console.log("[approveBuilderFee] API response:", JSON.stringify(result));
    if ((result as { status?: string }).status === "ok") {
      return { success: true };
    }
    const apiErr = (result as { response?: string }).response
      || (result as { error?: string }).error
      || JSON.stringify(result);
    return { success: false, error: `API: ${apiErr}` };
  } catch (err) {
    console.error("[approveBuilderFee] Error:", err);
    return { success: false, error: extractError(err) };
  }
}

// ─── Withdraw (HL L1 → Arbitrum) ────────────────────────────────────────────
// Withdrawals are user-level L1 actions — must be signed by the actual wallet,
// NOT an agent key. Uses EIP-712 typed data signing like transferBetweenSpotAndPerp.

export async function withdraw(
  walletClient: WalletClient,
  address: `0x${string}`,
  amount: number, // USDC amount
): Promise<{ success: boolean; error?: string }> {
  try {
    const nonce = Date.now();
    const action = {
      type: "withdraw3",
      hyperliquidChain: "Mainnet",
      signatureChainId: "0xa4b1",
      amount: floatToWire(amount),
      time: nonce,
      destination: address,
    };

    // Withdraw is a user L1 action — signed by the actual wallet, not an agent
    const signature = await walletClient.signTypedData({
      account: address,
      domain: {
        name: "HyperliquidSignTransaction",
        version: "1",
        chainId: 42161,
        verifyingContract: "0x0000000000000000000000000000000000000000" as `0x${string}`,
      },
      types: {
        "HyperliquidTransaction:Withdraw": [
          { name: "hyperliquidChain", type: "string" },
          { name: "destination", type: "string" },
          { name: "amount", type: "string" },
          { name: "time", type: "uint64" },
        ],
      },
      primaryType: "HyperliquidTransaction:Withdraw",
      message: {
        hyperliquidChain: "Mainnet",
        destination: address,
        amount: floatToWire(amount),
        time: BigInt(nonce),
      },
    });

    const r = signature.slice(0, 66);
    const s = `0x${signature.slice(66, 130)}`;
    const v = normalizeV(parseInt(signature.slice(130, 132), 16));

    const res = await fetch(`${HL_API}/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        nonce,
        signature: { r, s, v },
        vaultAddress: null,
      }),
    });

    const result = await res.json();
    if ((result as { status?: string }).status === "ok") {
      return { success: true };
    }
    const apiErr = (result as { response?: string }).response
      || (result as { error?: string }).error
      || JSON.stringify(result);
    return { success: false, error: apiErr };
  } catch (err) {
    return { success: false, error: extractError(err) };
  }
}

// ─── Transfer between Spot and Perps ────────────────────────────────────────
// Move USDC between spot wallet and perps wallet on HL.

export async function transferBetweenSpotAndPerp(
  walletClient: WalletClient,
  address: `0x${string}`,
  amount: number,
  toPerp: boolean, // true = spot→perp, false = perp→spot
): Promise<{ success: boolean; error?: string }> {
  try {
    const nonce = Date.now();
    const action = {
      type: "usdClassTransfer",
      hyperliquidChain: "Mainnet",
      signatureChainId: "0xa4b1",
      amount: floatToWire(amount),
      toPerp,
      nonce,
    };

    // usdClassTransfer is a user L1 action — must be signed by the actual wallet, not an agent
    const signature = await walletClient.signTypedData({
      account: address,
      domain: {
        name: "HyperliquidSignTransaction",
        version: "1",
        chainId: 42161,
        verifyingContract: "0x0000000000000000000000000000000000000000" as `0x${string}`,
      },
      types: {
        "HyperliquidTransaction:UsdClassTransfer": [
          { name: "hyperliquidChain", type: "string" },
          { name: "amount", type: "string" },
          { name: "toPerp", type: "bool" },
          { name: "nonce", type: "uint64" },
        ],
      },
      primaryType: "HyperliquidTransaction:UsdClassTransfer",
      message: {
        hyperliquidChain: "Mainnet",
        amount: floatToWire(amount),
        toPerp,
        nonce: BigInt(nonce),
      },
    });

    const r = signature.slice(0, 66);
    const s = `0x${signature.slice(66, 130)}`;
    const v = normalizeV(parseInt(signature.slice(130, 132), 16));

    const res = await fetch(`${HL_API}/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        nonce,
        signature: { r, s, v },
        vaultAddress: null,
      }),
    });

    const result = await res.json();
    if ((result as { status?: string }).status === "ok") {
      return { success: true };
    }
    const apiErr = (result as { response?: string }).response
      || (result as { error?: string }).error
      || JSON.stringify(result);
    return { success: false, error: apiErr };
  } catch (err) {
    return { success: false, error: extractError(err) };
  }
}

// ─── Spot order ─────────────────────────────────────────────────────────────
// Spot trading uses the same order action but with spot asset indices.
// Spot tokens on HL have indices starting at 10000.

let spotMetaCache: Map<string, { index: number; szDecimals: number; token: string }> | null = null;

async function loadSpotMeta(): Promise<void> {
  if (spotMetaCache) return;
  const res = await fetch(`${HL_API}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "spotMeta" }),
  });
  const meta = await res.json();
  spotMetaCache = new Map();
  if (meta.tokens) {
    for (const t of meta.tokens) {
      spotMetaCache.set(t.name, {
        index: t.index,
        szDecimals: t.szDecimals,
        token: t.name,
      });
    }
  }
  // Also index by universe if present
  if (meta.universe) {
    for (const u of meta.universe) {
      // universe entries have { name, tokens: [baseIdx, quoteIdx], index }
      const name = u.name; // e.g. "PURR/USDC"
      const baseName = name.split("/")[0];
      if (!spotMetaCache.has(baseName)) {
        spotMetaCache.set(baseName, {
          index: 10000 + u.index,
          szDecimals: u.szDecimals ?? 0,
          token: baseName,
        });
      }
    }
  }
  console.log(`[spot] Loaded ${spotMetaCache.size} spot tokens`);
}

async function getSpotAssetIndex(token: string): Promise<number> {
  await loadSpotMeta();
  const info = spotMetaCache?.get(token);
  if (!info) throw new Error(`Unknown spot token: ${token}`);
  return info.index;
}

async function getSpotSzDecimals(token: string): Promise<number> {
  await loadSpotMeta();
  return spotMetaCache?.get(token)?.szDecimals ?? 2;
}

export interface SpotOrderParams {
  token: string;     // e.g. "PURR", "HYPE"
  isBuy: boolean;
  size: number;
  orderType: "market" | "limit";
  limitPrice?: number;
}

export async function placeSpotOrder(
  agentKey: `0x${string}`,
  address: `0x${string}`,
  params: SpotOrderParams,
): Promise<PlaceOrderResult> {
  try {
    const assetIndex = await getSpotAssetIndex(params.token);
    const szDecimals = await getSpotSzDecimals(params.token);
    const nonce = Date.now();

    let limitPrice: number;
    if (params.orderType === "market") {
      // For spot market orders, use mid price + slippage
      const midPrice = await getMidPrice(`${params.token}/USDC`).catch(
        () => getMidPrice(params.token)
      );
      const slippage = params.isBuy ? 1.005 : 0.995; // 0.5% slippage
      limitPrice = roundPrice(midPrice * slippage);
    } else {
      if (!params.limitPrice) throw new Error("Limit price required");
      limitPrice = roundPrice(params.limitPrice);
    }

    const roundedSize = roundSize(params.size, szDecimals);

    const orderWire = {
      a: assetIndex,
      b: params.isBuy,
      p: floatToWire(limitPrice),
      s: floatToWire(roundedSize),
      r: false, // reduce only (not applicable for spot)
      t: params.orderType === "market"
        ? { limit: { tif: "Ioc" } }  // IOC for market orders
        : { limit: { tif: "Gtc" } }, // GTC for limit orders
    };

    const action: Record<string, unknown> = {
      type: "order",
      orders: [orderWire],
      grouping: "na",
    };

    const signature = await signL1Action(agentKey, action, nonce);
    const result = await submitToExchange(action, nonce, signature);

    const response = (result as { response?: { type?: string; data?: { statuses?: Array<{ resting?: { oid: number }; filled?: { oid: number; totalSz: string; avgPx: string }; error?: string }> } } }).response;
    if (typeof response === "object" && response?.data?.statuses?.[0]) {
      const status = response.data.statuses[0];
      if (status?.error) {
        return { success: false, error: status.error };
      }
      return {
        success: true,
        orderId: (status?.resting?.oid || status?.filled?.oid)?.toString(),
        filledSize: status?.filled?.totalSz,
        avgPrice: status?.filled?.avgPx,
      };
    }

    return { success: true };
  } catch (err) {
    if (err instanceof StaleAgentError) {
      clearStoredAgent(address);
      return { success: false, error: STALE_AGENT_MSG };
    }
    return { success: false, error: extractError(err) };
  }
}

// ─── Deposit (Arbitrum USDC → HL L1) ────────────────────────────────────────
// Deposits send USDC on Arbitrum to the Hyperliquid bridge contract.
// This is an on-chain ERC-20 transfer, not an HL API action.

const USDC_ARB_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as `0x${string}`; // Native USDC on Arbitrum
const HL_BRIDGE_ADDRESS = "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7" as `0x${string}`; // HL deposit bridge on Arbitrum

// Standard ERC-20 ABI fragments for balanceOf, allowance, approve, transfer
const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

/** Get USDC balance on Arbitrum (returns human-readable amount, USDC has 6 decimals) */
export async function getArbitrumUsdcBalance(address: `0x${string}`): Promise<number> {
  try {
    const { readContract } = await import("@wagmi/core");
    const { config: wagmiConfig } = await import("@/config/wagmi");
    const balance = await readContract(wagmiConfig, {
      address: USDC_ARB_ADDRESS,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [address],
    });
    return Number(balance) / 1e6; // USDC has 6 decimals
  } catch {
    return 0;
  }
}

/** Deposit USDC from Arbitrum wallet into Hyperliquid */
export async function deposit(
  walletClient: WalletClient,
  address: `0x${string}`,
  amount: number, // USDC amount (human-readable)
): Promise<{ success: boolean; error?: string }> {
  try {
    const { readContract, writeContract, waitForTransactionReceipt } = await import("@wagmi/core");
    const { config: wagmiConfig } = await import("@/config/wagmi");
    const amountRaw = BigInt(Math.floor(amount * 1e6)); // USDC has 6 decimals

    // Check balance
    const balance = await readContract(wagmiConfig, {
      address: USDC_ARB_ADDRESS,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [address],
    });
    if (BigInt(balance) < amountRaw) {
      return { success: false, error: `Insufficient USDC balance (have ${(Number(balance) / 1e6).toFixed(2)})` };
    }

    // Check allowance and approve if needed
    const allowance = await readContract(wagmiConfig, {
      address: USDC_ARB_ADDRESS,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [address, HL_BRIDGE_ADDRESS],
    });
    if (BigInt(allowance) < amountRaw) {
      const approveTx = await writeContract(wagmiConfig, {
        address: USDC_ARB_ADDRESS,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [HL_BRIDGE_ADDRESS, amountRaw],
        account: address,
      });
      await waitForTransactionReceipt(wagmiConfig, { hash: approveTx });
    }

    // Transfer USDC to the HL bridge contract
    const txHash = await writeContract(wagmiConfig, {
      address: USDC_ARB_ADDRESS,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [HL_BRIDGE_ADDRESS, amountRaw],
      account: address,
    });
    await waitForTransactionReceipt(wagmiConfig, { hash: txHash });

    return { success: true };
  } catch (err) {
    return { success: false, error: extractError(err) };
  }
}

