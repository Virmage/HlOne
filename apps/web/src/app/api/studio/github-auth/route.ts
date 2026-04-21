/**
 * GET /api/studio/github-auth
 *
 * Kicks off the GitHub OAuth flow. Redirects user to GitHub's authorization
 * page, where they approve HLOne Studio's access to create a repo on their
 * behalf. GitHub redirects back to /api/studio/github-callback with a code.
 *
 * Env vars needed:
 *   GITHUB_OAUTH_CLIENT_ID    - from github.com/settings/developers → New OAuth App
 *   NEXT_PUBLIC_BASE_URL      - https://hlone.xyz (for callback URL)
 */

import { NextResponse } from "next/server";
import crypto from "crypto";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";

/** Strict validator for the `next` redirect. Must be a same-origin absolute
 * path (no protocol, no host, no `//` protocol-relative). Defaults to /studio. */
function safeNextPath(raw: string | null): string {
  if (!raw) return "/studio";
  // Reject anything that could route cross-origin: `//evil.com/…`, `https://…`,
  // `javascript:`, `data:`, etc. Must start with `/` and not `//`.
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/studio";
  if (raw.includes(":")) return "/studio"; // protocols
  if (raw.length > 200) return "/studio";
  // Only allow a small charset for paths to keep this boring.
  if (!/^[\w\-/.?=&]+$/.test(raw)) return "/studio";
  return raw;
}

export async function GET(req: Request) {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "GitHub OAuth not configured. Set GITHUB_OAUTH_CLIENT_ID env var." },
      { status: 503 },
    );
  }

  // The callback URL registered at GitHub MUST match NEXT_PUBLIC_BASE_URL
  // exactly — we never fall back to the request's host (which can be a
  // preview deploy's URL and lead to an OAuth app leaking across origins).
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
  if (!baseUrl || !baseUrl.startsWith("https://")) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_BASE_URL must be configured as https://… for GitHub OAuth" },
      { status: 503 },
    );
  }
  const redirectUri = `${baseUrl.replace(/\/$/, "")}/api/studio/github-callback`;

  const url = new URL(req.url);
  const state = crypto.randomBytes(16).toString("hex");
  const next = safeNextPath(url.searchParams.get("next"));

  const authorizeUrl = new URL(GITHUB_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", "public_repo");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("allow_signup", "true");

  const res = NextResponse.redirect(authorizeUrl.toString());
  // __Host- prefix forbids Domain attribute and requires Secure+Path=/ —
  // stops cookies from leaking to subdomains (including Vercel previews).
  res.cookies.set("__Host-hlone-gh-state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60,
  });
  res.cookies.set("__Host-hlone-gh-next", next, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60,
  });
  return res;
}
