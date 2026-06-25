import { NextRequest, NextResponse } from "next/server";
import { runGroup } from "../../../agents/orchestrator";
import type { Cadence } from "../../../lib/types";

export const maxDuration = 300;

const VALID: Cadence[] = ["hourly", "4h", "daily", "5day"];

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const group = (req.nextUrl.searchParams.get("group") ?? "4h") as Cadence;
  if (!VALID.includes(group)) {
    return NextResponse.json({ error: `invalid group "${group}"` }, { status: 400 });
  }
  const result = await runGroup(group);
  return NextResponse.json({ group, result });
}
