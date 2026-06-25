import { anthropic, MODEL } from "../lib/anthropic";
import { AGENT_BY_ID } from "./registry";
import type { AgentId } from "../lib/types";

export { runGroup, runOne, runHandler } from "./run-agent";

function stream(system: string, message: string): ReadableStream {
  const s = anthropic.messages.stream({
    model: MODEL,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    system,
    messages: [{ role: "user", content: message }],
  });
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        s.on("text", (d) => controller.enqueue(encoder.encode(d)));
        await s.finalMessage();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const friendly = /credit balance/i.test(msg)
          ? "⚠ Anthropic credit balance too low — add funds to use the agents."
          : `⚠ Agent error: ${msg.slice(0, 200)}`;
        controller.enqueue(encoder.encode(friendly));
      } finally {
        controller.close();
      }
    },
  });
}

// Private 1:1 chat with a single agent (conversational, persona-based).
export async function streamAgentChat(agentId: AgentId, message: string): Promise<ReadableStream> {
  const spec = AGENT_BY_ID[agentId];
  const system = `${spec.system}\n\nYou are in a private chat with the FootRank owner. Answer their questions conversationally and concretely from your area of expertise. This is a discussion — do not call tools or save suggestions; just talk.`;
  return stream(system, message);
}

const ORCH_SYSTEM = `You are the orchestrator of FootRank Mission Control. You coordinate a team of advisory agents (Engineering, Developer, QA, Cybersecurity, UX/Design, Marketing, Growth, Data, Community & Trust/Safety, Competitive Intel, Monetization) that produce suggestions for the owner. When the owner messages you, answer status questions concisely and acknowledge directives clearly. Respond directly without preamble.`;

export async function streamChat(userMessage: string): Promise<ReadableStream> {
  return stream(ORCH_SYSTEM, userMessage);
}
