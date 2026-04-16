import { z } from "zod";

/** Ethereum address: 0x followed by 40 hex chars */
export const ethAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address");

/** Positive number (size, price, capital) */
export const positiveNumber = z.number().positive();

/** Non-negative number */
export const nonNegativeNumber = z.number().nonnegative();

/** Pagination: limit capped at 200, offset >= 0 */
export const paginationLimit = z.coerce.number().int().min(1).max(200).default(50);
export const paginationOffset = z.coerce.number().int().min(0).default(0);

/** UUID v4 */
export const uuid = z.string().uuid();

/** Asset/coin name: 1-30 alphanumeric chars, hyphens, colons, @ (e.g. BTC, ETH-PERP, @107) */
export const coinName = z.string().min(1).max(30).regex(/^[A-Za-z0-9:@\-\.]+$/, "Invalid coin name");

/** Normalize wallet address to lowercase */
export function normalizeAddress(addr: string): string {
  return addr.toLowerCase();
}
