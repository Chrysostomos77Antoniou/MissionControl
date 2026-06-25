import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, expectedToken } from "./lib/auth";

// Public surfaces that must NOT require the owner cookie:
// - /login + its API (so you can sign in)
// - /api/cycle (called by Vercel Cron; it has its own CRON_SECRET guard)
const PUBLIC_PAGES = ["/login"];
const PUBLIC_API = ["/api/login", "/api/logout", "/api/cycle"];

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
