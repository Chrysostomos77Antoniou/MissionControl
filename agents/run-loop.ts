import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, OPUS, HAIKU } from "../lib/anthropic";
import { dispatchTool } from "../tools/registry";
import { recordUsage, flagApiError } from "../lib/usage";
import { logActivity } from "../lib/memory";
import type { AgentId } from "../lib/types";

export interface LoopOutput {
  text: string;
  toolOutputs: string[];
}

export async function runAgentLoop(opts: {
  agent: AgentId;
  system: string;
  userMessage: string;
  tools: Anthropic.Tool[];
  maxTurns?: number;
  model?: string;
  effort?: "low" | "medium" | "high";
  dispatch?: (agent: AgentId, name: string, input: Record<string, unknown>) => Promise<string>;
}): Promise<LoopOutput> {
  const { agent, system, userMessage, tools, maxTurns = 8, model = OPUS, effort, dispatch = dispatchTool } = opts;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userMessage }];
  const toolOutputs: string[] = [];
  // Real eval data showed broad-scope agents doing 25-30 genuine tool calls
  // (real db_read/read_repo_file investigation) and then hitting maxTurns
  // anyway, discarding all of it for the literal string "Reached max
  // turns." — which then made the quality grader (which only sees `text`)
  // wrongly conclude no investigation had happened. Track the last turn's
  // text throughout so the fallback below always has real content instead
  // of a placeholder.
  let lastText = "";

  const finalText = (content: Anthropic.ContentBlock[]) =>
    content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

  // Haiku doesn't support extended/adaptive thinking OR the effort control
  // (both 400 if sent) — only request them for models that actually support
  // them.
  const supportsThinkingControls = model !== HAIKU;
  const saveOnly = tools.filter((t) => t.name === "save_suggestion");

  for (let turn = 0; turn < maxTurns; turn++) {
    // On the true final turn, take away every tool except save_suggestion —
    // the earlier text nudge (below) alone wasn't reliably stopping agents
    // from opening new investigation threads right up to the wall, so make
    // it physically impossible: the model can only close out what it's
    // already found or explain there's nothing new, not start exploring.
    const isFinalTurn = turn === maxTurns - 1;
    const turnTools = isFinalTurn && saveOnly.length ? saveOnly : tools;

    let response;
    try {
      response = await anthropic.messages.create({
        model,
        max_tokens: 8000,
        ...(supportsThinkingControls ? { thinking: { type: "adaptive" } } : {}),
        // Cache the (stable) system prompt + tool definitions so every turn in
        // the loop — and repeat runs of the same agent — read them at ~10% cost.
        cache_control: { type: "ephemeral" },
        // Lower thinking effort on routine agents to cut token spend.
        ...(effort && supportsThinkingControls ? { output_config: { effort } } : {}),
        system,
        tools: turnTools,
        messages,
      });
    } catch (e) {
      // Degrade gracefully (e.g. out of credits) instead of throwing a 500.
      const msg = e instanceof Error ? e.message : String(e);
      await flagApiError(msg);
      const friendly = /credit balance/i.test(msg)
        ? "⚠ Anthropic credit balance too low — add funds to use the agents."
        : `⚠ Agent error: ${msg.slice(0, 200)}`;
      return { text: friendly, toolOutputs };
    }
    await recordUsage(model, response.usage);
    lastText = finalText(response.content) || lastText;

    if (response.stop_reason === "end_turn") return { text: finalText(response.content), toolOutputs };

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        await logActivity(agent, `tool:${block.name}`, JSON.stringify(block.input).slice(0, 300));
        const result = await dispatch(agent, block.name, block.input as Record<string, unknown>);
        toolOutputs.push(result);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }
    }
    if (toolResults.length === 0) return { text: finalText(response.content), toolOutputs };

    // With 2 turns left, a broad-scope agent mid-investigation is about to
    // hit the cap and produce nothing — the whole cycle's spend for zero
    // usable output. Nudge it to wrap up with whatever it's found so far
    // instead of silently dead-ending on "Reached max turns."
    const turnsLeft = maxTurns - turn - 1;
    const nextInput: Anthropic.ContentBlockParam[] = [...toolResults];
    if (turnsLeft === 2) {
      nextInput.push({
        type: "text",
        text: `You have ${turnsLeft} turns left before this cycle ends automatically. Stop opening new investigation threads and write your final conclusion now — synthesize what you've already found into your best answer, even if incomplete, and save any suggestion immediately rather than waiting.`,
      });
    } else if (turnsLeft === 1) {
      nextInput.push({
        type: "text",
        text: `This is your absolute final turn — every tool except save_suggestion has been removed. Either call save_suggestion now with your best finding from everything gathered so far, or write your closing conclusion as plain text if there's genuinely nothing new to report.`,
      });
    }
    messages.push({ role: "user", content: nextInput });
  }
  return { text: lastText || "Reached max turns.", toolOutputs };
}
