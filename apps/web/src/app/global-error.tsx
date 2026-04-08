"use client";

import { useEffect, useRef } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const retryCount = useRef(0);

  useEffect(() => {
    // Log the actual error for debugging
    console.error("[global-error]", error.message, error.stack?.substring(0, 300));

    // Cap auto-retries to prevent infinite loops
    if (retryCount.current >= 2) return;
    retryCount.current++;

    // Auto-retry for API errors (cold start, network hiccup)
    if (error.message?.includes("API error") || error.message?.includes("fetch") || error.message?.includes("Failed to fetch")) {
      setTimeout(() => reset(), 1500);
      return;
    }

    // Auto-retry for localStorage errors (sandbox browser issue)
    if (error.message?.includes("localStorage")) {
      // Patch localStorage and retry
      if (typeof window !== "undefined") {
        try {
          if (typeof window.localStorage.getItem !== "function") {
            const mem: Record<string, string> = {};
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
          }
        } catch { /* ignore */ }
      }
      // Auto-retry after patching
      setTimeout(() => reset(), 100);
      return;
    }
  }, [error, reset]);

  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-black text-white flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-lg mb-2">Something went wrong</h2>
          <button
            onClick={() => reset()}
            className="px-4 py-2 bg-[#50d2c1] text-[#04251f] rounded font-medium"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
