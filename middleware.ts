import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, expectedToken } from "./lib/auth";

// Public surfaces that must NOT require the owner cookie:
// - /login + its API (so you can sign in)
// - /api/cycle (called by Vercel Cron; it has its own CRON_SECRET guard)
// - /api/webhooks/court-resolved (called by Postgres via pg_net inside
//   submit_court_picks(); has its own CRON_SECRET guard, same trust model as
//   /api/cycle). Listed as an exact path, NOT a "/api/webhooks" prefix, so
//   any future route added under that folder stays cookie-protected by
//   default unless explicitly added here too.
const PUBLIC_PAGES = ["/login"];
const PUBLIC_API = ["/api/login", "/api/logout", "/api/cycle", "/api/webhooks/court-resolved"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PAGES.includes(pathname) || PUBLIC_API.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const ok = token && token === (await expectedToken());
  if (ok) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
