/**
 * Wrapper entry point that catches ESM module resolution errors.
 * Without this, if any import fails, Node exits silently with no logs.
 */
console.log(`[start] pid=${process.pid} node=${process.version} cwd=${process.cwd()}`);
console.log(`[start] PORT=${process.env.PORT} NODE_ENV=${process.env.NODE_ENV} DB=${process.env.DATABASE_URL ? "set" : "NOT SET"}`);

process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
  setTimeout(() => process.exit(1), 5000);
});
process.on("unhandledRejection", (err) => {
  console.error("[FATAL] Unhandled rejection:", err);
});

// ── Memory watchdog ──────────────────────────────────────────────────
// History: this process has OOMed on Railway twice in a single day. To
// stop that pattern recurring while we hunt for the underlying leaks:
//
//   1. Heap cap is now 1.5GB (Dockerfile CMD --max-old-space-size=1536).
//      Better to fail fast than let V8 swell to 6GB and spend minutes
//      thrashing GC at <20% mu before the inevitable crash.
//   2. Every 60s, log heap usage. If we're past 1.2GB (80% of cap),
//      proactively trigger GC. If we're past 1.4GB (93%), gracefully
//      exit so Railway brings up a fresh container — much cleaner than
//      letting V8 OOM-abort mid-request.
//   3. Every 12h, exit cleanly regardless. Periodic restart catches any
//      slow leak we haven't identified yet AND clears any fragmentation.
const MEM_WATCHDOG_INTERVAL_MS = 60_000;
const MEM_CAP_MB = 1536;                          // matches --max-old-space-size
const MEM_WARN_MB = MEM_CAP_MB * 0.80;            // 1.2GB → opportunistic GC
const MEM_RESTART_MB = MEM_CAP_MB * 0.93;         // 1.4GB → graceful exit
const PERIODIC_RESTART_MS = 12 * 60 * 60_000;     // 12h

const bootTs = Date.now();
setInterval(() => {
  const m = process.memoryUsage();
  const heapMb = Math.round(m.heapUsed / (1024 * 1024));
  const rssMb = Math.round(m.rss / (1024 * 1024));
  const uptimeMin = Math.round((Date.now() - bootTs) / 60_000);

  if (heapMb >= MEM_RESTART_MB) {
    console.warn(`[watchdog] heap ${heapMb}MB / cap ${MEM_CAP_MB}MB — exiting for Railway restart`);
    // exit(1) not exit(0) so Railway's restartPolicy treats this as a
    // failure-restart trigger. (railway.json was on ON_FAILURE when
    // this watchdog was first introduced — exit(0) silently parked the
    // container for 12h. railway.json is now ALWAYS, but using exit(1)
    // keeps us correct under any policy.)
    setTimeout(() => process.exit(1), 1000);
    return;
  }
  if (heapMb >= MEM_WARN_MB && globalThis.gc) {
    console.warn(`[watchdog] heap ${heapMb}MB high — forcing GC`);
    try { globalThis.gc(); } catch {}
  }
  if (Date.now() - bootTs >= PERIODIC_RESTART_MS) {
    console.log(`[watchdog] periodic 12h restart triggered (uptime ${uptimeMin}min)`);
    setTimeout(() => process.exit(1), 1000);
    return;
  }
  // Log every 5 minutes at info level so we can see the trajectory
  // without flooding logs.
  if (uptimeMin > 0 && uptimeMin % 5 === 0) {
    console.log(`[watchdog] uptime=${uptimeMin}min heap=${heapMb}MB rss=${rssMb}MB`);
  }
}, MEM_WATCHDOG_INTERVAL_MS);

try {
  console.log("[start] Loading main module...");
  await import("./dist/index.js");
  console.log("[start] Main module loaded OK");
} catch (err) {
  console.error("[start] FATAL: Failed to load main module:", err);
  // Keep process alive briefly so Railway captures the logs
  setTimeout(() => process.exit(1), 30000);
}
