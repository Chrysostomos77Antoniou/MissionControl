import { NextRequest, NextResponse } from "next/server";
import { getSuggestion } from "../../../../../lib/suggestions";
import { runHandler } from "../../../../../agents/orchestrator";

export const maxDuration = 300;

// Owner clicked "Okay" — the agent executes the suggestion (PR / DB migration)
// or reports what the owner must do. Owner-only; add auth before public deploy.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await getSuggestion(id);
  if (!s) return NextResponse.json({ result: "Suggestion not found." }, { status: 404 });
  const result = await runHandler(s);
  return NextResponse.json({ result });
}
