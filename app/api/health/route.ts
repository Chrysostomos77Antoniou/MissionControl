import { NextResponse } from "next/server";
import { checkCredentialHealth } from "../../../lib/health";

export async function GET() {
  return NextResponse.json(await checkCredentialHealth());
}
