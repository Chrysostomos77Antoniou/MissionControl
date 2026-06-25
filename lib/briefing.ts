import { supabaseAdmin } from "./supabase";
import { agentStatuses } from "./agent-status";
import { AGENT_BY_ID } from "../agents/registry";
import type { AgentId } from "./types";

// A live snapshot of the whole team, fed to the orchestrator so it "knows
// everything" — every agent's findings, in-progress QA loops, and recent
// activity all report up to it.
export async function getOrchestratorBriefing(): Promise<string> {
  const [{ data: sugg }, { data: acts }, statuses] = await Promise.all([
    supabaseAdmin
      .from("suggestions")
      .select("agent,title,priority,qa_status")
      .eq("status", "new")
      .order("created_at", { ascending: false })
      .limit(40),
    supabaseAdmin
      .from("activity_log")
      .select("agent,action,detail,created_at")
      .order("created_at", { ascending: false })
      .limit(18),
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

  return [
    `AGENT STATUS: ${statusLine}`,
    ``,
    `OPEN SUGGESTIONS (${(sugg ?? []).length} awaiting the owner):`,
    open || "- none",
    ``,
    `RECENT ACTIVITY:`,
    activity || "- none",
  ].join("\n");
}
