"use client";

import { useSyncExternalStore } from "react";

// Track wallet address globally — set by WalletStack when it loads
let walletAddress: string | undefined;
const listeners = new Set<() => void>();

export function setWalletAddress(addr: string | undefined) {
  walletAddress = addr;
  listeners.forEach(l => l());
}

export function useSafeAccount(): { address: string | undefined; isConnected: boolean } {
  const addr = useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => walletAddress,
    () => undefined
  );
  return { address: addr, isConnected: !!addr };
}
