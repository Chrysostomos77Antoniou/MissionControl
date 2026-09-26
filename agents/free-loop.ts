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
// Provider choice, quotas and the €0 hard stop all live in lib/free-llm.ts.

import { freeLlm, type TaskTier } from "../lib/free-llm";
import { toLlmToolSpec, type LlmMessage, type LlmToolSpec } from "../lib/llm";
import { isLlmError, FREE_AI_QUOTA_EXHAUSTED } from "../lib/llm-errors";
import { dispatchTool, type DispatchContext } from "../tools/registry";
import { guardSuggestion } from "../lib/claim-guard";
import { logActivity } from "../lib/memory";
import { offeredToolNames, isToolOffered, rejectedToolMessage, SECURITY_TOOL_REJECTED } from "../lib/tool-guard";
import type { AgentId } from "../lib/types";

export interface LoopOutput {
  text: string;
  toolOutputs: string[];
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

const NUDGE_TWO_LEFT = (n: number) =>
  `[Mission Control] You have ${n} turns left before this cycle ends automatically. Stop opening new investigation threads and write your final conclusion now — synthesize what you've already found into your best answer, even if incomplete, and save any suggestion immediately rather than waiting.`;
const NUDGE_FINAL =
  "[Mission Control] This is your absolute final turn — every tool except save_suggestion has been removed. Either call save_suggestion now with your best finding from everything gathered so far, or write your closing conclusion as plain text if there's genuinely nothing new to report.";

export async function runFreeLoop(opts: {
  agent: AgentId;
  tier: TaskTier;
  system: string;
  userMessage: string;
  tools: ToolDef[];
  maxTurns?: number;
  dispatch?: (agent: AgentId, name: string, input: Record<string, unknown>, ctx?: DispatchContext) => Promise<string>;
}): Promise<LoopOutput> {
  const { agent, tier, system, userMessage, maxTurns = 8, dispatch = dispatchTool } = opts;
  const tools: LlmToolSpec[] = opts.tools.map(toToolSpec);
  const saveOnly = tools.filter((t) => t.name === "save_suggestion");
  const messages: LlmMessage[] = [{ role: "user", content: userMessage }];
  const toolOutputs: string[] = [];
  let lastText = "";

  for (let turn = 0; turn < maxTurns; turn++) {
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
      if (msg.startsWith(FREE_AI_QUOTA_EXHAUSTED)) {
        try {
          await logActivity(agent, "free-ai:stopped", msg.slice(0, 280));
        } catch {
          // logging must never mask the real outcome
        }
      }
      return { text: `⚠ Agent error: free AI unavailable — ${msg.slice(0, 240)}`, toolOutputs };
    }
    lastText = res.text || lastText;

    if (res.toolCalls.length === 0) return { text: res.text, toolOutputs };
    messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });

    const offered = offeredToolNames(turnTools);
    const results: Extract<LlmMessage, { role: "tool" }>[] = [];
    for (const call of res.toolCalls) {
      if (!isToolOffered(call.name, offered)) {
        await logActivity(agent, SECURITY_TOOL_REJECTED, `${String(call.name).slice(0, 80)} ${JSON.stringify(call.input ?? {}).slice(0, 200)}`);
        results.push({ role: "tool", toolCallId: call.id, name: call.name, content: rejectedToolMessage(String(call.name)), isError: true });
        continue;
      }
      await logActivity(agent, `tool:${call.name}`, JSON.stringify(call.input).slice(0, 300));
      let input = call.input;
      let ctx: DispatchContext | undefined;
      if (call.name === "save_suggestion") {
        // Deterministic claim guard: every figure must appear in (or, for
        // ratios, be derivable from) this cycle's data. Unverified ones are
        // marked, footnoted, and suppress the immediate alert. Provenance is
        // the provider/model that actually produced this turn.
        const g = guardSuggestion(
          { title: String(input.title ?? ""), body: String(input.body ?? ""), evidence: String(input.evidence ?? "") },
          { data: toolOutputs, context: [userMessage, system] },
          `${res.provider}/${res.model}`,
        );
        input = { ...input, title: g.title, body: g.body, ...(input.evidence !== undefined ? { evidence: g.evidence } : {}) };
        ctx = { notify: g.unverified.length === 0, appendix: g.footer };
        if (g.unverified.length) {
          try {
            await logActivity(agent, "claims:unverified", g.unverified.join(", ").slice(0, 200));
          } catch {
            // never let logging block the save
          }
        }
      }
      // Only save_suggestion gets a guard context; other tools keep the plain call.
      const out = ctx ? await dispatch(agent, call.name, input, ctx) : await dispatch(agent, call.name, input);
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
  return { text: lastText || "Reached max turns.", toolOutputs };
}
