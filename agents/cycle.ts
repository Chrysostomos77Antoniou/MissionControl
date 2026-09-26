// Unattended cycles + manual runs (Commit 6b).
//
// Every agent run in Mission Control goes through here:
//   cycle lock (__cycle__) -> preflight -> due agents -> [scheduled only:
//   deterministic change detection] -> ONE agent at a time via
//   runAgentDetailed (agent lock, free loop, claim guard, guarded memory)
//   -> [scheduled only: baseline written only after an "ok" run].
//
// This module only orchestrates. It never saves suggestions, writes memory,
// calls a model, or touches the fix/QA/merge path — those stay behind
// runAgentDetailed / runFreeLoop / the human "Okay" flow.

import { AGENTS, AGENT_BY_ID } from "./registry";
import { runAgentDetailed, type AgentRunResult } from "./run-agent";
import { tierForAgent } from "./agent-tiers";
import type { TaskTier } from "../lib/free-llm";
import { acquireCycleLock, releaseCycleLock, AGENT_LOCK_TTL_MS, CYCLE_LOCK_TTL_MS, type LockResult } from "../lib/lock";
import {
  detect,
  shouldRun,
  sourcesFor,
  fingerprintSuggestions,
  makeBaseline,
  parseBaseline,
  serializeBaseline,
  BASELINE_ACTION,
  type Baseline,
  type Detection,
  type FootrankTotals,
  type OpenSuggestionState,
} from "../lib/change-detect";
import { readFootrankTotals } from "../tools/supabase-read";
import { supabaseAdmin } from "../lib/supabase";
import { logActivity } from "../lib/memory";
import { withinBudget } from "../lib/usage";
import { alertIfCredentialsBroken } from "../lib/health";
import { reviewCycleConsensus } from "../lib/consensus";
import { redactText } from "../lib/redact";
import type { AgentId, Cadence } from "../lib/types";

export type ScheduledGroup = Exclude<Cadence, "ondemand">;
export const SCHEDULED_GROUPS: readonly ScheduledGroup[] = ["hourly", "4h", "daily", "5day"];

// No agent starts after this much cycle time: every started agent then
// finishes (<= AGENT_LOCK_TTL_MS) before the cycle lock could expire.
export const CYCLE_START_WINDOW_MS = CYCLE_LOCK_TTL_MS - AGENT_LOCK_TTL_MS;

export type AgentCycleOutcome =
  | "ran-ok"
  | "ran-stopped"
  | "ran-max-turns"
  | "skipped-no-change"
  | "skipped-detect-failed"
  | "skipped-exhausted"
  | "skipped-time"
  | "skipped-agent-busy"
  | "agent-lock-error"
  | "error";

export interface AgentCycleEntry {
  agent: AgentId;
  outcome: AgentCycleOutcome;
  reason?: string; // deterministic: detection kind / stop reason / error class
  text?: string; // manual runs only: the agent's reply for the owner
}

export interface CycleResult {
  status: "completed" | "skipped-overlap" | "lock-error" | "skipped-budget";
  mode: "scheduled" | "manual";
  group?: string;
  agents: AgentCycleEntry[];
  detail?: string;
}

export interface CycleDeps {
  acquireCycleLock: () => Promise<LockResult>;
  releaseCycleLock: (token: string) => Promise<boolean>;
  runAgent: (agent: AgentId) => Promise<AgentRunResult>;
  tierFor: (agent: AgentId) => TaskTier;
  readTotals: () => Promise<FootrankTotals | null>; // null = could not read
  readOpenSuggestions: (agent: AgentId) => Promise<OpenSuggestionState[] | null>; // null = could not read
  readBaseline: (agent: AgentId) => Promise<{ ok: true; baseline: Baseline | null } | { ok: false; detail: string }>;
  writeBaseline: (agent: AgentId, b: Baseline) => Promise<boolean>;
  preflight: () => Promise<{ ok: boolean; detail: string }>;
  consensus: (agents: AgentId[], sinceIso: string) => Promise<void>;
  log: (agent: AgentId, action: string, detail: string) => Promise<void>;
  now: () => Date;
}

const errText = (e: unknown) => redactText(e instanceof Error ? e.message : String(e)).slice(0, 200);

// ---- default (real) dependencies ----

// Same rows as lib/suggestions.ts openSuggestionsForAgent (the agent's
// prompt input), but a read error is reported instead of becoming [].
async function readOpenSuggestionsStrict(agent: AgentId): Promise<OpenSuggestionState[] | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from("suggestions")
      .select("id, status, priority, title")
      .eq("agent", agent)
      .eq("status", "new")
      .order("created_at", { ascending: false })
      .limit(15);
    if (error || !Array.isArray(data)) return null;
    return data as OpenSuggestionState[];
  } catch {
    return null;
  }
}

async function readBaselineRow(agent: AgentId): Promise<{ ok: true; baseline: Baseline | null } | { ok: false; detail: string }> {
  try {
    const { data, error } = await supabaseAdmin
      .from("activity_log")
      .select("detail, created_at")
      .eq("agent", agent)
      .eq("action", BASELINE_ACTION)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) return { ok: false, detail: errText(error.message) };
    const row = Array.isArray(data) ? data[0] : undefined;
    return { ok: true, baseline: row ? parseBaseline(agent, (row as { detail?: unknown }).detail) : null };
  } catch (e) {
    return { ok: false, detail: errText(e) };
  }
}

async function writeBaselineRow(agent: AgentId, b: Baseline): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin.from("activity_log").insert({ agent, action: BASELINE_ACTION, detail: serializeBaseline(b) });
    return !error;
  } catch {
    return false;
  }
}

async function safeLog(agent: AgentId, action: string, detail: string): Promise<void> {
  try {
    await logActivity(agent, action, detail);
  } catch {
    // logging never changes a cycle's outcome
  }
}

export const defaultCycleDeps: CycleDeps = {
  acquireCycleLock: () => acquireCycleLock(),
  releaseCycleLock,
  runAgent: (agent) => runAgentDetailed(AGENT_BY_ID[agent]),
  tierFor: tierForAgent,
  readTotals: async () => {
    try {
      return await readFootrankTotals();
    } catch {
      return null;
    }
  },
  readOpenSuggestions: readOpenSuggestionsStrict,
  readBaseline: readBaselineRow,
  writeBaseline: writeBaselineRow,
  preflight: async () => {
    const budget = await withinBudget();
    if (!budget.ok) return budget;
    // Cheap (2 HTTP calls, no LLM) and never blocks the cycle.
    await alertIfCredentialsBroken().catch(() => {});
    return { ok: true, detail: "" };
  },
  consensus: (agents, since) => reviewCycleConsensus(agents, since).catch(() => {}),
  log: safeLog,
  now: () => new Date(),
};

// ---- detection ----

async function detectFor(agent: AgentId, d: CycleDeps): Promise<Detection> {
  const needs = sourcesFor(agent);
  const baseline = await d.readBaseline(agent);
  const totals = needs.includes("footrank_totals") ? await d.readTotals() : undefined;
  const openSuggestions = await d.readOpenSuggestions(agent);
  return detect(agent, { totals, openSuggestions }, baseline, d.now().getTime());
}

const reasonOf = (det: Detection) =>
  det.kind === "changed" ? `changed:${det.changed.join("+")}` : det.kind === "error" ? `error:${det.detail}` : det.kind;

// Baseline after an "ok" run: totals as the agent saw them (pre-run), open
// suggestions re-read AFTER the run so the agent's own new suggestions do not
// count as a change next cycle. Anything unreadable => no baseline (the agent
// simply stays eligible), never a guessed one.
async function writeBaselineAfterSuccess(agent: AgentId, pre: Detection, startedAt: Date, d: CycleDeps): Promise<void> {
  if (pre.kind === "error") return;
  const post = await d.readOpenSuggestions(agent);
  let openHash: string;
  try {
    if (!post) throw new Error("unreadable");
    openHash = fingerprintSuggestions(post);
  } catch {
    await d.log(agent, "cycle:baseline-skipped", "open suggestions unreadable after the run; baseline unchanged");
    return;
  }
  const ok = await d.writeBaseline(agent, makeBaseline(agent, { ...pre.sources, open_suggestions: openHash }, startedAt));
  if (!ok) await d.log(agent, "cycle:baseline-write-failed", "baseline unchanged; the agent stays eligible");
}

// ---- the runner ----

interface RunPlan {
  mode: "scheduled" | "manual";
  group?: string;
  agents: AgentId[];
}

async function execute(plan: RunPlan, d: CycleDeps): Promise<CycleResult> {
  const logAgent: AgentId = plan.agents[0] ?? "devops";
  const base = { mode: plan.mode, ...(plan.group ? { group: plan.group } : {}) };

  const lock = await d.acquireCycleLock();
  if (lock.status === "held") {
    await d.log(logAgent, "cycle:skipped-overlap", `${plan.mode}${plan.group ? ` ${plan.group}` : ""}: another run is in progress; not queued`);
    return { status: "skipped-overlap", ...base, agents: [] };
  }
  if (lock.status === "error") {
    await d.log(logAgent, "cycle:lock-error", lock.detail);
    return { status: "lock-error", ...base, agents: [], detail: lock.detail };
  }

  const entries: AgentCycleEntry[] = [];
  try {
    const pre = await d.preflight();
    if (!pre.ok) {
      await d.log(logAgent, "cycle:skipped-budget", pre.detail);
      return { status: "skipped-budget", ...base, agents: [], detail: pre.detail };
    }

    const startedAt = d.now();
    await d.log(logAgent, "cycle:started", `${plan.mode}${plan.group ? ` ${plan.group}` : ""}: ${plan.agents.length} agent(s), one at a time`);
    const exhausted = new Set<TaskTier>();
    const ran: AgentId[] = [];

    // Strictly sequential: one agent (and so at most one local model load) at a time.
    for (const agent of plan.agents) {
      if (d.now().getTime() - startedAt.getTime() > CYCLE_START_WINDOW_MS) {
        entries.push({ agent, outcome: "skipped-time", reason: "cycle time window used up" });
        continue;
      }
      const tier = d.tierFor(agent);
      if (exhausted.has(tier)) {
        await d.log(agent, "cycle:agent-skipped-exhausted", `free AI for the ${tier} tier is unavailable this cycle`);
        entries.push({ agent, outcome: "skipped-exhausted", reason: tier });
        continue;
      }

      let detection: Detection | null = null;
      const agentStart = d.now();
      if (plan.mode === "scheduled") {
        detection = await detectFor(agent, d);
        if (detection.kind === "error") {
          await d.log(agent, "cycle:detect-failed", detection.detail.slice(0, 200));
          entries.push({ agent, outcome: "skipped-detect-failed", reason: reasonOf(detection) });
          continue;
        }
        if (!shouldRun(detection)) {
          await d.log(agent, "cycle:agent-skipped-no-change", "inputs unchanged and baseline younger than 7 days");
          entries.push({ agent, outcome: "skipped-no-change", reason: "unchanged" });
          continue;
        }
        if (detection.kind === "missing") await d.log(agent, "cycle:baseline-missing", "no baseline yet: running");
      }

      let res: AgentRunResult;
      try {
        res = await d.runAgent(agent);
      } catch (e) {
        entries.push({ agent, outcome: "error", reason: errText(e) });
        ran.push(agent);
        continue; // one agent's failure never stops the others
      }
      const text = plan.mode === "manual" ? { text: res.text } : {};
      const why = detection ? reasonOf(detection) : "manual";
      switch (res.outcome) {
        case "ok":
          ran.push(agent);
          if (detection) await writeBaselineAfterSuccess(agent, detection, agentStart, d);
          entries.push({ agent, outcome: "ran-ok", reason: why, ...text });
          break;
        case "max_turns":
          ran.push(agent);
          entries.push({ agent, outcome: "ran-max-turns", reason: why, ...text });
          break;
        case "stopped":
          ran.push(agent);
          // Free AI unavailable for this tier: do not start more agents on it.
          if (res.detail === "free-ai-unavailable") exhausted.add(tier);
          entries.push({ agent, outcome: "ran-stopped", reason: res.detail ?? "stopped", ...text });
          break;
        case "skipped-overlap":
          entries.push({ agent, outcome: "skipped-agent-busy", ...text });
          break;
        case "lock-error":
          entries.push({ agent, outcome: "agent-lock-error", reason: res.detail, ...text });
          break;
      }
    }

    if (ran.length) await d.consensus(ran, startedAt.toISOString());
    const count = (o: AgentCycleOutcome) => entries.filter((e) => e.outcome === o).length;
    await d.log(
      logAgent,
      "cycle:completed",
      `${plan.mode}${plan.group ? ` ${plan.group}` : ""}: ok ${count("ran-ok")}, unchanged ${count("skipped-no-change")}, failed ${entries.length - count("ran-ok") - count("skipped-no-change")}`,
    );
    return { status: "completed", ...base, agents: entries };
  } finally {
    const released = await d.releaseCycleLock(lock.token);
    if (!released) await d.log(logAgent, "cycle:lock-not-released", "cycle lock expired, taken over, or delete failed");
  }
}

// Scheduled (unattended) cycle for one cadence group, with change detection.
export async function runScheduledCycle(group: ScheduledGroup, d: CycleDeps = defaultCycleDeps): Promise<CycleResult> {
  const agents = AGENTS.filter((a) => a.cadence === group).map((a) => a.id);
  return execute({ mode: "scheduled", group, agents }, d);
}

// Explicit human request (dashboard button, chat, targeted endpoint call):
// bypasses change detection ONLY. Same cycle lock, one agent at a time,
// same agent lock / free loop / claim guard. Never writes baselines.
export async function runManual(ids: readonly AgentId[], d: CycleDeps = defaultCycleDeps): Promise<CycleResult> {
  const agents = [...new Set(ids)].filter((id) => id in AGENT_BY_ID);
  return execute({ mode: "manual", agents }, d);
}

export async function runOne(id: AgentId, d: CycleDeps = defaultCycleDeps): Promise<string> {
  const r = await runManual([id], d);
  if (r.status === "skipped-overlap") return "Skipped — another agent run is in progress. Try again when it finishes.";
  if (r.status !== "completed") return `⚠ Not run (${r.status}${r.detail ? `: ${r.detail}` : ""}).`;
  const e = r.agents[0];
  return e?.text ?? `Not run (${e?.outcome ?? "unknown"}).`;
}

// Manual group run (chat "run the daily group" / "run everyone").
export async function runGroup(scope: Cadence | "all", d: CycleDeps = defaultCycleDeps): Promise<CycleResult> {
  const agents = AGENTS.filter((a) => (scope === "all" ? a.cadence !== "ondemand" : a.cadence === scope)).map((a) => a.id);
  return runManual(agents, d);
}
