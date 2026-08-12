import { supabaseAdmin } from "./supabase";
import type { AgentId } from "./types";

// A cycle's Vercel function has a 300s ceiling (see app/api/cycle/route.ts's
// maxDuration), so any lock older than that is from a run that crashed or
// got killed without releasing it — treat it as stale rather than deadlocking
// the agent forever.
const LOCK_TTL_MS = 6 * 60 * 1000;

// Atomic acquire: the primary key on `agent` makes the insert itself the race-
// safe check (two concurrent callers can't both succeed), unlike a separate
// select-then-insert in JS which two overlapping requests could both pass.
export async function acquireAgentLock(agent: AgentId): Promise<boolean> {
  const staleBefore = new Date(Date.now() - LOCK_TTL_MS).toISOString();
  await supabaseAdmin.from("agent_locks").delete().eq("agent", agent).lt("started_at", staleBefore);
  const { error } = await supabaseAdmin.from("agent_locks").insert({ agent });
  return !error;
}

export async function releaseAgentLock(agent: AgentId): Promise<void> {
  await supabaseAdmin.from("agent_locks").delete().eq("agent", agent);
}
