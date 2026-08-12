import { supabaseAdmin } from "./supabase";
import { notify } from "./notify";

export interface CredentialCheck {
  ok: boolean;
  detail: string;
}

export interface CredentialHealth {
  github: CredentialCheck;
  supabase: CredentialCheck;
}

async function checkGithub(): Promise<CredentialCheck> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { ok: false, detail: "GITHUB_TOKEN not set" };
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    return res.ok
      ? { ok: true, detail: "OK" }
      : { ok: false, detail: `HTTP ${res.status}: ${(await res.text()).slice(0, 150)}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

async function checkSupabase(): Promise<CredentialCheck> {
  const ref = process.env.SUPABASE_PROJECT_REF;
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!ref || !token) return { ok: false, detail: "SUPABASE_PROJECT_REF / SUPABASE_ACCESS_TOKEN not set" };
  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok
      ? { ok: true, detail: "OK" }
      : { ok: false, detail: `HTTP ${res.status}: ${(await res.text()).slice(0, 150)}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

// Pings the two credentials that otherwise fail silently — a dead tool just
// returns an error string to the agent, which may not surface it loudly —
// instead of waiting for an agent to stumble into a 401 mid-cycle.
export async function checkCredentialHealth(): Promise<CredentialHealth> {
  const [github, supabase] = await Promise.all([checkGithub(), checkSupabase()]);
  return { github, supabase };
}

const ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000;

async function recentlyAlerted(action: string): Promise<boolean> {
  const since = new Date(Date.now() - ALERT_COOLDOWN_MS).toISOString();
  const { data } = await supabaseAdmin
    .from("activity_log")
    .select("id")
    .eq("action", action)
    .gte("created_at", since)
    .limit(1);
  return !!data?.length;
}

// Called once per cycle dispatch. At most one Telegram alert per 2h per
// credential while it stays broken, so an unresolved outage doesn't spam a
// message on every hourly cycle.
export async function alertIfCredentialsBroken(): Promise<void> {
  const health = await checkCredentialHealth();
  const checks: [string, CredentialCheck, string][] = [
    ["GitHub", health.github, "creds:github-down"],
    ["Supabase", health.supabase, "creds:supabase-down"],
  ];
  for (const [name, check, action] of checks) {
    if (check.ok) continue;
    if (await recentlyAlerted(action)) continue;
    await supabaseAdmin.from("activity_log").insert({ agent: "devops", action, detail: check.detail.slice(0, 300) });
    await notify(
      `🔴 ${name} credentials broken (${check.detail.slice(0, 100)}) — tools depending on it will fail until you refresh the token.`,
    );
  }
}
