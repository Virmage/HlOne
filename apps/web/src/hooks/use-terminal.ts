"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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

  const retryRef = useRef(0);

  const fetch = useCallback(async () => {
    try {
      const result = await getTerminalData();
      setData(result);
      setError(null);
      setLoading(false);
      retryRef.current = 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to fetch terminal data";
      // Auto-retry up to 3 times with backoff (handles API cold starts)
      // Keep loading=true during retries so the loading screen stays visible
      // instead of flashing the red error bar between retries
      if (retryRef.current < 3) {
        retryRef.current++;
        setTimeout(() => fetch(), 2000 * retryRef.current);
        // Don't set loading=false or error — stay on loading screen
      } else {
        // All retries exhausted — now show the error
        setError(msg);
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    fetch();

    // Two polling cadences, both pause when the tab is hidden:
    //   1. Fast (30s): whale alerts — low payload, event-driven
    //   2. Slow (60s): full terminal data — sharp flow, divergences, top traders,
    //      ticker prices, macro, market pulse, etc. Keeps everything fresh while
    //      you're watching without hammering the API.
    let fastInterval: ReturnType<typeof setInterval> | null = null;
    let slowInterval: ReturnType<typeof setInterval> | null = null;

    const refetchWhaleAlerts = async () => {
      if (document.hidden) return;
      try {
        const result = await getWhaleAlertsFeed(30);
        setData(prev => prev ? { ...prev, whaleAlerts: result.alerts, hotTokens: result.hotTokens } : prev);
      } catch { /* ignore polling errors */ }
    };

    const refetchFullTerminal = async () => {
      if (document.hidden) return;
      try {
        const result = await getTerminalData();
        // Merge rather than replace so React can diff + only re-render changed widgets
        setData(prev => prev ? { ...prev, ...result } : result);
      } catch { /* ignore polling errors */ }
    };

    const startPolling = () => {
      if (!fastInterval) fastInterval = setInterval(refetchWhaleAlerts, 30_000);
      if (!slowInterval) slowInterval = setInterval(refetchFullTerminal, 60_000);
    };

    const stopPolling = () => {
      if (fastInterval) { clearInterval(fastInterval); fastInterval = null; }
      if (slowInterval) { clearInterval(slowInterval); slowInterval = null; }
    };

    let lastRefetch = Date.now();
    const handleVisibility = () => {
      if (document.hidden) {
        stopPolling();
      } else {
        startPolling();
        // Coming back after being away for >1 min: refresh immediately
        if (Date.now() - lastRefetch > 60_000) {
          lastRefetch = Date.now();
          refetchFullTerminal();
        }
      }
    };

    startPolling();
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
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
