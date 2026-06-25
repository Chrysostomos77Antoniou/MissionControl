import { queueApproval } from "../lib/approvals";
import type { AgentId } from "../lib/types";

export async function queuePushNotification(
  agent: AgentId,
  input: { title: string; body: string; audience: string },
): Promise<string> {
  await queueApproval({
    agent,
    action_type: "push_notification",
    payload: input,
    preview: `Push → ${input.audience}: ${input.title} — ${input.body}`,
  });
  return `Queued a push notification for owner approval. It will NOT send until approved.`;
}
