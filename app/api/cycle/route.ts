import { NextRequest, NextResponse } from "next/server";
import { runCycle } from "../../../agents/orchestrator";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runCycle();
  return NextResponse.json(result);
}
