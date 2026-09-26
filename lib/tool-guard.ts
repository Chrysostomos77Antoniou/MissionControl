// Tool-offering enforcement (Phase 1 safety).
//
// A model can emit ANY tool name in a tool call — including one it was never
// offered on this turn (hallucinated, remembered from an earlier turn, or
// injected via content it read). Only tools that were actually offered for
// this exact request may ever be executed. Pure and side-effect free so it
// can be unit tested and shared by every loop (agents, chat, fix agent).

export interface OfferedTool {
  name: string;
}

export function offeredToolNames(tools: readonly OfferedTool[]): ReadonlySet<string> {
  return new Set(tools.map((t) => t.name));
}

export function isToolOffered(name: string, offered: ReadonlySet<string>): boolean {
  return typeof name === "string" && offered.has(name);
}

export const SECURITY_TOOL_REJECTED = "security:tool-rejected";

export function rejectedToolMessage(name: string): string {
  return `Rejected: tool "${name}" was not offered to you on this turn and was NOT executed. Use only the tools listed for this turn.`;
}
