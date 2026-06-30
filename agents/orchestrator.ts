import Anthropic from "@anthropic-ai/sdk";
import { anthropic, HAIKU } from "../lib/anthropic";
import { AGENTS, AGENT_BY_ID } from "./registry";
import { getOrchestratorBriefing } from "../lib/briefing";
import { recordUsage } from "../lib/usage";
import { runGroup, runOne, runHandler } from "./run-agent";
import type { AgentId, Cadence } from "../lib/types";

export { runGroup, runOne, runHandler };

const CADENCES: Cadence[] = ["hourly", "4h", "daily", "5day"];

// Fire agent runs WITHOUT blocking the chat (a run takes minutes); the owner
// watches results land in the inbox. Errors are swallowed so a failed background
// run can never crash the chat request.
function dispatch(scope: string): string {
  const s = (scope || "all").trim().toLowerCase();
  if (s === "all" || s === "everyone" || s === "team" || s === "everybody") {
    for (const c of CADENCES) runGroup(c).catch(() => {});
    return `Dispatched all ${AGENTS.length} agents. Fresh suggestions will appear in the inbox over the next few minutes.`;
  }
  if (CADENCES.includes(s as Cadence)) {
    runGroup(s as Cadence).catch(() => {});
    const names = AGENTS.filter((a) => a.cadence === s).map((a) => a.name);
    return `Dispatched the ${s} group (${names.join(", ")}). Results will land in the inbox shortly.`;
  }
  const spec = AGENT_BY_ID[s as AgentId];
  if (spec) {
    runOne(spec.id).catch(() => {});
    return `Dispatched ${spec.name}. Its suggestions will appear in the inbox shortly.`;
  }
  return `Unknown target "${scope}". Use "all", a cadence group (hourly / 4h / daily / 5day), or an agent id.`;
}

// A streaming chat that can also call tools. Tool calls are resolved in a short
// loop (the handler returns a summary string), then the model's final reply is
// streamed back to the client.
function streamWithTools(
  system: string,
  userMessage: string,
  tools: Anthropic.Tool[],
  onTool: (name: string, input: unknown) => string,
): ReadableStream {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        const messages: Anthropic.MessageParam[] = [
          { role: "user", content: userMessage },
        ];
        for (let turn = 0; turn < 4; turn++) {
          const resp = await anthropic.messages.create({
            model: HAIKU,
            max_tokens: 1500,
            system,
            tools,
            messages,
          });
          await recordUsage(HAIKU, resp.usage);
          for (const block of resp.content) {
            if (block.type === "text" && block.text) {
              controller.enqueue(encoder.encode(block.text));
            }
          }
          if (resp.stop_reason !== "tool_use") break;
          messages.push({ role: "assistant", content: resp.content });
          const results: Anthropic.ToolResultBlockParam[] = [];
          for (const block of resp.content) {
            if (block.type === "tool_use") {
              results.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: onTool(block.name, block.input),
              });
            }
          }
          messages.push({ role: "user", content: results });
        }
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

// Private 1:1 chat with a single agent. It can talk, and — when asked — run its
// own analysis now (posting fresh suggestions to the inbox in the background).
export async function streamAgentChat(
  agentId: AgentId,
  message: string,
): Promise<ReadableStream> {
  const spec = AGENT_BY_ID[agentId];
  const system = `${spec.system}

You are in a private chat with the FootRank owner. Answer conversationally and concretely from your area of expertise. If the owner asks you to run, work, analyse, or produce suggestions NOW, call run_my_analysis (it runs in the background and posts to the inbox). Otherwise, just talk.`;
  const tool: Anthropic.Tool = {
    name: "run_my_analysis",
    description:
      "Run your own full analysis now and save fresh suggestions to the owner's inbox. Use when the owner asks you to run / work / analyse / produce suggestions now.",
    input_schema: { type: "object", properties: {} },
  };
  return streamWithTools(system, message, [tool], (name) => {
    if (name === "run_my_analysis") {
      runOne(agentId).catch(() => {});
      return `Started a full ${spec.name} analysis in the background — suggestions will appear in the owner's inbox shortly.`;
    }
    return `Unknown tool ${name}.`;
  });
}

const ORCH_SYSTEM = `You are the Chief Orchestrator of FootRank Mission Control — the single point of contact between the owner and a team of 12 specialist agents (Engineering, Developer, QA, Cybersecurity, DevOps & Reliability, UX/Design, Marketing, Growth, Data, Community & Trust/Safety, Competitive Intel, Monetization).

Every agent reports its findings up to you; you review and verify them before anything reaches the owner. You have full live awareness of the team's current state (provided below).

You can ACTUALLY dispatch the team: when the owner asks you to run, kick off, or dispatch the agents (all of them, a group, or one specific agent), call the run_agents tool, then confirm exactly what you dispatched and that results will appear in the inbox.

When the owner asks for status, give a clear executive summary: what each active agent found, what's in progress (including QA test/fix loops), what needs the owner's attention or approval, and your own assessment — flag anything risky, contradictory, or low-quality. Be concise, direct, and professional. No preamble.`;

export async function streamChat(userMessage: string): Promise<ReadableStream> {
  const briefing = await getOrchestratorBriefing();
  const system = `${ORCH_SYSTEM}\n\n=== CURRENT TEAM STATE (live) ===\n${briefing}`;
  const tool: Anthropic.Tool = {
    name: "run_agents",
    description:
      "Trigger specialist agents to run NOW and produce fresh suggestions in the owner's inbox. Use whenever the owner asks to run, dispatch, or kick off the team or a specific agent. 'scope' is: 'all' for every agent; a cadence group ('hourly', '4h', 'daily', '5day'); or a single agent id (cybersecurity, engineering, developer, qa, uxdesign, marketing, growth, data, community, competitive, monetization, devops).",
    input_schema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          description: "'all', a cadence group, or an agent id",
        },
      },
      required: ["scope"],
    },
  };
  return streamWithTools(system, userMessage, [tool], (name, input) => {
    if (name === "run_agents") {
      return dispatch(String((input as { scope?: string })?.scope ?? "all"));
    }
    return `Unknown tool ${name}.`;
  });
}
