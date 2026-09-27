import { runFreeLoop } from "./free-loop";
import { tierForAgent } from "./agent-tiers";
import { guardSummary } from "../lib/claim-guard";
import type { AgentSpec } from "./registry";
import { toolsFor, PINNED_CODE_TOOLS } from "../tools/registry";
import { resolveFootRankCommit } from "../tools/github-read";
import { writeMemory, recentMemory, logActivity } from "../lib/memory";
import { openSuggestionsForAgent, allOpenSuggestionsDigest } from "../lib/suggestions";
import { acquireAgentLock, releaseAgentLock } from "../lib/lock";
import { suggestionsSince } from "../lib/suggestions";
import { gradeAgentRun } from "../lib/evals";
import { loadFindingHistory, historyDigest, type FindingHistory } from "../lib/finding-history";
import type { AgentId, Suggestion } from "../lib/types";

// Status logging must never change the outcome of a run.
async function safeLog(agent: AgentId, action: string, detail: string): Promise<void> {
  try {
    await logActivity(agent, action, detail);
  } catch {
    // ignored
  }
}

// The outcome the cycle runner (agents/cycle.ts) uses to decide whether a
// change-detection baseline may be written: only "ok" counts as success.
export type AgentOutcome = "ok" | "stopped" | "max_turns" | "skipped-overlap" | "lock-error";
export interface AgentRunResult {
  outcome: AgentOutcome;
  text: string;
  detail?: string; // loop stop reason / lock error; never model output
}

// Runs ONE agent once. Callers outside this module must go through
// agents/cycle.ts (cycle lock, one agent at a time), never call this directly.
export async function runAgent(spec: AgentSpec): Promise<string> {
  return (await runAgentDetailed(spec)).text;
}

export async function runAgentDetailed(spec: AgentSpec): Promise<AgentRunResult> {
  // Guards against the SAME agent's cycle running twice concurrently (a
  // double-fired cron, or a manual "Run" overlapping a scheduled cycle
  // already in flight for it) — that would double the API spend for no
  // benefit and race on writing suggestions/memory for this agent.
  const lock = await acquireAgentLock(spec.id);
  if (lock.status === "held") {
    await logActivity(spec.id, "cycle:skipped-overlap", "Already running — skipped to avoid a duplicate concurrent run.");
    return { outcome: "skipped-overlap", text: "Skipped — already running." };
  }
  if (lock.status === "error") {
    // Not contention: the lock could not be checked (e.g. database down).
    // Nothing runs without a verified lock.
    await safeLog(spec.id, "cycle:lock-error", lock.detail);
    return { outcome: "lock-error", text: `⚠ Skipped — could not verify the run lock (${lock.detail}). Nothing was run.`, detail: lock.detail };
  }
  try {
    // Pin ONE FootRank commit for this whole run, resolved once from GitHub,
    // so read_repo_file and search_code can never mix source versions. Only
    // agents that read code need it; if it can't be resolved, both code tools
    // refuse (fail closed) and the rest of the run proceeds normally.
    const tools = toolsFor(spec.id);
    let codeCommit: string | undefined;
    if (tools.some((t) => PINNED_CODE_TOOLS.has(t.name))) {
      const pin = await resolveFootRankCommit();
      if (pin.ok) codeCommit = pin.sha;
      else await safeLog(spec.id, "code:pin-failed", pin.reason);
    }

    // The real, accurate signal for what's still unresolved — not a fuzzy
    // memory of what the agent last happened to write. A still-open finding
    // doesn't need re-saving; that's what made every cycle look "different"
    // even when the underlying picture hadn't actually changed.
    // Finding history (7b): open / dismissed / done / gate-rejected findings,
    // for the deterministic duplicate check. If it can't be loaded here, the
    // first submission retries and fails closed.
    const [open, crossAgent, recent, history] = await Promise.all([
      openSuggestionsForAgent(spec.id),
      allOpenSuggestionsDigest(spec.id),
      recentMemory(spec.id, 3),
      loadFindingHistory().catch((): FindingHistory | null => null),
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
    const closedList = history ? historyDigest(history) : "";
    const closedSection = closedList
      ? `\n\nFindings recently DISMISSED by the owner or REJECTED by the evidence gate (last 90 days). Do not resubmit these; a duplicate is detected automatically and not saved:\n${closedList}`
      : "";
    const userMessage = `Your own findings currently OPEN and unresolved in the owner's inbox:\n${openList}\n\nDo not save a duplicate of any of these. If the evidence still supports one, that's fine and expected — it's already pending, leave it as-is. Only save something new if it's a genuinely distinct problem, or a material update to one of the above (say so explicitly if it's an update).\n\nOther agents' currently OPEN findings (for awareness only, titles/categories — not your job to act on these, but don't duplicate one or propose something that contradicts it without good reason):\n${crossList}${closedSection}\n\nYour own conclusions from your last few cycles (for continuity — build on this or note what's changed since, don't just re-run the same investigation from scratch):\n${recentList}\n\nRun your review now per your standard procedure.`;

    const cycleStart = new Date().toISOString();
    // Free-only path: the router picks an approved free model for this
    // agent's tier (agents/agent-tiers.ts); no Anthropic call.
    const { text, toolOutputs, status, detail } = await runFreeLoop({
      agent: spec.id,
      tier: tierForAgent(spec.id),
      system: spec.system,
      userMessage,
      tools,
      // Was 12 — broad-scope agents (architecture, UX, funnel analysis) were
      // routinely hitting this cap mid-investigation and dead-ending on
      // "Reached max turns." with zero usable output, for the same spend as
      // a successful run. Paired with the wrap-up nudge in run-loop.ts.
      maxTurns: 16,
      ...(codeCommit ? { codeCommit } : {}),
      ...(history ? { findingHistory: history } : {}),
    });
    // Memory is written only for a natural conclusion ("ok"). A stopped run
    // (no free AI, deadline, failed write tool) or a maxed-out run has no
    // trustworthy conclusion, and its status text must never be replayed to
    // future cycles as "your own conclusions".
    // Figures not found in (or derivable from) this cycle's data are marked
    // [unverified] before they can be replayed. Verified summaries are stored unchanged.
    if (status === "ok") {
      const memory = guardSummary(text, { data: toolOutputs, context: [userMessage, spec.system] });
      await writeMemory(spec.id, memory.text.slice(0, 500));
    } else {
      await safeLog(spec.id, "memory:skipped", `loop ${status}${detail ? ` (${detail})` : ""}`);
    }

    // Never let a grading failure affect the cycle that triggered it —
    // same non-blocking pattern as alertIfCredentialsBroken/reviewCycleConsensus above.
    // suggestionsSince itself is guarded too: a transient fetch failure here
    // must not surface as a failed cycle when the agent's actual work (memory
    // write, any suggestions already saved) already succeeded.
    // A "stopped" run (no free AI, deadline, failed write tool) produced no
    // conclusion to grade, and grading it would be one more LLM call right
    // after the providers failed — skip it. ok / max_turns are still graded.
    if (status !== "stopped") {
      const saved = await suggestionsSince(spec.id, cycleStart).catch(() => [] as Suggestion[]);
      await gradeAgentRun(spec.id, cycleStart, text, saved, open).catch(() => {});
    }

    return { outcome: status, text, ...(detail ? { detail } : {}) };
  } finally {
    // Owner-token release: a no-op if this run's lock expired and was taken over.
    const released = await releaseAgentLock(spec.id, lock.token);
    if (!released) await safeLog(spec.id, "lock:not-released", "lock expired, taken over, or delete failed");
  }
}

// Group runs, single-agent runs and scheduled cycles live in agents/cycle.ts
// (cycle lock + one agent at a time + change detection for scheduled runs).

// The former runHandler ("Okay" executes via open_github_pr / apply_db_migration)
// was removed in the Phase 1 safety pass: it was unreachable from any route,
// and its toolset let a model run arbitrary SQL against the live database.
// "Okay" is handled exclusively by lib/qa-loop.ts (branch -> CI -> PR -> human merge).
