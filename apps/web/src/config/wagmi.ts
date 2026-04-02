import { createConfig, createStorage, http } from "wagmi";
import { arbitrum } from "wagmi/chains";
import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  metaMaskWallet,
  rainbowWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";

// Safe storage that never touches localStorage directly — avoids crashes
// in sandboxed browsers where localStorage.getItem is not a function.
const safeStorage = (() => {
  const mem: Record<string, string> = {};

  function getRealStorage(): Storage | null {
    if (typeof window === "undefined") return null;
    try {
      if (typeof window.localStorage.getItem === "function") {
        window.localStorage.setItem("__t", "1");
        window.localStorage.removeItem("__t");
        return window.localStorage;
      }
    } catch { /* not available */ }
    return null;
  }

  return {
    getItem: (key: string) => {
      const real = getRealStorage();
      if (real) return real.getItem(key);
      return mem[key] ?? null;
    },
    setItem: (key: string, value: string) => {
      const real = getRealStorage();
      if (real) real.setItem(key, value);
      mem[key] = value;
    },
    removeItem: (key: string) => {
      const real = getRealStorage();
      if (real) real.removeItem(key);
      delete mem[key];
    },
  };
})();

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "demo";

const connectors = connectorsForWallets(
  [
    {
      groupName: "Popular",
      wallets: [metaMaskWallet, rainbowWallet, walletConnectWallet],
    },
  ],
  { appName: "HLOne", projectId }
);

export const config = createConfig({
  connectors,
  chains: [arbitrum],
  transports: {
    [arbitrum.id]: http(),
  },
  storage: createStorage({ storage: safeStorage }),
  ssr: true,
});
