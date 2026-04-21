/**
 * GET /api/studio/github-status
 *
 * Lightweight endpoint that tells the Studio UI whether the user has an
 * active GitHub OAuth session. Reads the HttpOnly hlone-gh-token cookie
 * server-side and returns { connected, login }. The token itself is never
 * exposed to the client.
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";

export async function GET() {
  const cookieStore = await cookies();
  const token = cookieStore.get("hlone-gh-token")?.value;
  const login = cookieStore.get("hlone-gh-login")?.value;
  if (!token) {
    return NextResponse.json({ connected: false });
  }
  return NextResponse.json({ connected: true, login: login ?? null });
}

/**
 * DELETE /api/studio/github-status — disconnect (clear cookies)
 */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set("hlone-gh-token", "", { maxAge: 0, path: "/" });
  res.cookies.set("hlone-gh-login", "", { maxAge: 0, path: "/" });
  return res;
}
