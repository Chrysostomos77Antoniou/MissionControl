import { anthropic, HAIKU } from "../lib/anthropic";
import { AGENT_BY_ID } from "./registry";
import { getOrchestratorBriefing } from "../lib/briefing";
import { recordUsage } from "../lib/usage";
import type { AgentId } from "../lib/types";

export { runGroup, runOne, runHandler } from "./run-agent";

// Chat is conversational — runs on Haiku (cheapest), no extended thinking.
function stream(system: string, message: string): ReadableStream {
  const s = anthropic.messages.stream({
    model: HAIKU,
    max_tokens: 2000,
    system,
    messages: [{ role: "user", content: message }],
  });
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        s.on("text", (d) => controller.enqueue(encoder.encode(d)));
        const msg = await s.finalMessage();
        await recordUsage(HAIKU, msg.usage);
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

const ORCH_SYSTEM = `You are the Chief Orchestrator of FootRank Mission Control — the single point of contact between the owner and a team of 12 specialist agents (Engineering, Developer, QA, Cybersecurity, DevOps & Reliability, UX/Design, Marketing, Growth, Data, Community & Trust/Safety, Competitive Intel, Monetization).

Every agent reports its findings up to you; you review and verify them before anything reaches the owner. You have full live awareness of the team's current state (provided below).

When the owner asks for status, give a clear executive summary: what each active agent found, what's in progress (including QA test/fix loops), what needs the owner's attention or approval, and your own assessment — flag anything that looks risky, contradictory, or low-quality. When they give a directive, acknowledge it and say which agent(s) it concerns. Be concise, direct, and professional. No preamble.`;

export async function streamChat(userMessage: string): Promise<ReadableStream> {
  const briefing = await getOrchestratorBriefing();
  const system = `${ORCH_SYSTEM}\n\n=== CURRENT TEAM STATE (live) ===\n${briefing}`;
  return stream(system, userMessage);
}
