/**
 * Background jobs — runs in the API server process via setInterval.
 * No Redis or separate worker needed.
 */

import { runWhaleCheck } from "./whale-tracker.js";
import { getSmartMoneyData } from "./smart-money.js";
import { getTokenScores } from "./scoring.js";
import { getCachedMids, getCachedAssetCtxs } from "./market-data.js";
import { getSignals } from "./signals.js";
import { snapshotOI } from "./oi-tracker.js";
import { getNewsFeed } from "./crypto-panic.js";
import { getBatchSocialMetrics } from "./lunar-crush.js";
import { startTradeTapeTracking } from "./trade-tape.js";
import { getMacroData } from "./macro-data.js";

let started = false;

export function startBackgroundJobs() {
  if (started) return;
  started = true;

  console.log("[bg] Starting background jobs...");

  // Start trade tape polling (every 20s, self-managed interval)
  startTradeTapeTracking();

  // Every 60s: whale position check + price refresh + OI snapshot
  setInterval(async () => {
    try {
      await getCachedMids(); // warm the price cache
      await getCachedAssetCtxs(); // warm asset contexts
      await runWhaleCheck();
      await snapshotOI();
    } catch (err) {
      console.error("[bg] Whale check failed:", (err as Error).message);
    }
  }, 60_000);

  // Every 5 min: smart money aggregation + scoring
  setInterval(async () => {
    try {
      await getSmartMoneyData();
      await getTokenScores();
      await getSignals();
      await getNewsFeed().catch(e => console.error("[bg] CryptoPanic:", (e as Error).message));
      await getBatchSocialMetrics().catch(e => console.error("[bg] LunarCrush:", (e as Error).message));
      await getMacroData().catch(e => console.error("[bg] Macro data:", (e as Error).message));
      console.log("[bg] Smart money + scores + signals + news + social + macro refreshed");
    } catch (err) {
      console.error("[bg] Smart money refresh failed:", (err as Error).message);
    }
  }, 5 * 60_000);

  // Initial warm-up (staggered to avoid slamming HL API)
  setTimeout(async () => {
    try {
      console.log("[bg] Initial warm-up: prices + asset contexts + OI...");
      await getCachedMids();
      await getCachedAssetCtxs();
      await snapshotOI();
    } catch (err) {
      console.error("[bg] Price warm-up failed:", (err as Error).message);
    }
  }, 2000);

  setTimeout(async () => {
    try {
      console.log("[bg] Initial warm-up: smart money...");
      await getSmartMoneyData();
    } catch (err) {
      console.error("[bg] Smart money warm-up failed:", (err as Error).message);
    }
  }, 10_000);

  setTimeout(async () => {
    try {
      console.log("[bg] Initial warm-up: whale tracker...");
      await runWhaleCheck();
    } catch (err) {
      console.error("[bg] Whale tracker warm-up failed:", (err as Error).message);
    }
  }, 30_000);

  // News + social warm-up (after 15s to stagger)
  setTimeout(async () => {
    try {
      console.log("[bg] Initial warm-up: news + social + macro...");
      await getNewsFeed().catch(e => console.error("[bg] CryptoPanic warm-up:", (e as Error).message));
      await getBatchSocialMetrics().catch(e => console.error("[bg] LunarCrush warm-up:", (e as Error).message));
      await getMacroData().catch(e => console.error("[bg] Macro warm-up:", (e as Error).message));
      console.log("[bg] News + social + macro warm-up complete");
    } catch (err) {
      console.error("[bg] News/social warm-up failed:", (err as Error).message);
    }
  }, 15_000);
}
