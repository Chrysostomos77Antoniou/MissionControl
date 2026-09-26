import { supabaseAdmin } from "./supabase";
import type { AgentId, Suggestion } from "./types";

export async function saveSuggestion(input: {
  agent: AgentId;
  category: string;
  title: string;
  body: string;
  priority: "low" | "medium" | "high";
}): Promise<void> {
  await supabaseAdmin.from("suggestions").insert(input);
}

export async function listSuggestions(
  status: "new" | "done" | "dismissed" = "new",
): Promise<Suggestion[]> {
  const { data } = await supabaseAdmin
    .from("suggestions")
    .select("*")
    .eq("status", status)
    .order("created_at", { ascending: false });
  return (data ?? []) as Suggestion[];
}

// This agent's own currently-unresolved findings — the real, accurate
// dedup signal for a cycle run (unlike a fuzzy memory of what it last wrote).
// A still-open suggestion doesn't need to be re-saved; only a genuinely new
// or materially-changed finding does.
export async function openSuggestionsForAgent(agent: AgentId): Promise<Suggestion[]> {
  const { data } = await supabaseAdmin
    .from("suggestions")
    .select("*")
    .eq("agent", agent)
    .eq("status", "new")
    .order("created_at", { ascending: false })
    .limit(15);
  return (data ?? []) as Suggestion[];
}

// A lightweight, cross-agent digest (title/category only, not the full body)
// so one agent doesn't propose something that duplicates or contradicts what
// another agent already has open — each agent otherwise only ever sees its
// OWN open suggestions via openSuggestionsForAgent, with zero visibility
// into the other 12 agents' pending findings.
export async function allOpenSuggestionsDigest(
  excludeAgent: AgentId,
): Promise<{ agent: AgentId; category: string | null; title: string }[]> {
  const { data } = await supabaseAdmin
    .from("suggestions")
    .select("agent, category, title")
    .eq("status", "new")
    .order("created_at", { ascending: false })
    .limit(40);
  return ((data ?? []) as { agent: AgentId; category: string | null; title: string }[]).filter(
    (s) => s.agent !== excludeAgent,
  );
}

export async function getSuggestion(id: string): Promise<Suggestion | null> {
  const { data } = await supabaseAdmin.from("suggestions").select("*").eq("id", id).single();
  return (data as Suggestion) ?? null;
}

export async function updateSuggestion(id: string, status: "new" | "done" | "dismissed"): Promise<void> {
  await supabaseAdmin.from("suggestions").update({ status }).eq("id", id);
}

export async function updateQa(
  id: string,
  fields: Partial<{
    qa_status: string | null;
    qa_branch: string | null;
    qa_run_id: string | null;
    qa_attempts: number;
    qa_log: string | null;
    result: string;
    outcome: "fixed" | "action_needed";
    pr_url: string | null;
  }>,
): Promise<void> {
  await supabaseAdmin.from("suggestions").update(fields).eq("id", id);
}

export async function recordResult(
  id: string,
  result: string,
  pr_url: string | null,
  outcome: "fixed" | "action_needed",
): Promise<void> {
  await supabaseAdmin.from("suggestions").update({ result, pr_url, outcome }).eq("id", id);
}

export async function suggestionsSince(agent: AgentId, sinceIso: string): Promise<Suggestion[]> {
  const { data } = await supabaseAdmin
    .from("suggestions")
    .select("*")
    .eq("agent", agent)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false });
  return (data ?? []) as Suggestion[];
}

// Pure — no I/O — so this is the one function in this file worth a real
// unit test. Returns null (not NaN/Infinity) when nothing has been decided
// yet, so callers can render "no data" instead of a bogus percentage.
export function computeApprovalRate(done: number, dismissed: number): number | null {
  const total = done + dismissed;
  if (total === 0) return null;
  return done / total;
}

export interface ApprovalStats {
  done: number;
  dismissed: number;
  rate: number | null;
}

export async function agentApprovalStats(agent: AgentId, sinceIso: string): Promise<ApprovalStats> {
  const { data } = await supabaseAdmin
    .from("suggestions")
    .select("status")
    .eq("agent", agent)
    .in("status", ["done", "dismissed"])
    .gte("created_at", sinceIso);
  const rows = (data ?? []) as { status: "done" | "dismissed" }[];
  const done = rows.filter((r) => r.status === "done").length;
  const dismissed = rows.filter((r) => r.status === "dismissed").length;
  return { done, dismissed, rate: computeApprovalRate(done, dismissed) };
}
