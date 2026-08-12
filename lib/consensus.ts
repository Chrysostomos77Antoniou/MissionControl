import { anthropic, HAIKU } from "./anthropic";
import { supabaseAdmin } from "./supabase";
import { logActivity } from "./memory";
import { recordUsage } from "./usage";
import type { AgentId } from "./types";

// "Queen leads consensus" (the coordination pattern from ruvnet/ruflo's
// swarm model) applied narrowly: agents in the same cadence group run in
// parallel via Promise.allSettled, each checking the open-suggestions list
// at the START of its own run — so two agents that both find the same new
// issue in the same cycle can't see each other's fresh save and neither
// catches the overlap (allOpenSuggestionsDigest only prevents duplicating
// suggestions that existed BEFORE this cycle started). This runs once,
// after the whole group finishes, as a single cheap Haiku pass over just
// the titles from that cycle — flagging (not auto-merging) anything that
// looks duplicated or contradictory, for the owner to see in the log feed.
export async function reviewCycleConsensus(agentIds: AgentId[], sinceIso: string): Promise<void> {
  const { data } = await supabaseAdmin
    .from("suggestions")
    .select("id, agent, category, title")
    .in("agent", agentIds)
    .eq("status", "new")
    .gte("created_at", sinceIso);
  const fresh = (data ?? []) as { id: string; agent: AgentId; category: string | null; title: string }[];
  if (fresh.length < 2) return; // nothing from this cycle to cross-check

  const list = fresh.map((s) => `- [${s.agent}] (${s.category ?? "general"}) ${s.title}`).join("\n");
  let text = "";
  try {
    const resp = await anthropic.messages.create({
      model: HAIKU,
      max_tokens: 250,
      system:
        "You are a quick consistency reviewer. Given a list of findings different specialist agents just saved in the same run, say whether any TWO of them genuinely duplicate each other (same underlying issue) or contradict each other (recommend opposite actions). Reply with exactly 'NONE' if neither is true. Otherwise, one short sentence naming which two entries and why. Do not restate the whole list, do not comment on findings that are simply unrelated.",
      messages: [{ role: "user", content: list }],
    });
    await recordUsage(HAIKU, resp.usage);
    text = resp.content
      .filter((b): b is Extract<typeof resp.content[number], { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
  } catch {
    return; // never let a consensus-check failure affect the cycle itself
  }

  if (text && !/^none\.?$/i.test(text)) {
    await logActivity("engineering", "consensus:flag", text.slice(0, 280));
  }
}
