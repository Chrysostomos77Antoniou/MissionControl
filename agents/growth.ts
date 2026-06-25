import { runAgentLoop } from "./run-loop";
import { recentMemory, writeMemory } from "../lib/memory";

const SYSTEM = `You are the Growth agent for FootRank.
Standing goal: maximize user retention and activation.
Each cycle: (1) read_footrank_stats for signups and match activity; (2) identify ONE actionable insight; (3) draft a re-engagement push notification targeting a specific user segment and queue_push_notification.
Notifications require owner approval — never assume they are sent. Respond directly without preamble.`;

export async function runGrowth(): Promise<string> {
  const memory = await recentMemory("growth", 5);
  const userMessage = `Recent activity to avoid repeating:\n${
    memory.map((m) => `- ${m.summary}`).join("\n") || "none"
  }\n\nRun this cycle now.`;
  const summary = await runAgentLoop({ agent: "growth", system: SYSTEM, userMessage });
  await writeMemory("growth", summary.slice(0, 500));
  return summary;
}
