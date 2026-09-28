import { supabaseAdmin } from "./supabase";
import type { AgentId } from "./types";

// Database-backed run locks on the existing `agent_locks` table
// (agent text PRIMARY KEY, started_at timestamptz). No migration: the lock
// key goes in `agent`, and the exact `started_at` this caller wrote is its
// OWNER TOKEN — release deletes only the row carrying that token, so a run
// whose lock expired can never release the lock a newer run now holds.
//
// Atomic acquire: the primary key makes the insert itself the race-safe
// check. A duplicate-key error is contention ("held"); any other failure is
// reported as "error", never silently treated as contention.

// Reserved key for a cycle-wide lock (no agent id can collide with it).
export const CYCLE_LOCK_KEY = "__cycle__" as const;
export type LockKey = AgentId | typeof CYCLE_LOCK_KEY;

// Must exceed the longest possible locked section of one agent run:
//   free loop  <= LOOP_DEADLINE_MS 20 min + one router call 5.5 min
//                 + 5 read-only tool calls x 60 s = 30.5 min (agents/free-loop.ts MAX_LOOP_MS)
//   grader     <= one router call, 5.5 min
//   total      ~= 36 min  ->  45 min leaves a 9 min margin.
// A crashed run therefore blocks that agent for at most 45 min.
export const AGENT_LOCK_TTL_MS = 45 * 60 * 1000;
// Cycle-wide lock, for a runner that executes several agents one after
// another. Commit 6b must keep (agents per cycle x AGENT_LOCK_TTL_MS) below it.
export const CYCLE_LOCK_TTL_MS = 4 * 60 * 60 * 1000;

export type LockResult =
  | { status: "acquired"; token: string }
  | { status: "held" }
  | { status: "error"; detail: string };

const UNIQUE_VIOLATION = "23505";
const errDetail = (e: unknown) =>
  (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e)).slice(0, 200);

export async function acquireLock(key: LockKey, ttlMs: number, now: () => Date = () => new Date()): Promise<LockResult> {
  try {
    const at = now();
    // A lock older than its TTL belongs to a run that crashed or was killed.
    const staleBefore = new Date(at.getTime() - ttlMs).toISOString();
    const cleanup = await supabaseAdmin.from("agent_locks").delete().eq("agent", key).lt("started_at", staleBefore);
    if (cleanup.error) return { status: "error", detail: `stale-lock cleanup failed: ${errDetail(cleanup.error)}` };

    const token = at.toISOString();
    const { error } = await supabaseAdmin.from("agent_locks").insert({ agent: key, started_at: token });
    if (!error) return { status: "acquired", token };
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) return { status: "held" };
    return { status: "error", detail: errDetail(error) };
  } catch (e) {
    return { status: "error", detail: errDetail(e) };
  }
}

// True only if this owner's row was deleted. False when the lock was taken
// over (expired) by someone else, already gone, or the delete failed.
export async function releaseLock(key: LockKey, token: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from("agent_locks")
      .delete()
      .eq("agent", key)
      .eq("started_at", token)
      .select("agent");
    return !error && Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

export const acquireAgentLock = (agent: AgentId, now?: () => Date) => acquireLock(agent, AGENT_LOCK_TTL_MS, now);
export const releaseAgentLock = (agent: AgentId, token: string) => releaseLock(agent, token);
export const acquireCycleLock = (now?: () => Date) => acquireLock(CYCLE_LOCK_KEY, CYCLE_LOCK_TTL_MS, now);
export const releaseCycleLock = (token: string) => releaseLock(CYCLE_LOCK_KEY, token);
