import { NextRequest } from "next/server";
import { streamChat } from "../../../agents/orchestrator";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const { message } = (await req.json()) as { message: string };
  const stream = await streamChat(message);
  return new Response(stream, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
