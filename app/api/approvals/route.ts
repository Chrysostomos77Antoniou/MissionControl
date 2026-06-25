import { NextResponse } from "next/server";
import { listPending } from "../../../lib/approvals";

export async function GET() {
  return NextResponse.json(await listPending());
}
