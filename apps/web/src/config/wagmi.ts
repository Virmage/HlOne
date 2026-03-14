import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { arbitrum } from "wagmi/chains";

// Hyperliquid uses Arbitrum for L1 deposits — the actual trading is on HyperCore L1
// but wallet connection is via the Arbitrum chain for the deposit bridge
export const config = getDefaultConfig({
  appName: "HL Copy Trading",
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "demo",
  chains: [arbitrum],
  ssr: true,
});
