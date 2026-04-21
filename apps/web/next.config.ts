import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  reactStrictMode: false,
  // ─── Security headers ──────────────────────────────────────────────
  // CSP is set per-request by middleware.ts so we can use a fresh nonce on
  // each response (enables nonce-based strict-dynamic XSS defense).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          // SAMEORIGIN allows /studio to iframe / (same-origin preview), still
          // blocks clickjacking attempts from external sites.
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          // X-XSS-Protection is deprecated (and can introduce bugs in Chromium).
          // Modern CSP handles XSS; explicitly disable the legacy header.
          { key: "X-XSS-Protection", value: "0" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
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
