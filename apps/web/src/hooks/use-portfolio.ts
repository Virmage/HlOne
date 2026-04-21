"use client";

import { useState, useEffect, useCallback } from "react";
import { useSignMessage } from "wagmi";
import { getPortfolio, type PortfolioData } from "@/lib/api";

export function usePortfolio(walletAddress: string | undefined) {
  const [data, setData] = useState<PortfolioData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { signMessageAsync } = useSignMessage();

  const fetchPortfolio = useCallback(async () => {
    if (!walletAddress) return;
    setLoading(true);
    setError(null);
    try {
      // signMessageAsync is required — server rejects unsigned portfolio reads.
      // The api helper caches the signed headers in sessionStorage so the
      // user isn't prompted on every auto-refresh.
      const result = await getPortfolio(walletAddress, signMessageAsync);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch portfolio");
    } finally {
      setLoading(false);
    }
  }, [walletAddress, signMessageAsync]);

  useEffect(() => {
    fetchPortfolio();
  }, [fetchPortfolio]);

  return { data, loading, error, refetch: fetchPortfolio };
}
