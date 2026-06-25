import { queueApproval } from "../lib/approvals";
import type { AgentId } from "../lib/types";

export async function queueSocialPost(
  agent: AgentId,
  input: { platform: "facebook" | "instagram" | "tiktok" | "youtube"; text: string; media_hint?: string },
): Promise<string> {
  await queueApproval({
    agent,
    action_type: "social_post",
    payload: input,
    preview: `${input.platform.toUpperCase()}: ${input.text}`,
  });
  return `Queued a ${input.platform} post for owner approval. It will NOT publish until approved.`;
}
