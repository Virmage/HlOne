export * from "./schema.js";
export { encryptPrivateKey, decryptPrivateKey, isEncrypted } from "./crypto.js";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema.js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const { Pool } = pg;

export function createDb(connectionString: string) {
  // Neon free tier auto-suspends idle Postgres instances — first request
  // after an idle window often hits ECONNREFUSED while the compute warms
  // back up (300-800ms). Conservative pool bounds + a short connect timeout
  // keep us from piling onto a cold DB and failing loudly.
  const pool = new Pool({
    connectionString,
    // Max 10 simultaneous clients — below Neon free's ~100 and well below
    // most paid plans. Prevents connection-exhaustion cascades.
    max: 10,
    // Give Neon up to 15s to wake from cold start before we give up.
    connectionTimeoutMillis: 15_000,
    // Release idle clients aggressively — with serverless-ish API containers
    // it's better to close than hold.
    idleTimeoutMillis: 10_000,
    // Don't let a stuck query hang a client forever.
    statement_timeout: 30_000,
  });
  // Emit warnings when the pool has trouble — shows up in Railway logs.
  pool.on("error", (err) => console.error("[db-pool] idle client error:", err.message));
  return drizzle(pool, { schema });
}

export type Database = ReturnType<typeof createDb>;

/**
 * Run all pending migrations automatically.
 * Safe to call on every startup — already-applied migrations are skipped.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 10_000, // 10s to connect
    idleTimeoutMillis: 5_000,
  });
  const db = drizzle(pool, { schema });

  // Resolve migrations folder relative to this file (works in both dev and built dist)
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(__dirname, "../drizzle");

  console.log("[db] Running migrations from", migrationsFolder);

  // Wrap in a timeout so a stuck migration never blocks server startup
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Migration timed out after 30s")), 30_000)
  );
  await Promise.race([migrate(db, { migrationsFolder }), timeout]);
  console.log("[db] Migrations complete");

  await pool.end();
}
