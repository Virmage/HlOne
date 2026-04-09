"use client";

import { useSyncExternalStore } from "react";

interface AccountInfo {
  accountValue: number;
  unrealizedPnl: number;
  totalMarginUsed: number;
  totalNotional: number;
  withdrawable: number;
  positionCount: number;
}

let currentInfo: AccountInfo | null = null;
const listeners = new Set<() => void>();

export function setAccountInfo(info: AccountInfo | null) {
  currentInfo = info;
  listeners.forEach((l) => l());
}

export function useAccountInfo(): AccountInfo | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => currentInfo,
    () => null
  );
}
