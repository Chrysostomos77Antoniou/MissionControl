import { supabaseAdmin } from "./supabase";
import { agentStatuses } from "./agent-status";
import { AGENT_BY_ID } from "../agents/registry";
import type { AgentId } from "./types";

// A live snapshot of the whole team, fed to the orchestrator so it "knows
// everything" — every agent's findings, in-progress QA loops, and recent
// activity all report up to it.
export async function getOrchestratorBriefing(): Promise<string> {
  // Kept intentionally small: this briefing is rebuilt and re-sent as part of
  // the system prompt on every single chat turn (not just the first), so its
  // size directly adds to time-to-first-word on every reply. The orchestrator
  // can still dispatch agents / read the inbox for anything not covered here.
  const [{ data: sugg, count: suggCount }, { data: acts }, statuses] = await Promise.all([
    supabaseAdmin
      .from("suggestions")
      .select("agent,title,priority,qa_status", { count: "exact" })
      .eq("status", "new")
      .order("created_at", { ascending: false })
      .limit(12),
    supabaseAdmin
      .from("activity_log")
      .select("agent,action,detail,created_at")
      .order("created_at", { ascending: false })
      .limit(10),
    agentStatuses(),
  ]);

  const name = (a: string) => AGENT_BY_ID[a as AgentId]?.name ?? a;

  const statusLine = Object.entries(statuses)
    .map(([a, s]) => `${name(a)}=${s}`)
    .join(", ");

  const open = (sugg ?? [])
    .map((s) => {
      const qa = s.qa_status ? ` [QA: ${s.qa_status}]` : "";
      return `- (${s.priority}) ${name(s.agent)}: ${s.title}${qa}`;
    })
    .join("\n");

  const activity = (acts ?? [])
    .map((a) => `- ${name(a.agent)}: ${a.action}${a.detail ? ` — ${a.detail}` : ""}`)
    .join("\n");

  const total = suggCount ?? (sugg ?? []).length;
  const shownNote = total > (sugg ?? []).length ? ` (showing the ${(sugg ?? []).length} most recent)` : "";

  return [
    `AGENT STATUS: ${statusLine}`,
    ``,
    `OPEN SUGGESTIONS (${total} awaiting the owner${shownNote}):`,
    open || "- none",
    ``,
    `RECENT ACTIVITY:`,
    activity || "- none",
  ].join("\n");
}
