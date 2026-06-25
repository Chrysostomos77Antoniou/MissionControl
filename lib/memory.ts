import { supabaseAdmin } from "./supabase";
import type { AgentId, MemoryEntry } from "./types";

export async function logActivity(agent: AgentId, action: string, detail?: string) {
  await supabaseAdmin.from("activity_log").insert({ agent, action, detail: detail ?? null });
}

export async function writeMemory(agent: AgentId, summary: string) {
  await supabaseAdmin.from("agent_memory").insert({ agent, summary, cycle_at: new Date().toISOString() });
}

export async function recentMemory(agent: AgentId, limit = 10): Promise<MemoryEntry[]> {
  const { data } = await supabaseAdmin
    .from("agent_memory")
    .select("*")
    .eq("agent", agent)
    .order("cycle_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as MemoryEntry[];
}
