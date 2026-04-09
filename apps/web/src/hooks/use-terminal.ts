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

    // Refresh whale alerts every 30s — but pause when tab is hidden
    // (saves bandwidth + server load when users aren't looking)
    let interval: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      if (interval) return;
      interval = setInterval(async () => {
        if (document.hidden) return; // skip if tab not visible
        try {
          const result = await getWhaleAlertsFeed(30);
          setData(prev => prev ? { ...prev, whaleAlerts: result.alerts, hotTokens: result.hotTokens } : prev);
        } catch { /* ignore polling errors */ }
      }, 30_000);
    };

    const stopPolling = () => {
      if (interval) { clearInterval(interval); interval = null; }
    };

    let lastRefetch = Date.now();
    const handleVisibility = () => {
      if (document.hidden) {
        stopPolling();
      } else {
        startPolling();
        // Only refetch if tab was hidden for >2 minutes
        if (Date.now() - lastRefetch > 120_000) {
          lastRefetch = Date.now();
          getWhaleAlertsFeed(20)
            .then(result => setData(prev => prev ? { ...prev, whaleAlerts: result.alerts, hotTokens: result.hotTokens } : prev))
            .catch(() => {});
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
