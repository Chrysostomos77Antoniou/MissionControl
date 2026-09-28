// Provider-neutral agent loop on the free-only router (Phase 2, commit 5).
//
// Replaces the Anthropic-SDK loop (agents/run-loop.ts, left untouched as
// legacy) for every migrated caller. Same contract and the same Phase 1 rules:
//   - the model may only run tools OFFERED on that turn (lib/tool-guard.ts);
//     anything else is refused, logged as security:tool-rejected, and
//     reported back as an error result — never dispatched;
//   - on the final turn only save_suggestion is offered (when present);
//   - the 2-turns-left / final-turn wrap-up nudges are kept;
//   - tools are dispatched by the caller's dispatcher only (no registry
//     lookup here), so no new authority is added.
// Bounded execution (Commit 6a): the loop never starts a turn after its
// wall-clock deadline, executes at most MAX_TOOL_CALLS_PER_TURN calls per
// turn, times out read-only tools, turns thrown tool errors into explicit
// error results (never retried), and reports an explicit status so callers
// only treat a natural conclusion ("ok") as a successful cycle.
// Finding gate (7b): when save_suggestion is offered, every successful
// read-only tool result is recorded in a run-bound evidence ledger and gets
// an evidence ref; save_suggestion findings are checked against that ledger
// (lib/finding-gate.ts) and against duplicates before anything is saved.
// Source follow-through (opt-in, Engineering): when the model tries to conclude,
// the loop derives the run's real investigation scope from the evidence ledger
// (lib/investigation-scope.ts). If its own specific searches pointed at code it
// never read, or its conclusion claims a wider scope than the tool history
// supports, it gets a bounded, deterministic follow-up (at most
// MAX_FOLLOW_UPS, only with >= FOLLOW_UP_MIN_TURNS_LEFT turns left, no extra
// turns). It never requires, creates or rewrites a finding.
// Provider choice, quotas and the €0 hard stop all live in lib/free-llm.ts.

import { freeLlm, type TaskTier } from "../lib/free-llm";
import { toLlmToolSpec, type LlmMessage, type LlmToolSpec } from "../lib/llm";
import { isLlmError, FREE_AI_QUOTA_EXHAUSTED } from "../lib/llm-errors";
import { dispatchTool, PINNED_CODE_TOOLS, type DispatchContext } from "../tools/registry";
import { guardSuggestion, checkClaims, markInline, type ClaimMaterial } from "../lib/claim-guard";
import { normalizeCategory } from "../lib/suggestion-category";
import { redactText } from "../lib/redact";
import { logActivity } from "../lib/memory";
import { offeredToolNames, isToolOffered, rejectedToolMessage, SECURITY_TOOL_REJECTED } from "../lib/tool-guard";
import { EVIDENCE_TOOLS, evidenceRefNote } from "../lib/evidence-ledger";
import { renderFindingProse } from "../lib/finding-gate";
import { createFindingRun, type FindingRun } from "../lib/finding-submit";
import type { FindingHistory } from "../lib/finding-history";
import { buildScope, detectOverclaim, followUpMessage, type InvestigationScope } from "../lib/investigation-scope";
import type { AgentId } from "../lib/types";

// ok        — the model concluded on its own (a turn with no tool calls).
// stopped   — the run could not finish: no free AI, wall-clock deadline hit,
//             or a write tool (e.g. save_suggestion) threw.
// max_turns — the turn cap was reached while the model was still calling tools.
export type LoopStatus = "ok" | "stopped" | "max_turns";

export interface LoopOutput {
  text: string;
  toolOutputs: string[];
  status: LoopStatus;
  detail?: string; // why the loop stopped (never model output)
  // Only with sourceFollowThrough: the run's deterministic investigation scope
  // (from tool history, never from the model's wording) and follow-ups used.
  scope?: InvestigationScope;
  followUps?: number;
}

// The shape tools are already defined in (tools/registry.ts, agents/fix-agent.ts).
export interface ToolDef {
  name: string;
  description?: string;
  input_schema: { type: string; properties?: unknown; required?: string[] | null };
}

export function toToolSpec(t: ToolDef): LlmToolSpec {
  return toLlmToolSpec({ ...t, input_schema: { ...t.input_schema, required: t.input_schema.required ?? undefined } });
}

// Per-turn output budget. Big enough for a tool call or a full suggestion,
// small enough to leave room for context on the local model.
export const TURN_MAX_OUTPUT_TOKENS = 4096;

// ---- Execution bounds (explicit and conservative) ----
// Hard upper bound on turns; callers may ask for fewer, never more.
export const MAX_TURNS_CAP = 16;
// No NEW turn starts after this much wall-clock time. A turn already in
// flight finishes (router call + its tool calls), then the loop stops.
export const LOOP_DEADLINE_MS = 20 * 60 * 1000;
// Worst case for ONE router call: the router tries at most 4 models, and the
// slowest plans are ollama (180 s timeout) + 2 x gemini (60 s) + groq (30 s).
// This is a bound used for lock TTLs, not a deadline: LOOP_DEADLINE_MS is
// unchanged.
export const MAX_ROUTER_CALL_MS = 330 * 1000;
// Tool calls beyond this in a single turn are refused (not executed).
export const MAX_TOOL_CALLS_PER_TURN = 5;
// Read-only tools that take longer than this return a timeout error result.
export const TOOL_TIMEOUT_MS = 60 * 1000;
// Upper bound on one loop: last turn may start just before the deadline.
export const MAX_LOOP_MS = LOOP_DEADLINE_MS + MAX_ROUTER_CALL_MS + MAX_TOOL_CALLS_PER_TURN * TOOL_TIMEOUT_MS;

// Source follow-through bounds.
export const MAX_FOLLOW_UPS = 2;
export const FOLLOW_UP_MIN_TURNS_LEFT = 3;

// Side-effect-free tools. Only these are timed out (a timed-out write could
// still complete later) and only these continue the loop after throwing.
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["web_search", "read_footrank_stats", "db_read", "list_repo", "read_repo_file", "search_code"]);

const NUDGE_TWO_LEFT = (n: number) =>
  `[Mission Control] You have ${n} turns left before this cycle ends automatically. Stop opening new investigation threads and write your final conclusion now — synthesize what you've already found into your best answer, even if incomplete, and save any suggestion immediately rather than waiting.`;
const NUDGE_FINAL =
  "[Mission Control] This is your absolute final turn — every tool except save_suggestion has been removed. Either call save_suggestion now with your best finding from everything gathered so far, or write your closing conclusion as plain text if there's genuinely nothing new to report.";

const errText = (e: unknown) => redactText(e instanceof Error ? e.message : String(e)).slice(0, 200);

async function safeLog(agent: AgentId, action: string, detail: string): Promise<void> {
  try {
    await logActivity(agent, action, detail);
  } catch {
    // logging must never mask the real outcome
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// The activity-log line for a save_suggestion call, built from the GUARDED
// input. Re-checked after truncation so a cut can never leave an unsupported
// figure without its [unverified] mark.
function guardedLogDetail(input: Record<string, unknown>, material: ClaimMaterial): string {
  const cut = JSON.stringify(input).slice(0, 300);
  return markInline(cut, checkClaims(cut, material).unverified);
}

export async function runFreeLoop(opts: {
  agent: AgentId;
  tier: TaskTier;
  system: string;
  userMessage: string;
  tools: ToolDef[];
  maxTurns?: number;
  dispatch?: (agent: AgentId, name: string, input: Record<string, unknown>, ctx?: DispatchContext) => Promise<string>;
  deadlineMs?: number; // defaults to LOOP_DEADLINE_MS; can only be shortened
  now?: () => number; // injectable clock (tests)
  // The run's pinned FootRank commit (agents/run-agent.ts). Handed ONLY to the
  // code-reading tools, as loop-supplied context the model cannot set.
  codeCommit?: string;
  // Existing/dismissed/rejected findings for duplicate detection (7b). When
  // absent, the first submission loads it (fail-closed).
  findingHistory?: FindingHistory | null;
  // Opt-in (agents/run-agent.ts enables it for Engineering): check a
  // conclusion against the run's recorded investigation scope first.
  sourceFollowThrough?: boolean;
}): Promise<LoopOutput> {
  const { agent, tier, system, userMessage, dispatch = dispatchTool } = opts;
  const maxTurns = Math.max(1, Math.min(opts.maxTurns ?? 8, MAX_TURNS_CAP));
  const now = opts.now ?? Date.now;
  const deadlineAt = now() + Math.min(opts.deadlineMs ?? LOOP_DEADLINE_MS, LOOP_DEADLINE_MS);
  const tools: LlmToolSpec[] = opts.tools.map(toToolSpec);
  const saveOnly = tools.filter((t) => t.name === "save_suggestion");
  // One evidence ledger per investigation run (only when findings can be saved).
  const findingRun: FindingRun | undefined = saveOnly.length ? createFindingRun({ commit: opts.codeCommit, history: opts.findingHistory ?? null }) : undefined;
  const messages: LlmMessage[] = [{ role: "user", content: userMessage }];
  const toolOutputs: string[] = [];
  let lastText = "";
  // Discovery counters (list_repo is not in the ledger) and follow-up budget.
  const counters = { listRepoCalls: 0, searchCalls: 0 };
  let followUps = 0;
  let leadsFollowUpUsed = false;
  const follow = opts.sourceFollowThrough === true;
  const currentScope = () => buildScope(findingRun ? findingRun.ledger.all() : [], counters);
  // Adds the scope to every result, only when follow-through is on (so the
  // output of every other caller is exactly as before).
  const done = (o: LoopOutput): LoopOutput => (follow ? { ...o, scope: currentScope(), followUps } : o);

  for (let turn = 0; turn < maxTurns; turn++) {
    if (now() >= deadlineAt) {
      await safeLog(agent, "loop:deadline", `stopped before turn ${turn + 1}/${maxTurns}`);
      return done({ text: "⚠ Agent stopped: time limit reached before the run finished.", toolOutputs, status: "stopped", detail: "deadline" });
    }
    const isFinalTurn = turn === maxTurns - 1;
    const turnTools = isFinalTurn && saveOnly.length ? saveOnly : tools;

    let res;
    try {
      res = await freeLlm.generate(tier, {
        system,
        messages,
        ...(turnTools.length ? { tools: turnTools } : {}),
        maxOutputTokens: TURN_MAX_OUTPUT_TOKENS,
      });
    } catch (e) {
      // Degrade gracefully: the router already refused every paid path.
      const msg = isLlmError(e) ? e.message : e instanceof Error ? e.message : String(e);
      if (msg.startsWith(FREE_AI_QUOTA_EXHAUSTED)) await safeLog(agent, "free-ai:stopped", msg.slice(0, 280));
      return done({ text: `⚠ Agent error: free AI unavailable — ${msg.slice(0, 240)}`, toolOutputs, status: "stopped", detail: "free-ai-unavailable" });
    }
    lastText = res.text || lastText;

    if (res.toolCalls.length === 0) {
      // Source follow-through: before accepting a conclusion, compare it with
      // the recorded scope. Unread leads get ONE follow-up (the chance to read
      // them or say they were not inspected); an unsupported scope claim can
      // use the rest of the budget. Never on the last turns, never extra turns.
      const turnsLeftAfter = maxTurns - turn - 1;
      if (follow && followUps < MAX_FOLLOW_UPS && turnsLeftAfter >= FOLLOW_UP_MIN_TURNS_LEFT) {
        const scope = currentScope();
        const leads = !leadsFollowUpUsed && scope.unreadLeads.length > 0;
        const overclaim = detectOverclaim(res.text, scope);
        if (leads || overclaim) {
          followUps++;
          if (leads) leadsFollowUpUsed = true;
          await safeLog(agent, "loop:follow-through", `follow-up ${followUps}/${MAX_FOLLOW_UPS}: level ${scope.level}, unread leads ${scope.unreadLeads.length}${overclaim ? `, overclaim ${overclaim.kind}` : ""}`);
          messages.push({ role: "assistant", content: res.text });
          messages.push({ role: "user", content: followUpMessage(scope, leads, overclaim) });
          continue;
        }
      }
      return done({ text: res.text, toolOutputs, status: "ok" });
    }
    messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });

    const offered = offeredToolNames(turnTools);
    const material: ClaimMaterial = { data: toolOutputs, context: [userMessage, system] };
    const results: Extract<LlmMessage, { role: "tool" }>[] = [];
    for (const [i, call] of res.toolCalls.entries()) {
      if (i >= MAX_TOOL_CALLS_PER_TURN) {
        if (i === MAX_TOOL_CALLS_PER_TURN) await safeLog(agent, "loop:tool-cap", `${res.toolCalls.length} calls in one turn; only ${MAX_TOOL_CALLS_PER_TURN} executed`);
        results.push({ role: "tool", toolCallId: call.id, name: call.name, content: `Not executed: at most ${MAX_TOOL_CALLS_PER_TURN} tool calls are run per turn. Call it again next turn if it is still needed.`, isError: true });
        continue;
      }
      if (!isToolOffered(call.name, offered)) {
        // A refused save_suggestion is logged without its (unguarded) content.
        const shown = call.name === "save_suggestion" ? `keys=${Object.keys(call.input ?? {}).join(",")}` : JSON.stringify(call.input ?? {});
        await logActivity(agent, SECURITY_TOOL_REJECTED, `${String(call.name).slice(0, 80)} ${shown.slice(0, 200)}`);
        results.push({ role: "tool", toolCallId: call.id, name: call.name, content: rejectedToolMessage(String(call.name)), isError: true });
        continue;
      }
      let input = call.input;
      let ctx: DispatchContext | undefined;
      if (call.name === "save_suggestion") {
        // Deterministic claim guard over the finding's prose (title, claim,
        // scenario, impact, disproof, proposed change): every figure must
        // appear in (or, for ratios, be derivable from) this cycle's data.
        // Unverified ones are marked and footnoted; only a fully verified
        // finding may alert. Provenance is the provider/model of this turn.
        // Evidence is NOT taken from the model's text: the gate renders it
        // from the run's evidence ledger.
        const prose = renderFindingProse(input);
        const g = guardSuggestion({ title: prose.title, body: prose.body, evidence: "" }, material, `${res.provider}/${res.model}`);
        if (input.category !== undefined) {
          const rawCategoryLength = String(input.category ?? "").length;
          const cat = normalizeCategory(input.category);
          input = { ...input, category: cat.category };
          if (!cat.valid) await safeLog(agent, "category:invalid", `replaced with "${cat.category}" (original was ${rawCategoryLength} chars; not logged)`);
        }
        ctx = { guardPassed: g.unverified.length === 0, appendix: g.footer, ...(findingRun ? { finding: { run: findingRun, title: g.title, body: g.body } } : {}) };
        if (g.unverified.length) await safeLog(agent, "claims:unverified", g.unverified.join(", ").slice(0, 200));
        // Logged only AFTER the guard: the stored line carries the marks.
        await logActivity(agent, `tool:${call.name}`, guardedLogDetail({ class: input.class, priority: input.priority, title: g.title, body: g.body }, material));
      } else {
        await logActivity(agent, `tool:${call.name}`, JSON.stringify(input).slice(0, 300));
        if (opts.codeCommit && PINNED_CODE_TOOLS.has(call.name)) ctx = { codeCommit: opts.codeCommit };
        if (call.name === "list_repo") counters.listRepoCalls++;
        if (call.name === "search_code") counters.searchCalls++;
      }

      let out: string;
      try {
        // Only save_suggestion gets a guard context; other tools keep the plain call.
        const pending = ctx ? dispatch(agent, call.name, input, ctx) : dispatch(agent, call.name, input);
        out = READ_ONLY_TOOLS.has(call.name) ? await withTimeout(pending, TOOL_TIMEOUT_MS, call.name) : await pending;
      } catch (e) {
        const why = errText(e);
        await safeLog(agent, "tool:error", `${call.name}: ${why}`);
        if (!READ_ONLY_TOOLS.has(call.name)) {
          // A write tool failed part-way; its effect is unknown. Stop instead
          // of letting the model retry it or report it as done.
          return done({ text: `⚠ Agent stopped: ${call.name} failed (${why}).`, toolOutputs, status: "stopped", detail: `tool-error:${call.name}` });
        }
        // Read-only: report the failure to the model as missing data. It is
        // not added to toolOutputs, so it can never support a claim.
        results.push({ role: "tool", toolCallId: call.id, name: call.name, content: `Tool error: ${call.name} failed (${why}). It was not retried. Treat this data as unavailable.`, isError: true });
        continue;
      }
      if (call.name === "save_suggestion") {
        // The gate's reply is Mission Control's own text, not data: it is
        // shown to the model but never becomes claim-guard material.
        results.push({ role: "tool", toolCallId: call.id, name: call.name, content: out });
        continue;
      }
      if (findingRun && EVIDENCE_TOOLS.has(call.name)) {
        const ref = findingRun.ledger.record(call.name, input, out);
        if (ref) out = `${out}\n\n${evidenceRefNote(ref)}`;
      }
      toolOutputs.push(out);
      results.push({ role: "tool", toolCallId: call.id, name: call.name, content: out });
    }

    // Wrap-up nudges ride on the last tool result so every provider accepts
    // the turn order (tool results must directly follow the tool calls).
    const turnsLeft = maxTurns - turn - 1;
    const nudge = turnsLeft === 2 ? NUDGE_TWO_LEFT(turnsLeft) : turnsLeft === 1 ? NUDGE_FINAL : null;
    if (nudge && results.length) {
      const last = results[results.length - 1];
      results[results.length - 1] = { ...last, content: `${last.content}\n\n${nudge}` };
    }
    messages.push(...results);
  }
  return done({ text: lastText || "Reached max turns.", toolOutputs, status: "max_turns" });
}
