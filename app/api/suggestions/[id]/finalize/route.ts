import { NextRequest, NextResponse } from "next/server";
import { getSuggestion, updateSuggestion } from "../../../../../lib/suggestions";
import { finalizePr } from "../../../../../lib/github-merge";
import { logActivity } from "../../../../../lib/memory";

export const maxDuration = 60;

// "Commit, push & test" — merge the agent's PR after checking CI, then clear the
// task. For non-PR results (e.g. a DB migration already applied), just mark done.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await getSuggestion(id);
  if (!s) return NextResponse.json({ ok: false, detail: "Suggestion not found." }, { status: 404 });

  if (!s.pr_url) {
    await updateSuggestion(id, "done");
    await logActivity(s.agent, "finalized", `${s.title.slice(0, 100)} (no PR — marked done)`);
    return NextResponse.json({ ok: true, detail: "No PR to merge (already applied). Marked done." });
  }

  const result = await finalizePr(s.pr_url);
  if (result.ok) {
    await updateSuggestion(id, "done");
    await logActivity(s.agent, "finalized", result.detail);
  } else {
    await logActivity(s.agent, "finalize:blocked", result.detail);
  }
  return NextResponse.json(result);
}
