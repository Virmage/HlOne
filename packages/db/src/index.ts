export * from "./schema.js";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema.js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const { Pool } = pg;

export function createDb(connectionString: string) {
  const pool = new Pool({ connectionString });
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
