import { NextResponse } from "next/server";
import { agentStatuses } from "../../../lib/agent-status";

export async function GET() {
  return NextResponse.json(await agentStatuses());
}
