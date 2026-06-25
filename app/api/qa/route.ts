import { NextResponse } from "next/server";
import { runOne } from "../../../agents/orchestrator";

export const maxDuration = 300;

// On-demand QA run — triggered from the dashboard when a feature ships.
// Owner-only tool; add auth before any public deploy.
export async function POST() {
  const summary = await runOne("qa");
  return NextResponse.json({ agent: "qa", summary });
}
