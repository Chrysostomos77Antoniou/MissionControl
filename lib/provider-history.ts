// Provider-switch-safe conversation history for the free-only router.
//
// Tool-call history is provider-specific: Gemini 3 requires the thought
// signature it attached to ITS OWN function calls, and rejects (HTTP 400
// INVALID_ARGUMENT) any function-call part without one — e.g. a call that
// Groq or Ollama produced on an earlier turn. Fabricating signatures is
// discouraged by Google and is never done here.
//
// Instead, before each provider attempt the router asks for the history in a
// form THAT provider can safely read:
//   - A tool-call block (an assistant message with toolCalls + the tool
//     results that answer it) produced by the SAME provider is sent natively,
//     unchanged. Same-provider continuation is byte-for-byte what it was.
//   - A block produced by ANY OTHER (or an unknown) provider is converted to
//     provider-neutral text: the assistant message keeps its own text plus a
//     short note naming the tools it called, and the results follow as ONE
//     user message, clearly labelled as Mission Control tool output. Nothing
//     is dropped: tool names, inputs, results (including evidence refs and
//     wrap-up nudges) and error flags are all preserved as text.
//   - If a block cannot be converted faithfully (a result without its call,
//     a call without its result, a duplicate result), null is returned and
//     the router does NOT send that history to that provider (fail closed).
//
// Provenance: the router records which provider produced each tool call
// object it returns (WeakMap, in-process, no ids parsed). Callers pass those
// same objects back in the next request. A call the router did not produce
// (unknown provenance) is treated as foreign to every provider, except that
// ids in the Gemini adapter's own "gc~" encoding are Gemini's.
//
// Pure: no I/O. Tools offered on a turn and the tool guard are untouched —
// this only changes how PAST turns are written for the next model.

import type { LlmMessage, LlmToolCall, ProviderId } from "./llm";

const producedBy = new WeakMap<LlmToolCall, ProviderId>();

// Called by the router for every tool call a provider returns.
export function rememberToolCallProvider(calls: readonly LlmToolCall[], provider: ProviderId): void {
  for (const c of calls) if (c && typeof c === "object") producedBy.set(c, provider);
}

// Which provider produced this tool call, if known.
export function toolCallProvider(call: LlmToolCall): ProviderId | undefined {
  const known = producedBy.get(call);
  if (known) return known;
  if (typeof call?.id === "string" && call.id.startsWith("gc~")) return "gemini"; // lib/providers/gemini.ts encoding
  return undefined;
}

type ToolMsg = Extract<LlmMessage, { role: "tool" }>;
type AssistantMsg = Extract<LlmMessage, { role: "assistant" }>;

export const SWITCH_RESULTS_HEADER =
  "[Mission Control] Results of the tool calls from the previous turn (produced by Mission Control's own read-only tools, not by the user). The model has changed since that turn; continue the same task, and call tools normally if you need more data.";

function neutralBlock(a: AssistantMsg, results: ToolMsg[]): LlmMessage[] {
  const calls = a.toolCalls ?? [];
  const note = `[Mission Control] In this turn the assistant called ${calls.length} tool${calls.length === 1 ? "" : "s"}: ${calls.map((c) => c.name).join(", ")}. The results follow in the next message.`;
  const body = calls
    .map((c, i) => {
      const r = results.find((t) => t.toolCallId === c.id)!;
      return `--- Tool call ${i + 1}: ${c.name} ${JSON.stringify(c.input ?? {})}${r.isError ? " (error)" : ""} ---\n${r.content}`;
    })
    .join("\n\n");
  return [
    { role: "assistant", content: [a.content?.trim() ? a.content : "", note].filter(Boolean).join("\n\n") },
    { role: "user", content: `${SWITCH_RESULTS_HEADER}\n\n${body}` },
  ];
}

// History for `target`. Returns the ORIGINAL array when nothing needs
// converting (so same-provider requests are passed through untouched),
// a converted copy when a foreign block was found, or null when a foreign
// block cannot be converted faithfully.
export function historyForProvider(target: ProviderId, messages: readonly LlmMessage[]): LlmMessage[] | null {
  const needs = (a: AssistantMsg) => (a.toolCalls ?? []).some((c) => toolCallProvider(c) !== target);
  const hasForeign = messages.some((m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0 && needs(m));
  if (!hasForeign) return messages as LlmMessage[];

  const out: LlmMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "tool") {
      // Results of a converted block are consumed with it below. Any other
      // tool result is kept only if it answers a call of the native block
      // directly before it; otherwise the history is not safe to send.
      if (!findNativeOwner(out, m.toolCallId)) return null;
      out.push(m);
      continue;
    }
    if (m.role !== "assistant" || !(m.toolCalls?.length) || !needs(m)) {
      out.push(m);
      continue;
    }
    // Foreign block: collect the tool results that directly follow it.
    const ids = new Set(m.toolCalls.map((c) => c.id));
    if (ids.size !== m.toolCalls.length) return null; // ambiguous ids
    const results: ToolMsg[] = [];
    let j = i + 1;
    for (; j < messages.length && messages[j].role === "tool"; j++) {
      const t = messages[j] as ToolMsg;
      if (!ids.has(t.toolCallId) || results.some((r) => r.toolCallId === t.toolCallId)) return null; // orphan / duplicate
      results.push(t);
    }
    if (results.length !== ids.size) return null; // a call without its result
    out.push(...neutralBlock(m, results));
    i = j - 1;
  }
  return out;
}

// A tool result kept natively must answer a call in the nearest preceding
// native assistant block (only tool results in between).
function findNativeOwner(out: LlmMessage[], toolCallId: string): boolean {
  for (let k = out.length - 1; k >= 0; k--) {
    const m = out[k];
    if (m.role === "tool") continue;
    return m.role === "assistant" && (m.toolCalls ?? []).some((c) => c.id === toolCallId);
  }
  return false;
}
