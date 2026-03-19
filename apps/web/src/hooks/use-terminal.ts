"use client";

import { useState, useEffect, useCallback } from "react";
import {
  getTerminalData,
  getTokenDetail,
  getWhaleAlertsFeed,
  type TerminalData,
  type TokenDetail,
  type WhaleAlert,
} from "@/lib/api";

export function useTerminal() {
  const [data, setData] = useState<TerminalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    try {
      const result = await getTerminalData();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch terminal data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
    // Refresh whale alerts every 30s
    const interval = setInterval(async () => {
      try {
        const result = await getWhaleAlertsFeed(30);
        setData(prev => prev ? { ...prev, whaleAlerts: result.alerts, hotTokens: result.hotTokens } : prev);
      } catch { /* ignore polling errors */ }
    }, 30_000);
    return () => clearInterval(interval);
  }, [fetch]);

  return { data, loading, error, refetch: fetch };
}

export function useTokenDetail(coin: string | null) {
  const [detail, setDetail] = useState<TokenDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!coin) {
      setDetail(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    getTokenDetail(coin)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to fetch token detail");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [coin]);

  return { detail, loading, error };
}
