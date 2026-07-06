import { NextRequest, NextResponse } from "next/server";
import { runGroup, runOne } from "../../../agents/orchestrator";
import { AGENT_BY_ID } from "../../../agents/registry";
import type { Cadence } from "../../../lib/types";

export const maxDuration = 300;

const VALID: Cadence[] = ["hourly", "4h", "daily", "5day"];

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const group = req.nextUrl.searchParams.get("group") ?? "4h";
  // Also accept a single agent id (e.g. ?group=marketing) — useful for
  // targeted manual re-runs without re-billing a whole cadence group.
  if (group in AGENT_BY_ID) {
    const result = await runOne(group as keyof typeof AGENT_BY_ID);
    return NextResponse.json({ agent: group, result });
  }
  if (!VALID.includes(group as Cadence)) {
    return NextResponse.json({ error: `invalid group "${group}"` }, { status: 400 });
  }
  const result = await runGroup(group as Cadence);
  return NextResponse.json({ group, result });
}
