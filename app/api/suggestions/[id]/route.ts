import { NextRequest, NextResponse } from "next/server";
import { updateSuggestion } from "../../../../lib/suggestions";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { status } = (await req.json()) as { status: "done" | "dismissed" };
  await updateSuggestion(id, status);
  return NextResponse.json({ ok: true });
}
