import { NextRequest, NextResponse } from "next/server";
import { getSuggestion } from "../../../../../lib/suggestions";
import { getDiff } from "../../../../../tools/github-ci";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await getSuggestion(id);
  if (!s || !s.qa_branch) return NextResponse.json({ files: [] });
  return NextResponse.json({ files: await getDiff(s.qa_branch) });
}
