import { NextRequest, NextResponse } from "next/server";
import { runManual } from "../../../../agents/cycle";
import { AGENT_BY_ID } from "../../../../agents/registry";
import type { AgentId } from "../../../../lib/types";

export const maxDuration = 300;

// Owner-triggered manual run from the dashboard's "Run Selected" button.
// Deliberately NOT under /api/cycle (which middleware treats as public for
// the scheduler's CRON_SECRET check) — this route relies on the normal owner
// session cookie instead. An explicit request skips change detection only:
// the selected agents run ONE AT A TIME under the cycle lock (agents/cycle.ts).
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const ids = Array.isArray(body?.ids) ? (body.ids as string[]) : [];
  const valid = ids.filter((id): id is AgentId => id in AGENT_BY_ID);
  if (valid.length === 0) {
    return NextResponse.json({ error: "no valid agent ids" }, { status: 400 });
  }
  const r = await runManual(valid);
  const out: Record<string, string> = {};
  if (r.status !== "completed") {
    for (const id of valid) out[id] = r.status === "skipped-overlap" ? "Skipped — another agent run is in progress." : `Not run (${r.status}).`;
  } else {
    for (const id of valid) {
      const e = r.agents.find((a) => a.agent === id);
      out[id] = e?.text ?? `Not run (${e?.outcome ?? "unknown"}).`;
    }
  }
  return NextResponse.json({ results: out });
}
