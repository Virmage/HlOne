"use client";

import { useState, useEffect, useCallback } from "react";
import { getPortfolio, type PortfolioData } from "@/lib/api";

export function usePortfolio(walletAddress: string | undefined) {
  const [data, setData] = useState<PortfolioData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPortfolio = useCallback(async () => {
    if (!walletAddress) return;
    setLoading(true);
    setError(null);
    try {
      const result = await getPortfolio(walletAddress);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch portfolio");
    } finally {
      setLoading(false);
    }
  }, [walletAddress]);

  useEffect(() => {
    fetchPortfolio();
  }, [fetchPortfolio]);

  return { data, loading, error, refetch: fetchPortfolio };
}
