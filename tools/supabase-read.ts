import { supabaseAdmin } from "../lib/supabase";

export async function readFootrankStats(): Promise<string> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const parts: string[] = [];

  // footrank stores accounts in `users` (not `profiles`)
  const users = await supabaseAdmin
    .from("users")
    .select("*", { count: "exact", head: true })
    .gte("created_at", since);
  parts.push(users.error ? "Signups: unavailable" : `New signups (7d): ${users.count ?? 0}`);

  const matches = await supabaseAdmin
    .from("matches")
    .select("*", { count: "exact", head: true })
    .gte("created_at", since);
  parts.push(matches.error ? "Matches: unavailable" : `Matches created (7d): ${matches.count ?? 0}`);

  const teams = await supabaseAdmin
    .from("teams")
    .select("*", { count: "exact", head: true });
  parts.push(teams.error ? "Teams: unavailable" : `Total teams: ${teams.count ?? 0}`);

  return parts.join("\n");
}
