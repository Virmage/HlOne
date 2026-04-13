/**
 * Background jobs — runs in the API server process via setInterval.
 * No Redis or separate worker needed.
 */

import { runWhaleCheck } from "./whale-tracker.js";
import { getSmartMoneyData, loadSmartMoneyFromCache } from "./smart-money.js";
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
import { fetchDeribitFlow } from "./deribit-flow.js";
import { getAllOptionsData } from "./options-data.js";
import { fetchKoreanPremium } from "./korean-premium.js";
import { fetchEcosystemData } from "./hyperliquid-ecosystem.js";

let started = false;

export function startBackgroundJobs() {
  if (started) return;
  started = true;

  // Phase 1: Warm critical data FAST — parallelize independent fetches.
  // Railway keeps the old instance until healthcheck returns 200.
  console.log("[bg] Phase 1: warming prices + OI + smart money...");
  (async () => {
    try {
      // Phase 1a: all independent fetches in parallel
      await Promise.all([
        loadSmartMoneyFromCache(),
        getCachedMids(),
        getCachedAssetCtxs(),
        loadOIFromDb(),
        loadFillsFromDb(),
      ]);
      console.log("[bg] Phase 1a complete — prices + cached smart money warm");
      // OI snapshot needs mids to be warm
      snapshotOI().catch(e => console.error("[bg] OI snapshot:", (e as Error).message));
      // Phase 1b: live smart money scan (slower, but data is already available from cache)
      await getSmartMoneyData();
      await Promise.all([getTokenScores(), getSignals()]);
      console.log("[bg] Phase 1b complete — live smart money + signals warm");
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

    // Every 60s: Deribit options flow + Deribit options data + Korean premium (free APIs, no key needed)
    setInterval(async () => {
      try {
        await fetchDeribitFlow();
        await getAllOptionsData().catch(e => console.error("[bg] Deribit options:", (e as Error).message));
        await fetchKoreanPremium();
      } catch (err) {
        console.error("[bg] Deribit/KR premium:", (err as Error).message);
      }
    }, 60_000);

    // Every 120s: Ecosystem data (vaults, staking, platform stats)
    setInterval(async () => {
      try { await fetchEcosystemData(); } catch (err) {
        console.error("[bg] Ecosystem:", (err as Error).message);
      }
    }, 120_000);

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

    // Warm remaining data in parallel (smart money already done in Phase 1)
    (async () => {
      try {
        console.log("[bg] Phase 2 warm-up: all secondary data in parallel...");
        await Promise.all([
          getCachedHip3Tokens().catch(e => console.error("[bg] HIP-3:", (e as Error).message)),
          getNewsFeed().catch(e => console.error("[bg] CryptoPanic:", (e as Error).message)),
          getBatchSocialMetrics().catch(e => console.error("[bg] LunarCrush:", (e as Error).message)),
          getMacroData().catch(e => console.error("[bg] Macro:", (e as Error).message)),
          computeCorrelationMatrix().catch(e => console.error("[bg] Correlation:", (e as Error).message)),
          warmLiquidationMids().catch(() => {}),
          warmOrderFlowMids().catch(() => {}),
          getAllDeriveOptionsData().catch(e => console.error("[bg] Derive:", (e as Error).message)),
          fetchDeribitFlow().catch(e => console.error("[bg] Deribit flow:", (e as Error).message)),
          getAllOptionsData().catch(e => console.error("[bg] Deribit options:", (e as Error).message)),
          fetchKoreanPremium().catch(e => console.error("[bg] KR premium:", (e as Error).message)),
          fetchEcosystemData().catch(e => console.error("[bg] Ecosystem:", (e as Error).message)),
        ]);
        console.log("[bg] Phase 2 warm-up complete");
      } catch (err) {
        console.error("[bg] Phase 2 warm-up failed:", (err as Error).message);
      }

      // Whale tracker after other data is warm (needs positions data)
      try {
        await runWhaleCheck();
        console.log("[bg] Whale tracker warm");
      } catch (err) {
        console.error("[bg] Whale tracker warm-up failed:", (err as Error).message);
      }
    })();
  }, BOOT_DELAY);
}
