import { supabaseAdmin } from "./supabase";
import type { AgentId } from "./types";
import { AGENTS } from "../agents/registry";

export type AgentLive = "working" | "done" | "idle";

const WORKING = /^(tool:|cycle:start|qa:testing|qa:retesting|fixing|handle)/;
const DONE = /^(qa:passed|live|executed|finalized|handled|saved|approval)/;

export interface AgentStatusInfo {
  live: AgentLive;
  tool: string | null; // raw tool name (e.g. "db_read"), only set while live === "working"
}

// Circle status per agent: red = working, green = recently done, grey = idle.
export async function agentStatuses(): Promise<Record<AgentId, AgentStatusInfo>> {
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

  const toolOf = (action: string): string | null => {
    const m = /^tool:(.+)$/.exec(action);
    return m ? m[1] : null;
  };

  const out = {} as Record<AgentId, AgentStatusInfo>;
  for (const spec of AGENTS) {
    if (busy.has(spec.id)) {
      out[spec.id] = { live: "working", tool: toolOf(lastByAgent.get(spec.id)?.action ?? "") };
      continue;
    }
    const last = lastByAgent.get(spec.id);
    if (!last) {
      out[spec.id] = { live: "idle", tool: null };
      continue;
    }
    const ageMin = (Date.now() - new Date(last.created_at).getTime()) / 60000;
    if (ageMin < 4 && WORKING.test(last.action)) {
      out[spec.id] = { live: "working", tool: toolOf(last.action) };
    } else if (ageMin < 20 && DONE.test(last.action)) {
      out[spec.id] = { live: "done", tool: null };
    } else {
      out[spec.id] = { live: "idle", tool: null };
    }
  }
  return out;
}
