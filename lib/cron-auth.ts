import { createHash, timingSafeEqual } from "node:crypto";

// Bearer check for the scheduler endpoint (/api/cycle). Fails CLOSED:
// a missing/blank CRON_SECRET authorises nothing (so "Bearer undefined" can
// never match), and an empty token is rejected. Both sides are hashed to a
// fixed length first so the comparison is constant-time.
export function isCronAuthorized(authorization: string | null | undefined, secret: string | null | undefined): boolean {
  const expected = typeof secret === "string" ? secret.trim() : "";
  if (!expected) return false;
  if (typeof authorization !== "string") return false;
  const m = /^Bearer (.+)$/.exec(authorization);
  const given = m ? m[1].trim() : "";
  if (!given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
