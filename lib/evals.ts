import { anthropic, HAIKU } from "./anthropic";
import { supabaseAdmin } from "./supabase";
import { recordUsage } from "./usage";
import { logActivity } from "./memory";
import type { AgentId, Suggestion } from "./types";

export interface AgentEval {
  id: string;
  agent: AgentId;
  cycle_at: string;
  score: number;
  reasoning: string;
  suggestions_count: number;
  created_at: string;
}

const GRADER_SYSTEM = `You are a quick quality grader for an AI analyst agent's work cycle. Score this cycle's output from 1 (poor) to 5 (excellent) against these standards: (1) claims are backed by verified evidence, not just assertions, (2) findings are specific and actionable, not generic, (3) recommendations are right-sized for an early-stage app with a small user base, not enterprise-scale overengineering, (4) the cycle avoids duplicating an already-open finding. A cycle that correctly concludes "nothing new to report" after real investigation deserves a high score — do not penalize an agent for finding nothing when nothing is genuinely wrong. Reply in exactly this format on one line, nothing else: SCORE: <1-5> REASON: <one sentence>`;

// Fire-and-forget grading for one agent's cycle — mirrors the shape of
// reviewCycleConsensus in lib/consensus.ts: a single cheap Haiku call,
// wrapped so a grading failure can never affect the cycle that triggered it.
export async function gradeAgentRun(
  agent: AgentId,
  cycleAt: string,
  text: string,
  saved: Suggestion[],
  open: Suggestion[],
): Promise<void> {
  const savedList = saved.length
    ? saved.map((s) => `- (${s.priority}) ${s.title}: ${s.body.slice(0, 200)}`).join("\n")
    : "(none saved this cycle)";
  const openList = open.length
    ? open.map((s) => `- (${s.priority}) ${s.title}`).join("\n")
    : "(none)";
  const userMessage = `Findings already open before this cycle started (for judging duplication only):\n${openList}\n\nAgent's final summary for this cycle:\n${text.slice(0, 1000)}\n\nSuggestions saved this cycle:\n${savedList}`;

  let score: number;
  let reasoning: string;
  try {
    const resp = await anthropic.messages.create({
      model: HAIKU,
      max_tokens: 150,
      system: GRADER_SYSTEM,
      messages: [{ role: "user", content: userMessage }],
    });
    await recordUsage(HAIKU, resp.usage);
    const raw = resp.content
      .filter((b): b is Extract<typeof resp.content[number], { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    const match = raw.match(/SCORE:\s*([1-5])\s*REASON:\s*(.+)/i);
    if (!match) {
      // Silent otherwise — a missing grade would be indistinguishable from
      // "this agent hasn't run yet" without this trace.
      await logActivity(agent, "eval:unparseable", raw.slice(0, 200));
      return;
    }
    score = Number(match[1]);
    reasoning = match[2].trim().slice(0, 500);
  } catch (err) {
    await logActivity(agent, "eval:failed", err instanceof Error ? err.message.slice(0, 200) : "unknown error");
    return; // never let a grading failure affect the cycle itself
  }

  await supabaseAdmin.from("agent_evals").insert({
    agent,
    cycle_at: cycleAt,
    score,
    reasoning,
    suggestions_count: saved.length,
  });
}

export async function recentEvals(agent: AgentId, limit = 10): Promise<AgentEval[]> {
  const { data } = await supabaseAdmin
    .from("agent_evals")
    .select("*")
    .eq("agent", agent)
    .order("cycle_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as AgentEval[];
}
