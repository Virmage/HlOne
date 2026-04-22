/**
 * Retry wrapper for transient Postgres connection errors.
 *
 * Neon free-tier auto-suspends idle databases. The first request after
 * an idle window often hits ECONNREFUSED while Neon spins the compute
 * back up (typically 300-800ms). Similar story for any serverless
 * Postgres (Supabase, PlanetScale-compatible, etc).
 *
 * We retry only on errors that clearly indicate the server hasn't
 * accepted any request yet — ECONNREFUSED, ENOTFOUND, network timeouts.
 * Anything the server responded with (constraint violations, syntax
 * errors, permission errors) is surfaced immediately — those won't
 * improve on retry and retrying would hide real bugs.
 */

const RETRY_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);

function isRetryableDbError(err: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any;
  const codes = [e?.code, e?.cause?.code, e?.errors?.[0]?.code].filter(Boolean);
  for (const c of codes) if (RETRY_CODES.has(String(c))) return true;
  const msg = String(e?.message || "") + String(e?.cause?.message || "");
  if (/ECONN(REFUSED|RESET)|ETIMEDOUT|terminating connection/i.test(msg)) return true;
  return false;
}

export async function withDbRetry<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; label?: string } = {},
): Promise<T> {
  const max = opts.maxAttempts ?? 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableDbError(err) || attempt === max) throw err;
      // Exponential backoff: 300ms, 900ms, 2.7s. Neon cold-starts settle
      // in under 1s typically, so 2 retries usually catch it.
      const delay = 300 * Math.pow(3, attempt - 1);
      if (opts.label) console.warn(`[db-retry] ${opts.label} attempt ${attempt} failed (${(err as Error).message?.slice(0, 80)}), retrying in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
