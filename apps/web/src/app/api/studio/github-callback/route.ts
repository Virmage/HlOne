/**
 * GET /api/studio/github-callback?code=...&state=...
 *
 * GitHub redirects here after the user approves HLOne Studio's OAuth request.
 * We exchange the code for an access token, store it in an HttpOnly cookie
 * (scoped to our domain), and redirect back to /studio.
 *
 * The token stays server-side (HttpOnly cookie — JS can't read it), so even if
 * XSS happens, attackers can't exfiltrate GitHub access. Deploy route reads
 * the cookie and uses the token to fork into the user's own GitHub account.
 *
 * Env vars needed:
 *   GITHUB_OAUTH_CLIENT_ID
 *   GITHUB_OAUTH_CLIENT_SECRET
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "crypto";

/** Constant-time compare for two hex strings (assumed same length). */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/** Whitelist of error codes we reflect into the redirect URL — prevents
 * attacker-controlled error strings from turning into phishing lures. */
const SAFE_ERROR_CODES = new Set([
  "access_denied", "missing_code", "state_mismatch",
  "oauth_not_configured", "token_exchange_failed", "user_fetch_failed",
]);
function safeErr(code: string): string {
  return SAFE_ERROR_CODES.has(code) ? code : "token_exchange_failed";
}

export async function GET(req: Request) {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  // Resolve the redirect origin strictly — never trust request host.
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL?.replace(/\/$/, "") ?? url.origin;

  if (error) {
    return NextResponse.redirect(new URL(`/studio?gh_error=${safeErr(error)}`, baseUrl));
  }

  if (!code || !state) {
    return NextResponse.redirect(new URL(`/studio?gh_error=missing_code`, baseUrl));
  }

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(new URL(`/studio?gh_error=oauth_not_configured`, baseUrl));
  }

  // CSRF check: state in cookie must match state in query. Timing-safe.
  const cookieStore = await cookies();
  const expectedState = cookieStore.get("__Host-hlone-gh-state")?.value;
  const nextRaw = cookieStore.get("__Host-hlone-gh-next")?.value ?? "/studio";

  if (!expectedState || !/^[a-f0-9]{32}$/.test(state) || !timingSafeEqualHex(expectedState, state)) {
    return NextResponse.redirect(new URL(`/studio?gh_error=state_mismatch`, baseUrl));
  }

  // Re-validate `next` — the cookie was set by us but belt-and-braces.
  const nextParam = (/^\/[\w\-/.?=&]*$/.test(nextRaw) && !nextRaw.startsWith("//")) ? nextRaw : "/studio";

  // Exchange code for access token
  let accessToken: string;
  let login: string;
  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
    const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string; error_description?: string };
    if (!tokenData.access_token) {
      return NextResponse.redirect(new URL(`/studio?gh_error=token_exchange_failed`, baseUrl));
    }
    accessToken = tokenData.access_token;

    // Fetch the user's GitHub login (so we know where to fork)
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "hlone-studio",
      },
    });
    if (!userRes.ok) {
      return NextResponse.redirect(new URL(`/studio?gh_error=user_fetch_failed`, baseUrl));
    }
    const user = (await userRes.json()) as { login?: string };
    if (!user.login || !/^[\w-]{1,39}$/.test(user.login)) {
      return NextResponse.redirect(new URL(`/studio?gh_error=user_fetch_failed`, baseUrl));
    }
    login = user.login;
  } catch {
    // Do NOT reflect the error message (may contain attacker-controlled content).
    return NextResponse.redirect(new URL(`/studio?gh_error=token_exchange_failed`, baseUrl));
  }

  // Redirect back with success
  const res = NextResponse.redirect(new URL(`${nextParam}?gh_connected=1`, baseUrl));

  // Token: __Host- prefix + HttpOnly (never exposed to JS). Cookie lifetime
  // shortened from 8h to 1h — user re-authorizes next time. This significantly
  // reduces the window where a stolen cookie has repo-write power.
  res.cookies.set("__Host-hlone-gh-token", accessToken, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60,
  });

  // Login: readable by JS (displayed in UI)
  res.cookies.set("__Host-hlone-gh-login", login, {
    httpOnly: false,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60,
  });

  // Clear state + next
  res.cookies.set("__Host-hlone-gh-state", "", { maxAge: 0, path: "/", secure: true });
  res.cookies.set("__Host-hlone-gh-next", "", { maxAge: 0, path: "/", secure: true });

  return res;
}
