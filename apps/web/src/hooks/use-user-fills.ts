/**
 * useUserFills — Fetches the connected wallet's fills + open position for a given coin.
 *
 * Used by PriceChart to render the user's own entry/exit markers and an
 * open-position price line (so the user can see their entry vs current price).
 *
 * Polls every 30s. Returns [] / null when no wallet is connected.
 */

"use client";

import { useEffect, useState } from "react";
import { useSafeAccount } from "./use-safe-account";

const HL_API = "https://api.hyperliquid.xyz";

export interface UserFill {
  time: number;            // unix ms
  coin: string;
  side: "B" | "A";         // B = buy, A = sell
  price: number;
  size: number;            // base units
  sizeUsd: number;         // computed
  direction: string;       // "Open Long", "Close Long", "Open Short", "Close Short"
  closedPnl: number;
  fee: number;
  hash: string;
  oid: number;
}

export interface UserOpenPosition {
  coin: string;
  side: "long" | "short";
  size: number;            // base units (always positive)
  entryPrice: number;      // average entry price
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
  liquidationPrice?: number;
}

interface UseUserFillsResult {
  fills: UserFill[];
  openPosition: UserOpenPosition | null;
  loading: boolean;
}

const POLL_INTERVAL_MS = 30_000;
const FILL_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function useUserFills(coin: string): UseUserFillsResult {
  const { address } = useSafeAccount();
  const [fills, setFills] = useState<UserFill[]>([]);
  const [openPosition, setOpenPosition] = useState<UserOpenPosition | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!address || !coin) {
      setFills([]);
      setOpenPosition(null);
      return;
    }

    let cancelled = false;
    const displayCoin = coin.includes(":") ? coin.split(":")[1] ?? coin : coin;

    const fetchData = async () => {
      if (document.hidden) return; // skip when tab not visible
      setLoading(true);
      try {
        const [fillsRaw, stateRaw] = await Promise.all([
          fetch(HL_API + "/info", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: "userFillsByTime",
              user: address,
              startTime: Date.now() - FILL_LOOKBACK_MS,
              endTime: Date.now(),
            }),
          }).then(r => r.json()).catch(() => []),
          fetch(HL_API + "/info", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "clearinghouseState", user: address }),
          }).then(r => r.json()).catch(() => null),
        ]);

        if (cancelled) return;

        // Parse fills for this coin
        if (Array.isArray(fillsRaw)) {
          const parsed: UserFill[] = fillsRaw
            .filter((f: { coin?: string }) => f.coin === displayCoin)
            .map((f: {
              time: number;
              coin: string;
              side: "B" | "A";
              px: string;
              sz: string;
              dir: string;
              closedPnl: string;
              fee: string;
              hash: string;
              oid: number;
            }) => {
              const price = parseFloat(f.px);
              const size = parseFloat(f.sz);
              return {
                time: f.time,
                coin: f.coin,
                side: f.side,
                price,
                size,
                sizeUsd: price * size,
                direction: f.dir,
                closedPnl: parseFloat(f.closedPnl || "0"),
                fee: parseFloat(f.fee || "0"),
                hash: f.hash,
                oid: f.oid,
              };
            })
            .sort((a, b) => a.time - b.time);
          setFills(parsed);
        }

        // Parse open position for this coin
        if (stateRaw && Array.isArray(stateRaw.assetPositions)) {
          const pos = stateRaw.assetPositions.find(
            (p: { position?: { coin?: string } }) => p.position?.coin === displayCoin
          );
          if (pos?.position) {
            const szi = parseFloat(pos.position.szi || "0");
            if (Math.abs(szi) > 0) {
              setOpenPosition({
                coin: displayCoin,
                side: szi > 0 ? "long" : "short",
                size: Math.abs(szi),
                entryPrice: parseFloat(pos.position.entryPx || "0"),
                markPrice: parseFloat(pos.position.positionValue || "0") / Math.abs(szi),
                unrealizedPnl: parseFloat(pos.position.unrealizedPnl || "0"),
                leverage: parseFloat(pos.position.leverage?.value || "1"),
                liquidationPrice: pos.position.liquidationPx ? parseFloat(pos.position.liquidationPx) : undefined,
              });
            } else {
              setOpenPosition(null);
            }
          } else {
            setOpenPosition(null);
          }
        }
      } catch (err) {
        console.warn("[useUserFills] fetch error:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchData();
    const interval = window.setInterval(fetchData, POLL_INTERVAL_MS);
    const onVis = () => !document.hidden && fetchData();
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [address, coin]);

  return { fills, openPosition, loading };
}
