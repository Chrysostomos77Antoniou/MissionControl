import { supabaseAdmin } from "../lib/supabase";

async function countSince(table: string, since?: string): Promise<number | null> {
  let q = supabaseAdmin.from(table).select("*", { count: "exact", head: true });
  if (since) q = q.gte("created_at", since);
  const { count, error } = await q;
  return error ? null : count ?? 0;
}

function line(label: string, n: number | null): string {
  return n === null ? `${label}: unavailable` : `${label}: ${n}`;
}

export async function readFootrankStats(): Promise<string> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [users7d, usersTotal, matches7d, teams, reportsOpen, notif7d] = await Promise.all([
    countSince("users", since),
    countSince("users"),
    countSince("matches", since),
    countSince("teams"),
    countSince("behavior_reports"),
    countSince("notifications", since),
  ]);
  return [
    line("New signups (7d)", users7d),
    line("Total users", usersTotal),
    line("Matches created (7d)", matches7d),
    line("Total teams", teams),
    line("Behavior reports (total)", reportsOpen),
    line("Notifications sent (7d)", notif7d),
  ].join("\n");
}

// All-time totals for deterministic change detection (agents/cycle.ts).
// Unlike readFootrankStats, no rolling windows (those change as time
// passes). null if ANY count could not be read — never a partial result.
export async function readFootrankTotals(): Promise<{
  users: number;
  matches: number;
  teams: number;
  behavior_reports: number;
  notifications: number;
} | null> {
  const [users, matches, teams, behavior_reports, notifications] = await Promise.all([
    countSince("users"),
    countSince("matches"),
    countSince("teams"),
    countSince("behavior_reports"),
    countSince("notifications"),
  ]);
  if ([users, matches, teams, behavior_reports, notifications].some((n) => n === null)) return null;
  return { users: users!, matches: matches!, teams: teams!, behavior_reports: behavior_reports!, notifications: notifications! };
}
