import { NextResponse } from "next/server";
import { listSuggestions } from "../../../lib/suggestions";

export async function GET() {
  return NextResponse.json(await listSuggestions("new"));
}
