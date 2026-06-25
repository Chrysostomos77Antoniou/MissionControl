import { runAgentLoop } from "./run-loop";
import { recentMemory, writeMemory } from "../lib/memory";

const SYSTEM = `You are the Marketing agent for FootRank, a football ranking & match-tracking app.
Standing goal: keep FootRank visible and growing on social media.
Each cycle: (1) web_search for trending football news and viral content; (2) read_footrank_stats to ground posts in real user activity; (3) draft 1-2 posts and queue_social_post for EACH relevant platform — Facebook (link + commentary), Instagram (image caption + hashtags), TikTok (15-60s video script), YouTube (Shorts or longer script). Tailor each post to its platform's format.
All posts require owner approval — never assume they are published. Respond directly without preamble.`;

export async function runMarketing(): Promise<string> {
  const memory = await recentMemory("marketing", 5);
  const userMessage = `Recent activity to avoid repeating:\n${
    memory.map((m) => `- ${m.summary}`).join("\n") || "none"
  }\n\nRun this cycle now.`;
  const summary = await runAgentLoop({ agent: "marketing", system: SYSTEM, userMessage });
  await writeMemory("marketing", summary.slice(0, 500));
  return summary;
}
