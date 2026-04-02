"use client";

import { useEffect, type ReactNode } from "react";
import { WagmiProvider, useAccount } from "wagmi";
import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { config } from "@/config/wagmi";
import { setWalletAddress } from "@/hooks/use-safe-account";
import "@rainbow-me/rainbowkit/styles.css";

const rkTheme = darkTheme({
  accentColor: "#10b981",
  accentColorForeground: "white",
  borderRadius: "medium",
  fontStack: "system",
});

// Syncs wagmi account state to the safe external store
function AccountSync({ children }: { children: ReactNode }) {
  const { address } = useAccount();
  useEffect(() => {
    setWalletAddress(address);
    return () => setWalletAddress(undefined);
  }, [address]);
  return <>{children}</>;
}

export function WalletStack({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <RainbowKitProvider theme={rkTheme}>
        <AccountSync>{children}</AccountSync>
      </RainbowKitProvider>
    </WagmiProvider>
  );
}
