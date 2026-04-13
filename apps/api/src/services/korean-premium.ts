/**
 * Korean Premium (Kimchi Premium) — tracks BTC/ETH price premium on Korean exchanges.
 * Uses Upbit (free, no auth) + frankfurter.app for FX rates (free, no auth).
 * Premium > 3% = retail FOMO, negative = capitulation.
 */

import { getCachedMids } from "./market-data.js";

export interface KoreanPremium {
  btc: { krwPrice: number; globalUsd: number; premiumPct: number } | null;
  eth: { krwPrice: number; globalUsd: number; premiumPct: number } | null;
  usdKrw: number;
  sentiment: "extreme_fomo" | "fomo" | "neutral" | "fear" | "extreme_fear";
  fetchedAt: number;
}

const UPBIT_URL = "https://api.upbit.com/v1/ticker?markets=KRW-BTC,KRW-ETH";
const FX_URL = "https://api.frankfurter.app/latest?from=USD&to=KRW";
const POLL_INTERVAL = 30_000; // 30s for crypto prices
const FX_POLL_INTERVAL = 10 * 60_000; // 10min for FX rate (doesn't move fast)

let cache: KoreanPremium | null = null;
let lastFetch = 0;
let fxRate: number | null = null;
let lastFxFetch = 0;

async function fetchFxRate(): Promise<number | null> {
  if (fxRate && Date.now() - lastFxFetch < FX_POLL_INTERVAL) return fxRate;

  try {
    const resp = await fetch(FX_URL);
    if (!resp.ok) return fxRate;
    const data = await resp.json() as { rates?: { KRW?: number } };
    if (data.rates?.KRW) {
      fxRate = data.rates.KRW;
      lastFxFetch = Date.now();
    }
    return fxRate;
  } catch {
    return fxRate;
  }
}

export async function fetchKoreanPremium(): Promise<KoreanPremium | null> {
  if (cache && Date.now() - lastFetch < POLL_INTERVAL) return cache;

  try {
    const [usdKrw, upbitResp, mids] = await Promise.all([
      fetchFxRate(),
      fetch(UPBIT_URL).then(r => r.ok ? r.json() as Promise<{ market: string; trade_price: number }[]> : null),
      getCachedMids(),
    ]);

    if (!usdKrw || !upbitResp || !mids) return cache;

    const upbitMap = new Map<string, number>();
    for (const item of upbitResp) {
      // "KRW-BTC" -> "BTC"
      const coin = item.market.replace("KRW-", "");
      upbitMap.set(coin, item.trade_price);
    }

    const globalBtc = mids["BTC"] || 0;
    const globalEth = mids["ETH"] || 0;
    const upbitBtc = upbitMap.get("BTC");
    const upbitEth = upbitMap.get("ETH");

    const btcPremium = upbitBtc && globalBtc > 0
      ? { krwPrice: upbitBtc, globalUsd: globalBtc, premiumPct: ((upbitBtc / usdKrw - globalBtc) / globalBtc) * 100 }
      : null;

    const ethPremium = upbitEth && globalEth > 0
      ? { krwPrice: upbitEth, globalUsd: globalEth, premiumPct: ((upbitEth / usdKrw - globalEth) / globalEth) * 100 }
      : null;

    // Average premium for sentiment
    const avgPremium = btcPremium ? btcPremium.premiumPct : 0;
    const sentiment: KoreanPremium["sentiment"] =
      avgPremium > 5 ? "extreme_fomo" :
      avgPremium > 2 ? "fomo" :
      avgPremium < -3 ? "extreme_fear" :
      avgPremium < -1 ? "fear" : "neutral";

    cache = {
      btc: btcPremium,
      eth: ethPremium,
      usdKrw,
      sentiment,
      fetchedAt: Date.now(),
    };
    lastFetch = Date.now();
    return cache;
  } catch (err) {
    console.warn("[korean-premium] fetch error:", err);
    return cache;
  }
}

export function getKoreanPremiumCached(): KoreanPremium | null {
  return cache;
}
