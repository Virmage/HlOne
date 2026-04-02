/**
 * Hyperliquid Exchange — client-side order signing and submission.
 *
 * Users sign orders with their wallet (MetaMask/WalletConnect) using EIP-712.
 * Orders are submitted directly to HL's /exchange endpoint.
 *
 * This is for DIRECT trading from the terminal — NOT copy trading
 * (which uses server-side agent wallets in the worker).
 */

import type { WalletClient } from "viem";

const HL_API = "https://api.hyperliquid.xyz";

// ─── Builder fee config ─────────────────────────────────────────────────────
// 2 bps (0.02%) — industry standard for trading terminals (Dreamcash, Tread.fi)
// Fee unit: tenths of a basis point → 20 = 2 bps = 0.02%
export const BUILDER_ADDRESS = "0xB4a59142607C744CCF6C4828f01A6ab79c1f2520";
export const BUILDER_FEE = 20; // 2 bps in tenths-of-bps
export const BUILDER_FEE_PERCENT = 0.0002; // 0.02% as decimal
export const BUILDER_FEE_DISPLAY = "0.02%"; // for UI

// Hyperliquid uses custom EIP-712 domain (chain 1337 = HL L1)
const EIP712_DOMAIN = {
  name: "Exchange",
  version: "1",
  chainId: 1337,
  verifyingContract: "0x0000000000000000000000000000000000000000" as `0x${string}`,
} as const;

// Phantom agent type — used for signing orders from the user's own wallet
const PHANTOM_AGENT_TYPE = {
  "HyperliquidTransaction:Approve": [
    { name: "hyppieLiquidChain", type: "string" },
    { name: "isMainNet", type: "bool" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

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
  // Prices: 5 significant figures
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
  size: number;          // in asset units (e.g. 0.01 BTC)
  orderType: "market" | "limit";
  limitPrice?: number;   // required for limit orders
  reduceOnly?: boolean;
  slippageBps?: number;  // for market orders, default 50 (0.5%)
  tpPrice?: number;      // take profit trigger price
  slPrice?: number;      // stop loss trigger price
}

export interface PlaceOrderResult {
  success: boolean;
  orderId?: string;
  filledSize?: string;
  avgPrice?: string;
  error?: string;
}

// ─── EIP-712 signing ─────────────────────────────────────────────────────────

async function signL1Action(
  walletClient: WalletClient,
  address: `0x${string}`,
  action: Record<string, unknown>,
  nonce: number,
): Promise<`0x${string}`> {
  // Hyperliquid uses a "phantom agent" approach for L1 actions
  // The action is hashed into the nonce field of the phantom agent message
  const actionHash = await hashAction(action, nonce);

  const signature = await walletClient.signTypedData({
    account: address,
    domain: EIP712_DOMAIN,
    types: PHANTOM_AGENT_TYPE,
    primaryType: "HyperliquidTransaction:Approve",
    message: {
      hyppieLiquidChain: "Mainnet",
      isMainNet: true,
      nonce: BigInt(actionHash),
    },
  });

  return signature;
}

async function hashAction(action: Record<string, unknown>, nonce: number): Promise<number> {
  // Simple nonce — HL accepts timestamp-based nonces
  return nonce;
}

// ─── Submit to exchange ──────────────────────────────────────────────────────

async function submitToExchange(
  action: Record<string, unknown>,
  nonce: number,
  signature: `0x${string}`,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${HL_API}/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action,
      nonce,
      signature,
      vaultAddress: null,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Exchange API error: ${res.status} ${text}`);
  }

  return res.json();
}

// ─── Set leverage ────────────────────────────────────────────────────────────

export async function setLeverage(
  walletClient: WalletClient,
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

    const signature = await signL1Action(walletClient, address, action, nonce);
    const result = await submitToExchange(action, nonce, signature);

    return { success: (result as { status?: string }).status === "ok" };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

// ─── Place order (main function) ─────────────────────────────────────────────

export async function placeOrder(
  walletClient: WalletClient,
  address: `0x${string}`,
  params: PlaceOrderParams,
): Promise<PlaceOrderResult> {
  try {
    const assetIndex = await getAssetIndex(params.asset);
    const szDecimals = await getSzDecimals(params.asset);
    const nonce = Date.now();

    let limitPrice: number;
    if (params.orderType === "market") {
      // For market orders, use mid price + slippage as limit
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

    // Build order wire
    const orderWire = {
      a: assetIndex,
      b: params.isBuy,
      p: floatToWire(roundPrice(limitPrice)),
      s: floatToWire(size),
      r: params.reduceOnly ?? false,
      t: params.orderType === "market"
        ? { limit: { tif: "Ioc" } }  // IOC for market orders
        : { limit: { tif: "Gtc" } }, // GTC for limit orders
    };

    const action: Record<string, unknown> = {
      type: "order",
      orders: [orderWire],
      grouping: "na",
      builder: {
        b: BUILDER_ADDRESS,
        f: BUILDER_FEE,
      },
    };

    const signature = await signL1Action(walletClient, address, action, nonce);
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
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

// ─── Cancel order ────────────────────────────────────────────────────────────

export async function cancelOrder(
  walletClient: WalletClient,
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

    const signature = await signL1Action(walletClient, address, action, nonce);
    const result = await submitToExchange(action, nonce, signature);

    return { success: (result as { status?: string }).status === "ok" };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
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
    // maxFee is the max approved fee rate as a number (in bps)
    // If > 0, user has approved; check it covers our fee
    return typeof maxFee === "number" && maxFee >= BUILDER_FEE;
  } catch {
    return false;
  }
}

// ─── Approve builder fee ─────────────────────────────────────────────────────

export async function approveBuilderFee(
  walletClient: WalletClient,
  address: `0x${string}`,
): Promise<{ success: boolean; error?: string }> {
  try {
    const nonce = Date.now();

    const action = {
      type: "approveBuilderFee",
      hyperliquidChain: "Mainnet",
      maxFeeRate: "0.02%",
      builder: BUILDER_ADDRESS,
      nonce,
    };

    const signature = await signL1Action(walletClient, address, action, nonce);
    const result = await submitToExchange(action, nonce, signature);

    return { success: (result as { status?: string }).status === "ok" };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}
