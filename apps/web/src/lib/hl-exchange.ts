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
export const BUILDER_FEE = 20; // 2 bps in tenths-of-bps
export const BUILDER_FEE_PERCENT = 0.0002;
export const BUILDER_FEE_DISPLAY = "0.02%";

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

async function approveAgentOnChain(
  walletClient: WalletClient,
  userAddress: string,
  agentAddress: string,
): Promise<{ success: boolean; error?: string }> {
  const nonce = Date.now();

  const action = {
    type: "approveAgent",
    hyperliquidChain: "Mainnet",
    signatureChainId: "0xa4b1",
    agentAddress: agentAddress,
    agentName: "HLOne",
    nonce,
  };

  const typedData = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      "HyperliquidTransaction:ApproveAgent": [
        { name: "hyperliquidChain", type: "string" },
        { name: "agentAddress", type: "address" },
        { name: "agentName", type: "string" },
        { name: "nonce", type: "uint64" },
      ],
    },
    primaryType: "HyperliquidTransaction:ApproveAgent" as const,
    domain: {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: 42161, // Arbitrum mainnet — MetaMask accepts this
      verifyingContract: "0x0000000000000000000000000000000000000000",
    },
    message: {
      hyperliquidChain: "Mainnet",
      agentAddress: agentAddress,
      agentName: "HLOne",
      nonce: nonce,
    },
  };

  console.log("[approveAgent] Requesting MetaMask signature...");
  const signature = await rawSignTypedData(walletClient, userAddress, typedData);
  console.log("[approveAgent] Got signature:", signature.slice(0, 10) + "...");

  // Split signature into r, s, v
  const r = signature.slice(0, 66);
  const s = `0x${signature.slice(66, 130)}`;
  const v = parseInt(signature.slice(130, 132), 16);

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
  console.log("[agent] Agent address:", agentAccount.address);

  // Approve agent on-chain (MetaMask popup — one time only)
  const result = await approveAgentOnChain(walletClient, userAddress, agentAccount.address);
  if (!result.success) {
    return { agentKey: "0x" as `0x${string}`, error: result.error };
  }

  // Brief delay for HL to register the new agent before we use it
  await new Promise(r => setTimeout(r, 1500));

  // Store for future use
  storeAgent(userAddress, agentKey);
  console.log("[agent] Agent approved and stored");
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

function floatToWire(x: number): string {
  const rounded = parseFloat(x.toPrecision(5));
  if (Math.abs(rounded) < 1e-8) return "0";
  return rounded.toString();
}

function roundSize(size: number, szDecimals: number): number {
  const factor = 10 ** szDecimals;
  return Math.round(size * factor) / factor;
}

function roundPrice(price: number): number {
  return parseFloat(price.toPrecision(5));
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
    v: parseInt(sig.slice(130, 132), 16),
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
  try {
    const assetIndex = await getAssetIndex(params.asset);
    const szDecimals = await getSzDecimals(params.asset);
    const nonce = Date.now();

    const size = roundSize(Math.abs(params.size), szDecimals);
    if (size <= 0) throw new Error("Size must be positive");

    const tpsl = params.type === "tp" ? "tp" : "sl";
    const isMarket = true;

    const orderWire = {
      a: assetIndex,
      b: !params.isLong,
      p: floatToWire(roundPrice(params.triggerPrice)),
      s: floatToWire(size),
      r: true,
      t: {
        trigger: {
          triggerPx: floatToWire(roundPrice(params.triggerPrice)),
          isMarket,
          tpsl,
        },
      },
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
      return {
        success: true,
        orderId: (status?.resting?.oid || status?.filled?.oid)?.toString(),
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

    const typedData = {
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        "HyperliquidTransaction:ApproveBuilderFee": [
          { name: "hyperliquidChain", type: "string" },
          { name: "maxFeeRate", type: "string" },
          { name: "builder", type: "address" },
          { name: "nonce", type: "uint64" },
        ],
      },
      primaryType: "HyperliquidTransaction:ApproveBuilderFee" as const,
      domain: {
        name: "HyperliquidSignTransaction",
        version: "1",
        chainId: 42161,
        verifyingContract: "0x0000000000000000000000000000000000000000",
      },
      message: {
        hyperliquidChain: "Mainnet",
        maxFeeRate: "0.02%",
        builder: BUILDER_ADDRESS,
        nonce: nonce,
      },
    };

    console.log("[approveBuilderFee] Requesting signature...");
    const signature = await rawSignTypedData(walletClient, address, typedData);

    const r = signature.slice(0, 66);
    const s = `0x${signature.slice(66, 130)}`;
    const v = parseInt(signature.slice(130, 132), 16);

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
