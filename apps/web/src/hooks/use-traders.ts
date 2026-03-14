"use client";

import { useState, useEffect, useCallback } from "react";
import { getTraders, getTraderDetail, type TraderRow, type TraderFilters, type TraderDetail } from "@/lib/api";

export function useTraders(filters: TraderFilters = { sortBy: "winRate", order: "desc" }) {
  const [traders, setTraders] = useState<TraderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Serialize filters to a stable string so useEffect re-runs on any change
  const filterKey = JSON.stringify(filters);

  const fetchTraders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getTraders(filters);
      setTraders(data.traders);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch traders");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  useEffect(() => {
    fetchTraders();
  }, [fetchTraders]);

  return { traders, loading, error, refetch: fetchTraders };
}

export function useTraderDetail(address: string | null) {
  const [detail, setDetail] = useState<TraderDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!address) {
      setDetail(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    getTraderDetail(address)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to fetch trader");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [address]);

  return { detail, loading, error };
}
