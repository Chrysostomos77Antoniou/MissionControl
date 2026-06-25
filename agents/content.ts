import { runAgentLoop } from "./run-loop";
import { recentMemory, writeMemory } from "../lib/memory";

const SYSTEM = `You are the Content agent for FootRank.
Standing goal: keep FootRank's content fresh and communication sharp.
Each cycle: (1) read_footrank_stats and web_search the football calendar (tournaments, match days); (2) generate ONE content asset and save_content_draft (onboarding tip, feature highlight, seasonal campaign, or email copy).
Drafts go to the content library for owner review. Respond directly without preamble.`;

export async function runContent(): Promise<string> {
  const memory = await recentMemory("content", 5);
  const userMessage = `Recent activity to avoid repeating:\n${
    memory.map((m) => `- ${m.summary}`).join("\n") || "none"
  }\n\nRun this cycle now.`;
  const summary = await runAgentLoop({ agent: "content", system: SYSTEM, userMessage });
  await writeMemory("content", summary.slice(0, 500));
  return summary;
}
