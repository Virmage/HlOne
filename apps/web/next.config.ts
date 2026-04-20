import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  reactStrictMode: false,
  // ─── Security headers ──────────────────────────────────────────────
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          // SAMEORIGIN allows /studio to iframe / (same-origin preview), still
          // blocks clickjacking attempts from external sites.
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // 'unsafe-inline' still required for Next.js bootstrap scripts.
              // 'wasm-unsafe-eval' needed for wagmi/viem WebAssembly (secp256k1, etc.).
              // 'unsafe-eval' removed to close a common XSS-to-RCE attack vector.
              "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com",
              "img-src 'self' data: blob: https:",
              "connect-src 'self' https://api.hyperliquid.xyz wss://api.hyperliquid.xyz https://api.lyra.finance wss://api.lyra.finance https://rpc.lyra.finance https://rpc.derive.xyz https://derive-proxy.hlone.workers.dev wss://derive-proxy.hlone.workers.dev https://*.walletconnect.com wss://*.walletconnect.com https://*.walletconnect.org wss://*.walletconnect.org https://*.vercel.app https://*.up.railway.app https://arb1.arbitrum.io",
              "frame-src 'self' https://*.walletconnect.com https://*.walletconnect.org",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'self'",
              "upgrade-insecure-requests",
            ].join("; "),
          },
        ],
      },
    ];
  },
  // Proxy API requests in production to avoid CORS issues.
  // IMPORTANT: explicitly list backend routes — do NOT use /api/:path* because that
  // would also proxy /api/studio/* which lives in this Next.js app, not the backend.
  async rewrites() {
    let apiUrl = process.env.NEXT_PUBLIC_API_URL;
    if (!apiUrl) return [];
    // Forgiving parsing: auto-prepend https:// if missing, strip trailing slash.
    // Next.js rewrites require full URLs with protocol.
    apiUrl = apiUrl.trim().replace(/\/$/, "");
    if (!/^https?:\/\//.test(apiUrl)) apiUrl = `https://${apiUrl}`;
    return [
      { source: "/api/market/:path*",    destination: `${apiUrl}/api/market/:path*` },
      { source: "/api/traders/:path*",   destination: `${apiUrl}/api/traders/:path*` },
      { source: "/api/copy/:path*",      destination: `${apiUrl}/api/copy/:path*` },
      { source: "/api/portfolio/:path*", destination: `${apiUrl}/api/portfolio/:path*` },
      { source: "/api/users/:path*",     destination: `${apiUrl}/api/users/:path*` },
      // NOTE: /api/studio/* is intentionally NOT here — handled locally by Next.js routes
    ];
  },
};

export default nextConfig;
