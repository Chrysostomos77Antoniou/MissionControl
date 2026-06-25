import { NextRequest, NextResponse } from "next/server";
import { resolveApproval } from "../../../../lib/approvals";
import { logActivity } from "../../../../lib/memory";
import { executeApproval, type ExecResult } from "../../../../lib/execute";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { status, reason } = (await req.json()) as {
    status: "approved" | "rejected";
    reason?: string;
  };
  const approval = await resolveApproval(id, status, reason);

  let execution: ExecResult | null = null;
  if (status === "approved") {
    execution = await executeApproval(approval);
    await logActivity(
      approval.agent,
      execution.ok ? "executed" : "execute:failed",
      execution.detail,
    );
  } else {
    await logActivity(approval.agent, "approval:rejected", approval.preview);
  }

  return NextResponse.json({ approval, execution });
}
