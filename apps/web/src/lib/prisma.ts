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
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) return null;

  // Validate protocol prefix. Prisma throws at query time otherwise, leaking
  // 500s. Better to treat a malformed URL as missing and let callers fall
  // back to dev-stub mode with a clean error.
  if (!/^postgres(ql)?:\/\//i.test(rawUrl)) {
    console.error(
      `[prisma] DATABASE_URL is set but missing postgresql:// prefix. Value starts with: "${rawUrl.slice(0, 20)}...". ` +
      `Studio will run without a database. Fix in Vercel env vars.`,
    );
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
