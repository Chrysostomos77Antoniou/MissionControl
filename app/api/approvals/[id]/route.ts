import { NextRequest, NextResponse } from "next/server";
import { resolveApproval } from "../../../../lib/approvals";
import { logActivity } from "../../../../lib/memory";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { status, reason } = (await req.json()) as {
    status: "approved" | "rejected";
    reason?: string;
  };
  const approval = await resolveApproval(id, status, reason);
  await logActivity(approval.agent, `approval:${status}`, approval.preview);
  return NextResponse.json(approval);
}
