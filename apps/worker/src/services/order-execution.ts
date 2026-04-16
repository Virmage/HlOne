/**
 * Order Execution Service
 *
 * Signs and submits orders to Hyperliquid using EIP-712 typed data signing
 * via agent wallets. Agent wallets can trade but cannot withdraw.
 *
 * The Hyperliquid exchange endpoint expects:
 * POST /exchange with { action, nonce, signature, vaultAddress? }
 */

import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  type Hex,
  encodePacked,
  keccak256,
  toHex,
} from "viem";

const HL_API = "https://api.hyperliquid.xyz";

// Hyperliquid uses a custom EIP-712 domain
const EIP712_DOMAIN = {
  name: "Exchange",
  version: "1",
  chainId: 1337, // Hyperliquid L1 chain ID
  verifyingContract: "0x0000000000000000000000000000000000000000" as const,
};

// Order wire type for EIP-712
const ORDER_TYPE = {
  Order: [
    { name: "a", type: "uint256" }, // asset index
    { name: "b", type: "bool" },    // is buy
    { name: "p", type: "uint64" },  // limit price (float to wire format)
    { name: "s", type: "uint64" },  // size (float to wire format)
    { name: "r", type: "bool" },    // reduce only
    { name: "t", type: "uint8" },   // order type: 2=limit, 3=trigger
    { name: "c", type: "uint64" },  // client order ID
  ],
} as const;

const AGENT_TYPE = {
  Agent: [
    { name: "source", type: "string" },
    { name: "connectionId", type: "bytes32" },
  ],
} as const;

// ─── Builder fee configuration ──────────────────────────────────────────────
// Fee is in tenths of basis points: 15 = 1.5 bps = 0.015% (below industry avg of 2-3 bps)
const BUILDER_ADDRESS = process.env.BUILDER_ADDRESS || "0xbB0f753321e2B5FD29Bd1d14b532f5B54959ae63";
const BUILDER_FEE = parseInt(process.env.BUILDER_FEE || "15", 10); // 15 = 0.015% default

export interface OrderRequest {
  asset: string;
  isBuy: boolean;
  limitPrice: number;
  size: number;
  reduceOnly: boolean;
  cloid?: string;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  error?: string;
  latencyMs: number;
}

// ─── Float to wire format conversion ─────────────────────────────────────────

function floatToWire(x: number): string {
  if (!Number.isFinite(x)) throw new Error(`Invalid order value: ${x}`);
  const rounded = parseFloat(x.toPrecision(5));
  if (Math.abs(rounded) < 1e-8) return "0";
  return rounded.toString();
}

function floatToIntForHashing(x: number): bigint {
  return BigInt(Math.round(x * 1e8));
}

// ─── Asset name to index mapping ─────────────────────────────────────────────

let assetIndexCache: Map<string, number> | null = null;

async function getAssetIndex(asset: string): Promise<number> {
  if (!assetIndexCache) {
    const res = await fetch(`${HL_API}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "meta" }),
    });
    const meta = await res.json();
    assetIndexCache = new Map();
    for (const u of meta.universe) {
      assetIndexCache.set(u.name, u.szDecimals !== undefined ? meta.universe.indexOf(u) : 0);
    }
    // Re-index properly
    assetIndexCache = new Map();
    meta.universe.forEach((u: { name: string }, i: number) => {
      assetIndexCache!.set(u.name, i);
    });
  }
  const idx = assetIndexCache.get(asset);
  if (idx === undefined) throw new Error(`Unknown asset: ${asset}`);
  return idx;
}

// ─── Nonce management ────────────────────────────────────────────────────────

function generateNonce(): number {
  // Hyperliquid nonces must be unique and increasing
  // Using timestamp in ms ensures this
  return Date.now();
}

// ─── Core order submission ───────────────────────────────────────────────────

export async function submitOrder(
  agentPrivateKey: Hex,
  masterAddress: string,
  order: OrderRequest
): Promise<OrderResult> {
  const startTime = Date.now();

  try {
    const account = privateKeyToAccount(agentPrivateKey);
    const assetIndex = await getAssetIndex(order.asset);
    const nonce = generateNonce();

    // Build the order action
    const orderWire = {
      a: assetIndex,
      b: order.isBuy,
      p: floatToWire(order.limitPrice),
      s: floatToWire(order.size),
      r: order.reduceOnly,
      t: { limit: { tif: "Ioc" as const } }, // Immediate-or-cancel for copy trading
      c: order.cloid || undefined,
    };

    const action: Record<string, unknown> = {
      type: "order" as const,
      orders: [orderWire],
      grouping: "na" as const,
    };

    // Attach builder fee if configured
    if (BUILDER_ADDRESS && BUILDER_FEE > 0) {
      action.builder = { b: BUILDER_ADDRESS, f: BUILDER_FEE };
    }

    // Build the connection ID for agent signing
    // Agent wallets sign with their own key but specify the master address
    const connectionId = keccak256(
      encodePacked(["address"], [masterAddress as `0x${string}`])
    );

    // Sign using EIP-712
    const signature = await account.signTypedData({
      domain: EIP712_DOMAIN,
      types: AGENT_TYPE,
      primaryType: "Agent",
      message: {
        source: "a", // "a" = mainnet
        connectionId,
      },
    });

    // Submit to exchange
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

    const result = await res.json();
    const latencyMs = Date.now() - startTime;

    if (result.status === "ok") {
      // Extract order ID from response
      const statuses = result.response?.data?.statuses;
      const orderId = statuses?.[0]?.resting?.oid || statuses?.[0]?.filled?.oid;

      return {
        success: true,
        orderId: orderId?.toString(),
        latencyMs,
      };
    } else {
      return {
        success: false,
        error: result.response || JSON.stringify(result),
        latencyMs,
      };
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
      latencyMs: Date.now() - startTime,
    };
  }
}

// ─── Market order helper ─────────────────────────────────────────────────────

export async function submitMarketOrder(
  agentPrivateKey: Hex,
  masterAddress: string,
  asset: string,
  isBuy: boolean,
  size: number,
  slippageBps: number = 50 // 0.5% slippage by default
): Promise<OrderResult> {
  // Get current mid price for slippage calculation
  const res = await fetch(`${HL_API}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "allMids" }),
  });
  const mids = await res.json();
  const midPrice = parseFloat(mids[asset]);

  if (!midPrice || isNaN(midPrice)) {
    return {
      success: false,
      error: `Cannot get mid price for ${asset}`,
      latencyMs: 0,
    };
  }

  // Apply slippage — buy higher, sell lower
  const slippageMultiplier = 1 + (slippageBps / 10000) * (isBuy ? 1 : -1);
  const limitPrice = midPrice * slippageMultiplier;

  return submitOrder(agentPrivateKey, masterAddress, {
    asset,
    isBuy,
    limitPrice,
    size,
    reduceOnly: false,
  });
}

// ─── Close position helper ───────────────────────────────────────────────────

export async function submitCloseOrder(
  agentPrivateKey: Hex,
  masterAddress: string,
  asset: string,
  currentSide: "long" | "short",
  size: number,
  slippageBps: number = 50
): Promise<OrderResult> {
  const res = await fetch(`${HL_API}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "allMids" }),
  });
  const mids = await res.json();
  const midPrice = parseFloat(mids[asset]);

  if (!midPrice || isNaN(midPrice)) {
    return {
      success: false,
      error: `Cannot get mid price for ${asset}`,
      latencyMs: 0,
    };
  }

  // To close a long, we sell. To close a short, we buy.
  const isBuy = currentSide === "short";
  const slippageMultiplier = 1 + (slippageBps / 10000) * (isBuy ? 1 : -1);
  const limitPrice = midPrice * slippageMultiplier;

  return submitOrder(agentPrivateKey, masterAddress, {
    asset,
    isBuy,
    limitPrice,
    size,
    reduceOnly: true,
  });
}
