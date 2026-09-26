import { NextRequest, NextResponse } from "next/server";
import { runScheduledCycle, runManual, SCHEDULED_GROUPS, type ScheduledGroup } from "../../../agents/cycle";
import { AGENT_BY_ID } from "../../../agents/registry";
import { isCronAuthorized } from "../../../lib/cron-auth";
import type { AgentId } from "../../../lib/types";

export const maxDuration = 300;

// Local scheduler endpoint (Windows Task Scheduler -> this app on 127.0.0.1 port 3000,
// see tools/schedule-cycle.ps1). Fails closed without CRON_SECRET.
//   ?group=4h|daily|5day|hourly  -> unattended cycle WITH change detection
//   ?group=<agent id>            -> explicit single-agent run (no detection)
// Either way: cycle lock, one agent at a time, free-only models, claim guard.
// The response carries outcomes only — no secrets, keys or model output.
export async function POST(req: NextRequest) {
  if (!isCronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const group = req.nextUrl.searchParams.get("group") ?? "4h";
  if (group in AGENT_BY_ID) {
    const r = await runManual([group as AgentId]);
    return NextResponse.json({ ...r, agents: r.agents.map((e) => ({ agent: e.agent, outcome: e.outcome, ...(e.reason ? { reason: e.reason } : {}) })) });
  }
  if (!SCHEDULED_GROUPS.includes(group as ScheduledGroup)) {
    return NextResponse.json({ error: "invalid group" }, { status: 400 });
  }
  const r = await runScheduledCycle(group as ScheduledGroup);
  return NextResponse.json(r);
}
