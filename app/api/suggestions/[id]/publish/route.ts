import { NextRequest, NextResponse } from "next/server";
import { getSuggestion, updateSuggestion } from "../../../../../lib/suggestions";
import { publishSuggestion } from "../../../../../lib/publish";
import { logActivity } from "../../../../../lib/memory";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await getSuggestion(id);
  if (!s) return NextResponse.json({ ok: false, detail: "Suggestion not found." }, { status: 404 });

  const result = await publishSuggestion(s);
  if (result.ok) await updateSuggestion(id, "published");
  await logActivity(s.agent, result.ok ? "published" : "publish:failed", result.detail);
  return NextResponse.json(result);
}
