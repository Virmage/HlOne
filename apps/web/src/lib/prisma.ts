/**
 * Prisma client singleton.
 *
 * Using a single instance across hot-reloads in dev, and safely handling the
 * case where DATABASE_URL isn't set (returns null instead of throwing, so the
 * app continues to work in preview mode without a database).
 */

import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __hlonePrisma: PrismaClient | null | undefined;
}

function createClient(): PrismaClient | null {
  if (!process.env.DATABASE_URL) {
    return null;
  }
  try {
    return new PrismaClient({
      log: process.env.NODE_ENV === "production" ? ["error"] : ["error", "warn"],
    });
  } catch (err) {
    console.error("[prisma] Failed to create client:", err);
    return null;
  }
}

export const prisma: PrismaClient | null =
  globalThis.__hlonePrisma ?? (globalThis.__hlonePrisma = createClient());

/** True when DATABASE_URL is configured and Prisma client was created. */
export function hasDatabase(): boolean {
  return prisma !== null;
}
