/**
 * Dev-only logger.
 *
 * In production, these calls are no-ops. In development, they log to the
 * browser console like normal. Use `dlog`/`dwarn`/`derror` in trading-path
 * code so we don't leak signature/agent/session-key debug info to any user
 * who opens DevTools in production.
 *
 * Critical errors that SHOULD surface in production should use
 * `console.error` directly (not derror). This utility is specifically for
 * verbose tracing that's only useful during development.
 */

const isDev =
  typeof process !== "undefined" && process.env.NODE_ENV !== "production";

const NOOP = () => {};

export const dlog: typeof console.log = isDev ? console.log.bind(console) : NOOP;
export const dwarn: typeof console.warn = isDev ? console.warn.bind(console) : NOOP;
export const derror: typeof console.error = isDev ? console.error.bind(console) : NOOP;
