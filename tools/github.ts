import { queueApproval } from "../lib/approvals";
import type { AgentId } from "../lib/types";

export async function queueGithubAction(
  agent: AgentId,
  input: { kind: "issue" | "pr"; title: string; body: string },
): Promise<string> {
  await queueApproval({
    agent,
    action_type: "github_action",
    payload: input,
    preview: `GitHub ${input.kind}: ${input.title}`,
  });
  return `Queued a GitHub ${input.kind} for owner approval. It will NOT be created until approved.`;
}
