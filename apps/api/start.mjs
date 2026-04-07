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

try {
  console.log("[start] Loading main module...");
  await import("./dist/index.js");
  console.log("[start] Main module loaded OK");
} catch (err) {
  console.error("[start] FATAL: Failed to load main module:", err);
  // Keep process alive briefly so Railway captures the logs
  setTimeout(() => process.exit(1), 30000);
}
