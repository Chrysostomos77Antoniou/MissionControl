import { anthropic, MODEL } from "../lib/anthropic";

export { runGroup, runOne } from "./run-agent";

const ORCH_SYSTEM = `You are the orchestrator of FootRank Mission Control. You coordinate a team of advisory agents (Engineering, Developer, QA, Cybersecurity, UX/Design, Marketing, Growth, Data, Community & Trust/Safety, Competitive Intel, Monetization) that produce suggestions for the owner. When the owner messages you, answer status questions concisely and acknowledge directives clearly. Respond directly without preamble.`;

export async function streamChat(userMessage: string): Promise<ReadableStream> {
  const stream = anthropic.messages.stream({
    model: MODEL,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    system: ORCH_SYSTEM,
    messages: [{ role: "user", content: userMessage }],
  });
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      stream.on("text", (delta) => controller.enqueue(encoder.encode(delta)));
      await stream.finalMessage();
      controller.close();
    },
  });
}
