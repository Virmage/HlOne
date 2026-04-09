/**
 * Background jobs — runs in the API server process via setInterval.
 * No Redis or separate worker needed.
 */

import { runWhaleCheck } from "./whale-tracker.js";
import { getSmartMoneyData } from "./smart-money.js";
import { getTokenScores } from "./scoring.js";
import { getCachedMids, getCachedAssetCtxs } from "./market-data.js";
import { getSignals } from "./signals.js";
import { snapshotOI, loadOIFromDb, cleanupOldOISnapshots } from "./oi-tracker.js";
import { getNewsFeed } from "./crypto-panic.js";
import { getBatchSocialMetrics } from "./lunar-crush.js";
import { startTradeTapeTracking } from "./trade-tape.js";
import { getMacroData } from "./macro-data.js";
import { startTopTraderFillsTracking, loadFillsFromDb } from "./top-trader-fills.js";
import { computeCorrelationMatrix } from "./correlation-matrix.js";
import { startOrderFlowTracking, warmOrderFlowMids } from "./order-flow.js";
import { warmLiquidationMids } from "./liquidation-heatmap.js";
import { getCachedHip3Tokens } from "./market-data.js";
import { getAllDeriveOptionsData } from "./derive-options.js";
import { prewarmTokenDetails } from "../routes/market.js";

let started = false;

export function startBackgroundJobs() {
  if (started) return;
  started = true;

  // Phase 1: Warm prices + OI immediately so healthcheck passes quickly.
  // Railway keeps the old instance until healthcheck returns 200.
  console.log("[bg] Phase 1: warming prices + OI (healthcheck gates on this)...");
  (async () => {
    try {
      await getCachedMids();
      await getCachedAssetCtxs();
      await loadOIFromDb();
      await loadFillsFromDb();
      await snapshotOI();
      console.log("[bg] Phase 1 complete — healthcheck should pass now");
    } catch (err) {
      console.error("[bg] Phase 1 warm-up failed:", (err as Error).message);
    }
  })();

  // Phase 2: Delay heavier work by 30s to avoid HL 429 storms during deploy
  // (old + new containers both hitting API simultaneously)
  const BOOT_DELAY = 30_000;

  setTimeout(() => {
    console.log("[bg] Phase 2: starting all background jobs...");

    // Start trade tape polling (every 20s, self-managed interval)
    startTradeTapeTracking();
    // Start order flow tracking (every 20s, self-managed interval)
    startOrderFlowTracking();
    // Start top trader fills tracking (30min refresh, starts after smart money warms up)
    startTopTraderFillsTracking();

    // Every 15s: OI snapshot (fast accumulation for chart overlay)
    setInterval(async () => {
      try {
        await snapshotOI();
      } catch (err) {
        console.error("[bg] OI snapshot failed:", (err as Error).message);
      }
    }, 15_000);

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
        await getNewsFeed().catch(e => console.error("[bg] CryptoPanic:", (e as Error).message));
        await getBatchSocialMetrics().catch(e => console.error("[bg] LunarCrush:", (e as Error).message));
        await getMacroData().catch(e => console.error("[bg] Macro data:", (e as Error).message));
        await computeCorrelationMatrix().catch(e => console.error("[bg] Correlation:", (e as Error).message));
        await warmLiquidationMids().catch(() => {});
        await warmOrderFlowMids().catch(() => {});
        await getAllDeriveOptionsData().catch(e => console.error("[bg] Derive options:", (e as Error).message));
        console.log("[bg] Smart money + scores + signals + news + social + macro + correlation + derive refreshed");
      } catch (err) {
        console.error("[bg] Smart money refresh failed:", (err as Error).message);
      }
    }, 5 * 60_000);

    // Every 30s: pre-warm token detail cache for top coins
    setInterval(async () => {
      try {
        await prewarmTokenDetails();
      } catch (err) {
        console.error("[bg] Token pre-warm failed:", (err as Error).message);
      }
    }, 30_000);

    // Daily OI cleanup (remove snapshots older than 30 days)
    setInterval(async () => {
      try { await cleanupOldOISnapshots(); } catch {}
    }, 24 * 60 * 60_000);

    // Refresh HIP-3 every 60s
    setInterval(async () => {
      try {
        await getCachedHip3Tokens();
      } catch { /* ignore */ }
    }, 60_000);

    // Staggered warm-up of remaining data
    (async () => {
      try {
        console.log("[bg] Initial warm-up: smart money...");
        await getSmartMoneyData();
      } catch (err) {
        console.error("[bg] Smart money warm-up failed:", (err as Error).message);
      }

      await new Promise(r => setTimeout(r, 10_000));

      try {
        console.log("[bg] Initial warm-up: HIP-3 builder perps...");
        await getCachedHip3Tokens();
        console.log("[bg] HIP-3 warm-up complete");
      } catch (err) {
        console.error("[bg] HIP-3 warm-up failed:", (err as Error).message);
      }

      await new Promise(r => setTimeout(r, 10_000));

      try {
        console.log("[bg] Initial warm-up: news + social + macro + correlation...");
        await getNewsFeed().catch(e => console.error("[bg] CryptoPanic warm-up:", (e as Error).message));
        await getBatchSocialMetrics().catch(e => console.error("[bg] LunarCrush warm-up:", (e as Error).message));
        await getMacroData().catch(e => console.error("[bg] Macro warm-up:", (e as Error).message));
        await computeCorrelationMatrix().catch(e => console.error("[bg] Correlation warm-up:", (e as Error).message));
        await warmLiquidationMids().catch(() => {});
        await warmOrderFlowMids().catch(() => {});
        await getAllDeriveOptionsData().catch(e => console.error("[bg] Derive warm-up:", (e as Error).message));
        console.log("[bg] News + social + macro + correlation + derive warm-up complete");
      } catch (err) {
        console.error("[bg] News/social warm-up failed:", (err as Error).message);
      }

      await new Promise(r => setTimeout(r, 15_000));

      try {
        console.log("[bg] Initial warm-up: whale tracker...");
        await runWhaleCheck();
      } catch (err) {
        console.error("[bg] Whale tracker warm-up failed:", (err as Error).message);
      }
    })();
  }, BOOT_DELAY);
}
