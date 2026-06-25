import { supabaseAdmin } from "./supabase";
import type { AgentId } from "./types";
import { AGENTS } from "../agents/registry";

export type AgentLive = "working" | "done" | "idle";

const WORKING = /^(tool:|cycle:start|qa:testing|qa:retesting|fixing|handle)/;
const DONE = /^(qa:passed|live|executed|finalized|handled|saved|approval)/;

// Circle status per agent: red = working, green = recently done, grey = idle.
export async function agentStatuses(): Promise<Record<AgentId, AgentLive>> {
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const [{ data: acts }, { data: sugg }] = await Promise.all([
    supabaseAdmin
      .from("activity_log")
      .select("agent, action, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false }),
    supabaseAdmin.from("suggestions").select("agent, qa_status").in("qa_status", ["testing", "fixing"]),
  ]);

  const busy = new Set((sugg ?? []).map((s) => s.agent));
  const lastByAgent = new Map<string, { action: string; created_at: string }>();
  for (const a of acts ?? []) {
    if (!lastByAgent.has(a.agent)) lastByAgent.set(a.agent, { action: a.action, created_at: a.created_at });
  }

  const out = {} as Record<AgentId, AgentLive>;
  for (const spec of AGENTS) {
    if (busy.has(spec.id)) {
      out[spec.id] = "working";
      continue;
    }
    const last = lastByAgent.get(spec.id);
    if (!last) {
      out[spec.id] = "idle";
      continue;
    }
    const ageMin = (Date.now() - new Date(last.created_at).getTime()) / 60000;
    if (ageMin < 4 && WORKING.test(last.action)) out[spec.id] = "working";
    else if (ageMin < 20 && DONE.test(last.action)) out[spec.id] = "done";
    else out[spec.id] = "idle";
  }
  return out;
}
