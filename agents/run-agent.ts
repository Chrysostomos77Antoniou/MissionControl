import { runFreeLoop } from "./free-loop";
import { tierForAgent } from "./agent-tiers";
import { guardSummary } from "../lib/claim-guard";
import { AGENTS, AGENT_BY_ID, type AgentSpec } from "./registry";
import { toolsFor } from "../tools/registry";
import { writeMemory, recentMemory, logActivity } from "../lib/memory";
import { openSuggestionsForAgent, allOpenSuggestionsDigest } from "../lib/suggestions";
import { withinBudget } from "../lib/usage";
import { acquireAgentLock, releaseAgentLock } from "../lib/lock";
import { alertIfCredentialsBroken } from "../lib/health";
import { reviewCycleConsensus } from "../lib/consensus";
import { suggestionsSince } from "../lib/suggestions";
import { gradeAgentRun } from "../lib/evals";
import type { AgentId, Cadence, Suggestion } from "../lib/types";

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

    const cycleStart = new Date().toISOString();
    // Free-only path: the router picks an approved free model for this
    // agent's tier (agents/agent-tiers.ts); no Anthropic call.
    const { text, toolOutputs } = await runFreeLoop({
      agent: spec.id,
      tier: tierForAgent(spec.id),
      system: spec.system,
      userMessage,
      tools: toolsFor(spec.id),
      // Was 12 — broad-scope agents (architecture, UX, funnel analysis) were
      // routinely hitting this cap mid-investigation and dead-ending on
      // "Reached max turns." with zero usable output, for the same spend as
      // a successful run. Paired with the wrap-up nudge in run-loop.ts.
      maxTurns: 16,
    });
    // Figures not found in (or derivable from) this cycle's data are marked
    // [unverified] before they can be replayed to future cycles as "your own
    // conclusions". Verified summaries are stored unchanged.
    const memory = guardSummary(text, { data: toolOutputs, context: [userMessage, spec.system] });
    await writeMemory(spec.id, memory.text.slice(0, 500));

    // Never let a grading failure affect the cycle that triggered it —
    // same non-blocking pattern as alertIfCredentialsBroken/reviewCycleConsensus above.
    // suggestionsSince itself is guarded too: a transient fetch failure here
    // must not surface as a failed cycle when the agent's actual work (memory
    // write, any suggestions already saved) already succeeded.
    const saved = await suggestionsSince(spec.id, cycleStart).catch(() => [] as Suggestion[]);
    await gradeAgentRun(spec.id, cycleStart, text, saved, open).catch(() => {});

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

// The former runHandler ("Okay" executes via open_github_pr / apply_db_migration)
// was removed in the Phase 1 safety pass: it was unreachable from any route,
// and its toolset let a model run arbitrary SQL against the live database.
// "Okay" is handled exclusively by lib/qa-loop.ts (branch -> CI -> PR -> human merge).
