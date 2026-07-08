import { NextRequest, NextResponse } from "next/server";
import { runOne } from "../../../../agents/orchestrator";
import { AGENT_BY_ID } from "../../../../agents/registry";
import type { AgentId } from "../../../../lib/types";

export const maxDuration = 300;

// Owner-triggered manual run from the dashboard's "Run Selected" button.
// Deliberately NOT under /api/cycle (which middleware treats as public for
// Vercel Cron's CRON_SECRET check) — this route relies on the normal owner
// session cookie instead.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const ids = Array.isArray(body?.ids) ? (body.ids as string[]) : [];
  const valid = ids.filter((id): id is AgentId => id in AGENT_BY_ID);
  if (valid.length === 0) {
    return NextResponse.json({ error: "no valid agent ids" }, { status: 400 });
  }
  const results = await Promise.allSettled(valid.map((id) => runOne(id)));
  const out: Record<string, string> = {};
  valid.forEach((id, i) => {
    const r = results[i];
    out[id] = r.status === "fulfilled" ? r.value : `Error: ${r.reason}`;
  });
  return NextResponse.json({ results: out });
}
