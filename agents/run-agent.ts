import { runAgentLoop } from "./run-loop";
import { OPUS, SONNET } from "../lib/anthropic";
import { AGENTS, AGENT_BY_ID, isTechnical, type AgentSpec } from "./registry";
import { toolsFor, handlerToolsFor } from "../tools/registry";
import { writeMemory, recentMemory, logActivity } from "../lib/memory";
import { recordResult, openSuggestionsForAgent, allOpenSuggestionsDigest } from "../lib/suggestions";
import { withinBudget } from "../lib/usage";
import { acquireAgentLock, releaseAgentLock } from "../lib/lock";
import { alertIfCredentialsBroken } from "../lib/health";
import { reviewCycleConsensus } from "../lib/consensus";
import type { AgentId, Cadence, Suggestion } from "../lib/types";

// Technical agents whose "Okay" is most likely to write a migration directly
// to the live database (no human review gate, unlike a PR) — these stay on
// Opus. Other technical agents mostly produce a PR (still Opus-authored
// code, but a human reviews and merges it before it takes effect) or a text
// deliverable (QA's manual test scripts), so Sonnet is a safe, cheaper fit.
const HIGH_STAKES_EXECUTION: ReadonlySet<AgentId> = new Set(["cybersecurity", "engineering"]);

export async function runAgent(spec: AgentSpec): Promise<string> {
  // Guards against the SAME agent's cycle running twice concurrently (a
  // double-fired cron, or a manual "Run" overlapping a scheduled cycle
  // already in flight for it) — that would double the API spend for no
  // benefit and race on writing suggestions/memory for this agent.
  const locked = await acquireAgentLock(spec.id);
  if (!locked) {
    await logActivity(spec.id, "cycle:skipped-overlap", "Already running — skipped to avoid a duplicate concurrent run.");
    return "Skipped — already running.";
  }
  try {
    // The real, accurate signal for what's still unresolved — not a fuzzy
    // memory of what the agent last happened to write. A still-open finding
    // doesn't need re-saving; that's what made every cycle look "different"
    // even when the underlying picture hadn't actually changed.
    const [open, crossAgent, recent] = await Promise.all([
      openSuggestionsForAgent(spec.id),
      allOpenSuggestionsDigest(spec.id),
      recentMemory(spec.id, 3),
    ]);
    const openList = open.length
      ? open.map((s) => `- (${s.priority}) ${s.title}`).join("\n")
      : "none — your inbox is currently clear";
    const crossList = crossAgent.length
      ? crossAgent.map((s) => `- [${s.agent}] (${s.category ?? "general"}) ${s.title}`).join("\n")
      : "none currently open";
    // Previously this was written every cycle (writeMemory below) but only
    // ever read back on the owner-facing /agents/[id] history page — never
    // fed into the agent's own next run, so nothing was actually learned
    // cycle over cycle despite the storage existing. Feeding it back in here
    // closes that loop.
    const recentList = recent.length
      ? recent.map((m) => `- (${new Date(m.cycle_at).toISOString().slice(0, 10)}) ${m.summary}`).join("\n")
      : "no prior cycle history yet";
    const userMessage = `Your own findings currently OPEN and unresolved in the owner's inbox:\n${openList}\n\nDo not save a duplicate of any of these. If the evidence still supports one, that's fine and expected — it's already pending, leave it as-is. Only save something new if it's a genuinely distinct problem, or a material update to one of the above (say so explicitly if it's an update).\n\nOther agents' currently OPEN findings (for awareness only, titles/categories — not your job to act on these, but don't duplicate one or propose something that contradicts it without good reason):\n${crossList}\n\nYour own conclusions from your last few cycles (for continuity — build on this or note what's changed since, don't just re-run the same investigation from scratch):\n${recentList}\n\nRun your review now per your standard procedure.`;

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
  } finally {
    await releaseAgentLock(spec.id);
  }
}

export async function runGroup(cadence: Cadence): Promise<Record<string, string>> {
  const budget = await withinBudget();
  if (!budget.ok) {
    await logActivity("engineering", "cycle:skipped", budget.detail);
    return { skipped: budget.detail };
  }
  // Cheap (2 HTTP calls, no LLM spend) — catch a dead GitHub/Supabase token
  // before an agent silently eats a turn on failing tool calls. Never let a
  // hiccup in the check itself block the actual cycle from running.
  await alertIfCredentialsBroken().catch(() => {});
  const due = AGENTS.filter((a) => a.cadence === cadence);
  const cycleStart = new Date().toISOString();
  await logActivity(due[0]?.id ?? "engineering", "cycle:start", `Running ${cadence} group (${due.length} agents).`);
  const results = await Promise.allSettled(due.map((a) => runAgent(a)));
  const out: Record<string, string> = {};
  due.forEach((a, i) => {
    const r = results[i];
    out[a.id] = r.status === "fulfilled" ? r.value : `Error: ${r.reason}`;
  });
  // Each agent only sees suggestions that existed BEFORE this cycle started
  // (see allOpenSuggestionsDigest) — two agents that independently land on
  // the same new finding in this same parallel batch can't catch that
  // overlap themselves. One cheap pass over just this cycle's titles does.
  await reviewCycleConsensus(due.map((a) => a.id), cycleStart).catch(() => {});
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

  // Non-technical agents have no write tools here — their "Okay" is just a
  // text deliverable, so match their suggestion-generation tier rather than
  // defaulting to the most expensive model for every execution. Technical
  // agents that DO write code/SQL stay on a strong model, reserving Opus
  // specifically for the ones most likely to apply a migration directly.
  const model = !isTechnical(s.agent)
    ? (spec.model ?? SONNET)
    : HIGH_STAKES_EXECUTION.has(s.agent)
      ? OPUS
      : SONNET;

  const { text, toolOutputs } = await runAgentLoop({
    agent: s.agent,
    system,
    userMessage,
    tools: handlerToolsFor(s.agent),
    maxTurns: 14,
    model,
    // The step that actually writes the PR/migration matters at least as
    // much as the analysis that proposed it — give it the same "think
    // carefully" setting runAgent already uses for suggestion-generation.
    effort: "high",
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
