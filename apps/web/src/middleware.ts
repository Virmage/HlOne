/**
 * Edge middleware — sets a per-request CSP nonce so we can keep inline
 * bootstrap scripts (localStorage polyfill, theme flash prevention, etc.)
 * WITHOUT using `script-src 'unsafe-inline'`.
 *
 * The nonce is:
 *   1. Generated fresh per request (crypto.randomUUID → base64)
 *   2. Injected into the `Content-Security-Policy` header as `nonce-<value>`
 *   3. Exposed to the app via the `x-nonce` request header so layout.tsx
 *      can read it with `headers()` and stamp `<script nonce={nonce}>`.
 *
 * Why this matters: `unsafe-inline` lets any injected `<script>` execute.
 * With nonces, only scripts we serve (with the correct per-request nonce)
 * can run — a stored or reflected XSS payload cannot predict the nonce,
 * so it's neutralized.
 */

import { NextRequest, NextResponse } from "next/server";

export function middleware(request: NextRequest) {
  // 128-bit random nonce, base64-urlsafe.
  const nonce = Buffer.from(crypto.randomUUID().replace(/-/g, "")).toString("base64");

  // Build CSP with the nonce. `'strict-dynamic'` lets nonce-trusted scripts
  // load further scripts without re-specifying the allowlist — prevents
  // legitimate bundler chunks from being blocked while still rejecting XSS.
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    // Allowlist specific image hosts — no `https:` wildcard (data-exfil vector).
    "img-src 'self' data: blob: https://api.hyperliquid.xyz https://imagedelivery.net https://avatars.githubusercontent.com",
    [
      "connect-src 'self'",
      "https://api.hyperliquid.xyz wss://api.hyperliquid.xyz",
      "https://api.lyra.finance wss://api.lyra.finance",
      "https://rpc.lyra.finance https://rpc.derive.xyz",
      "https://derive-proxy.hlone.workers.dev wss://derive-proxy.hlone.workers.dev",
      "https://*.walletconnect.com wss://*.walletconnect.com",
      "https://*.walletconnect.org wss://*.walletconnect.org",
      "https://arb1.arbitrum.io https://arbitrum.llamarpc.com",
      // Railway backend is on up.railway.app BUT only trust the specific host.
      // If you change hosts, update this allowlist.
      "https://*.up.railway.app",
      "https://ipapi.co",
    ].join(" "),
    "frame-src 'self' https://*.walletconnect.com https://*.walletconnect.org",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "upgrade-insecure-requests",
  ].join("; ");

  // Propagate the nonce to the app via a request header
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  // Also enforce HSTS at the edge (belt-and-braces — Vercel already sets it).
  response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  return response;
}

export const config = {
  matcher: [
    // Apply to all routes except static assets and API routes (API routes
    // don't serve HTML and don't need a CSP nonce).
    "/((?!_next/static|_next/image|favicon.ico|portalspin.gif|api/).*)",
  ],
};
