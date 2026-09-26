import { NextRequest, NextResponse } from "next/server";
import { getSuggestion, updateSuggestion } from "../../../../../lib/suggestions";
import { goLive } from "../../../../../lib/qa-loop";

export const maxDuration = 60;

// "I merged it" — verifies on GitHub that the OWNER merged the PR, then clears
// the task. Mission Control never merges anything itself.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await getSuggestion(id);
  if (!s) return NextResponse.json({ ok: false, detail: "Suggestion not found." }, { status: 404 });
  const res = await goLive(s);
  if (res.ok) await updateSuggestion(id, "done");
  return NextResponse.json(res);
}
