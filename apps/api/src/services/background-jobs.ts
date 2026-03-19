/**
 * Background jobs — runs in the API server process via setInterval.
 * No Redis or separate worker needed.
 */

import { runWhaleCheck } from "./whale-tracker.js";
import { getSmartMoneyData } from "./smart-money.js";
import { getTokenScores } from "./scoring.js";
import { getCachedMids, getCachedAssetCtxs } from "./market-data.js";
import { getSignals } from "./signals.js";

let started = false;

export function startBackgroundJobs() {
  if (started) return;
  started = true;

  console.log("[bg] Starting background jobs...");

  // Every 60s: whale position check + price refresh
  setInterval(async () => {
    try {
      await getCachedMids(); // warm the price cache
      await getCachedAssetCtxs(); // warm asset contexts
      await runWhaleCheck();
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
      console.log("[bg] Smart money + scores + signals refreshed");
    } catch (err) {
      console.error("[bg] Smart money refresh failed:", (err as Error).message);
    }
  }, 5 * 60_000);

  // Initial warm-up (staggered to avoid slamming HL API)
  setTimeout(async () => {
    try {
      console.log("[bg] Initial warm-up: prices + asset contexts...");
      await getCachedMids();
      await getCachedAssetCtxs();
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
}
