import { NextResponse } from "next/server";
import { spendHistory } from "../../../../lib/usage";

export async function GET() {
  return NextResponse.json(await spendHistory(14));
}
