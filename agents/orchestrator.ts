import { anthropic, MODEL } from "../lib/anthropic";
import { runMarketing } from "./marketing";
import { runGrowth } from "./growth";
import { runContent } from "./content";
import { pendingCount } from "../lib/approvals";
import { logActivity } from "../lib/memory";

export async function runCycle() {
  const pending = await pendingCount();
  if (pending > 20) {
    await logActivity("marketing", "cycle:skipped", `Queue backed up (${pending} pending).`);
    return { marketing: "skipped", growth: "skipped", content: "skipped" };
  }
  await logActivity("marketing", "cycle:start", `Cycle started at ${new Date().toISOString()}`);
  const [m, g, c] = await Promise.allSettled([runMarketing(), runGrowth(), runContent()]);
  const val = (r: PromiseSettledResult<string>) =>
    r.status === "fulfilled" ? r.value : `Error: ${r.reason}`;
  return { marketing: val(m), growth: val(g), content: val(c) };
}

const ORCH_SYSTEM = `You are the orchestrator of FootRank Mission Control. You coordinate the Marketing, Growth, and Content agents. When the owner messages you, answer status questions concisely and acknowledge directives clearly. Respond directly without preamble.`;

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
