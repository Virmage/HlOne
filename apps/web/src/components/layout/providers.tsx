"use client";

import { useState, useEffect, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ErrorBoundary } from "./error-boundary";

const queryClient = new QueryClient();

export function Providers({ children }: { children: ReactNode }) {
  const [WalletStack, setWalletStack] = useState<React.ComponentType<{ children: ReactNode }> | null>(null);

  useEffect(() => {
    // Check if localStorage is functional before loading wallet stack.
    // In sandboxed browsers (e.g. Claude Preview), localStorage.getItem
    // may not be a function, which crashes RainbowKit/WalletConnect.
    let lsWorks = false;
    try {
      if (typeof window.localStorage.getItem === "function") {
        window.localStorage.setItem("__t", "1");
        window.localStorage.removeItem("__t");
        lsWorks = true;
      }
    } catch { /* not available */ }

    if (!lsWorks) {
      // Patch localStorage for the rest of the app
      const mem: Record<string, string> = {};
      try {
        Object.defineProperty(window, "localStorage", {
          value: {
            getItem: (k: string) => mem[k] ?? null,
            setItem: (k: string, v: string) => { mem[k] = String(v); },
            removeItem: (k: string) => { delete mem[k]; },
            clear: () => { Object.keys(mem).forEach(k => delete mem[k]); },
            get length() { return Object.keys(mem).length; },
            key: (i: number) => Object.keys(mem)[i] ?? null,
          },
          writable: true,
          configurable: true,
        });
      } catch { /* ignore */ }
    }

    // Now try loading wallet providers
    import("./wallet-providers")
      .then(mod => {
        setWalletStack(() => mod.WalletStack);
      })
      .catch(() => {
        // Wallet providers failed to load — app still works without wallet
      });
  }, []);

  if (!WalletStack) {
    return (
      <QueryClientProvider client={queryClient}>
        <ErrorBoundary>
          {children}
        </ErrorBoundary>
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <WalletStack>
        <ErrorBoundary>
          {children}
        </ErrorBoundary>
      </WalletStack>
    </QueryClientProvider>
  );
}
