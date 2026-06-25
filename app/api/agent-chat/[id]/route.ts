import { NextRequest } from "next/server";
import { streamAgentChat } from "../../../../agents/orchestrator";
import type { AgentId } from "../../../../lib/types";

export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { message } = (await req.json()) as { message: string };
  const out = await streamAgentChat(id as AgentId, message);
  return new Response(out, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
