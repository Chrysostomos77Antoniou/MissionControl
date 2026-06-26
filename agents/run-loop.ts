import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, OPUS } from "../lib/anthropic";
import { dispatchTool } from "../tools/registry";
import { recordUsage } from "../lib/usage";
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

  const finalText = (content: Anthropic.ContentBlock[]) =>
    content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      // Cache the (stable) system prompt + tool definitions so every turn in
      // the loop — and repeat runs of the same agent — read them at ~10% cost.
      cache_control: { type: "ephemeral" },
      // Lower thinking effort on routine agents to cut token spend.
      ...(effort ? { output_config: { effort } } : {}),
      system,
      tools,
      messages,
    });
    await recordUsage(model, response.usage);

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
    messages.push({ role: "user", content: toolResults });
  }
  return { text: "Reached max turns.", toolOutputs };
}
