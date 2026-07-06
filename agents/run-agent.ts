import { runAgentLoop } from "./run-loop";
import { SONNET } from "../lib/anthropic";
import { AGENTS, AGENT_BY_ID, type AgentSpec } from "./registry";
import { toolsFor, handlerToolsFor } from "../tools/registry";
import { writeMemory, logActivity } from "../lib/memory";
import { recordResult, openSuggestionsForAgent } from "../lib/suggestions";
import { withinBudget } from "../lib/usage";
import type { AgentId, Cadence, Suggestion } from "../lib/types";

export async function runAgent(spec: AgentSpec): Promise<string> {
  // The real, accurate signal for what's still unresolved — not a fuzzy
  // memory of what the agent last happened to write. A still-open finding
  // doesn't need re-saving; that's what made every cycle look "different"
  // even when the underlying picture hadn't actually changed.
  const open = await openSuggestionsForAgent(spec.id);
  const openList = open.length
    ? open.map((s) => `- (${s.priority}) ${s.title}`).join("\n")
    : "none — your inbox is currently clear";
  const userMessage = `Your own findings currently OPEN and unresolved in the owner's inbox:\n${openList}\n\nDo not save a duplicate of any of these. If the evidence still supports one, that's fine and expected — it's already pending, leave it as-is. Only save something new if it's a genuinely distinct problem, or a material update to one of the above (say so explicitly if it's an update). Run your review now per your standard procedure.`;

  const { text } = await runAgentLoop({
    agent: spec.id,
    system: spec.system,
    userMessage,
    tools: toolsFor(spec.id),
    maxTurns: 12,
    model: spec.model ?? SONNET, // per-agent override for low-stakes agents (see registry.ts)
    effort: "high", // deep analysis before concluding, not a quick scan
  });
  await writeMemory(spec.id, text.slice(0, 500));
  return text;
}

export async function runGroup(cadence: Cadence): Promise<Record<string, string>> {
  const budget = await withinBudget();
  if (!budget.ok) {
    await logActivity("engineering", "cycle:skipped", budget.detail);
    return { skipped: budget.detail };
  }
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

export interface HandleOutput {
  result: string;
  outcome: "fixed" | "action_needed";
  pr_url: string | null;
}

// The owner clicked "Okay" — the responsible agent now EXECUTES the suggestion
// (opens a PR / applies a DB migration) or reports what the owner must do.
export async function runHandler(s: Suggestion): Promise<HandleOutput> {
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

  const { text, toolOutputs } = await runAgentLoop({
    agent: s.agent,
    system,
    userMessage,
    tools: handlerToolsFor(s.agent),
    maxTurns: 14,
  });
  // Capture the opened PR URL deterministically from the tool output.
  const prLine = toolOutputs.find((o) => o.startsWith("Opened PR: "));
  const prUrl = prLine ? prLine.replace("Opened PR: ", "").trim() : null;

  // Did the agent actually execute something, or does the owner need to act?
  const migrationApplied = toolOutputs.some((o) => o.includes("applied successfully"));
  const outcome: "fixed" | "action_needed" = prUrl || migrationApplied ? "fixed" : "action_needed";

  await recordResult(s.id, text, prUrl, outcome);
  await logActivity(s.agent, outcome === "fixed" ? "handled:fixed" : "handled:needs-owner", s.title.slice(0, 120));
  return { result: text, outcome, pr_url: prUrl };
}
