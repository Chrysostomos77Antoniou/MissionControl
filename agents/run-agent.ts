import { runAgentLoop } from "./run-loop";
import { AGENTS, AGENT_BY_ID, type AgentSpec } from "./registry";
import { toolsFor, handlerToolsFor } from "../tools/registry";
import { recentMemory, writeMemory, logActivity } from "../lib/memory";
import { recordResult } from "../lib/suggestions";
import type { AgentId, Cadence, Suggestion } from "../lib/types";

export async function runAgent(spec: AgentSpec): Promise<string> {
  const memory = await recentMemory(spec.id, 5);
  const userMessage = `Recent suggestions you already made (do NOT repeat):\n${
    memory.map((m) => `- ${m.summary}`).join("\n") || "none"
  }\n\nRun your review now and save concrete suggestions.`;

  const summary = await runAgentLoop({
    agent: spec.id,
    system: spec.system,
    userMessage,
    tools: toolsFor(spec.id),
    maxTurns: 18,
  });
  await writeMemory(spec.id, summary.slice(0, 500));
  return summary;
}

export async function runGroup(cadence: Cadence): Promise<Record<string, string>> {
  const due = AGENTS.filter((a) => a.cadence === cadence);
  await logActivity(due[0]?.id ?? "engineering", "cycle:start", `Running ${cadence} group (${due.length} agents).`);
  const results = await Promise.allSettled(due.map((a) => runAgent(a)));
  const out: Record<string, string> = {};
  due.forEach((a, i) => {
    const r = results[i];
    out[a.id] = r.status === "fulfilled" ? r.value : `Error: ${r.reason}`;
  });
  return out;
}

export async function runOne(id: AgentId): Promise<string> {
  return runAgent(AGENT_BY_ID[id]);
}

// The owner clicked "Okay" — the responsible agent now EXECUTES the suggestion
// (opens a PR / applies a DB migration) or reports what the owner must do.
export async function runHandler(s: Suggestion): Promise<string> {
  const spec = AGENT_BY_ID[s.agent];
  const system = `${spec.system}

MODE: EXECUTION. The owner approved this suggestion by clicking "Okay". Carry it out to completion now — do not just re-describe it.
- Code changes: read the relevant repo files first, then open_github_pr with the FULL corrected file content.
- Database / security fixes: apply_db_migration directly (idempotent SQL).
- If you genuinely cannot finish autonomously, state clearly and specifically what the owner must do themselves, and why.
End with a 2-3 sentence summary: what you did (with PR link / migration name) OR what the owner must do.`;

  const userMessage = `Suggestion to execute:
Title: ${s.title}
Category: ${s.category ?? "general"}
Details:
${s.body}

Execute it now.`;

  const result = await runAgentLoop({
    agent: s.agent,
    system,
    userMessage,
    tools: handlerToolsFor(s.agent),
    maxTurns: 14,
  });
  await recordResult(s.id, result);
  await logActivity(s.agent, "handled", s.title.slice(0, 120));
  return result;
}
