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
