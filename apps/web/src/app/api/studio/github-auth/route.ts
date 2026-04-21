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

export async function GET(req: Request) {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "GitHub OAuth not configured. Set GITHUB_OAUTH_CLIENT_ID env var." },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL ??
    `${url.protocol}//${url.host}`;
  const redirectUri = `${baseUrl}/api/studio/github-callback`;

  // CSRF protection: random state, stored in cookie, verified in callback
  const state = crypto.randomBytes(16).toString("hex");

  // Optional: pass along a ?next param so we redirect back to where they came from
  const next = url.searchParams.get("next") ?? "/studio";

  const authorizeUrl = new URL(GITHUB_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", "public_repo"); // minimum to create repos from templates
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("allow_signup", "true");

  const res = NextResponse.redirect(authorizeUrl.toString());
  res.cookies.set("hlone-gh-state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60, // 10 min
  });
  res.cookies.set("hlone-gh-next", next, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60,
  });
  return res;
}
