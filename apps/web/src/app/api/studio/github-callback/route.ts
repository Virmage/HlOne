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

export async function GET(req: Request) {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(new URL(`/studio?gh_error=${encodeURIComponent(error)}`, url.origin));
  }

  if (!code || !state) {
    return NextResponse.redirect(new URL(`/studio?gh_error=missing_code`, url.origin));
  }

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(new URL(`/studio?gh_error=oauth_not_configured`, url.origin));
  }

  // CSRF check: state in cookie must match state in query
  const cookieStore = await cookies();
  const expectedState = cookieStore.get("hlone-gh-state")?.value;
  const nextParam = cookieStore.get("hlone-gh-next")?.value ?? "/studio";

  if (!expectedState || expectedState !== state) {
    return NextResponse.redirect(new URL(`/studio?gh_error=state_mismatch`, url.origin));
  }

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
      const errMsg = tokenData.error_description || tokenData.error || "token_exchange_failed";
      return NextResponse.redirect(new URL(`/studio?gh_error=${encodeURIComponent(errMsg)}`, url.origin));
    }
    accessToken = tokenData.access_token;

    // Fetch the user's GitHub login (so we know where to fork)
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!userRes.ok) {
      return NextResponse.redirect(new URL(`/studio?gh_error=user_fetch_failed`, url.origin));
    }
    const user = (await userRes.json()) as { login: string };
    login = user.login;
  } catch (err) {
    return NextResponse.redirect(new URL(`/studio?gh_error=${encodeURIComponent((err as Error).message)}`, url.origin));
  }

  // Redirect back with success
  const res = NextResponse.redirect(new URL(`${nextParam}?gh_connected=1`, url.origin));

  // Token: HttpOnly (never exposed to JS) — deploy API route reads this
  res.cookies.set("hlone-gh-token", accessToken, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 8 * 60 * 60, // 8 hours
  });

  // Login: readable by JS (displayed in UI)
  res.cookies.set("hlone-gh-login", login, {
    httpOnly: false,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 8 * 60 * 60,
  });

  // Clear state + next
  res.cookies.set("hlone-gh-state", "", { maxAge: 0, path: "/" });
  res.cookies.set("hlone-gh-next", "", { maxAge: 0, path: "/" });

  return res;
}
