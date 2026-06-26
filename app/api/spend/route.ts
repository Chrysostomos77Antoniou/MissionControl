import { NextResponse } from "next/server";
import { spendSummary } from "../../../lib/usage";

export async function GET() {
  return NextResponse.json(await spendSummary());
}
