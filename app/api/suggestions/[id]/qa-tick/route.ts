import { NextRequest, NextResponse } from "next/server";
import { getSuggestion } from "../../../../../lib/suggestions";
import { tick } from "../../../../../lib/qa-loop";

export const maxDuration = 300;

// Polled by the card while QA is running. Advances the loop: checks the emulator
// run, and on failure sends it back to the agent to fix and re-test.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await getSuggestion(id);
  if (!s) return NextResponse.json({ qa_status: "needs_owner" }, { status: 404 });
  const out = await tick(s);
  return NextResponse.json(out);
}
