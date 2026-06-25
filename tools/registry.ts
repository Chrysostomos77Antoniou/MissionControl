import type Anthropic from "@anthropic-ai/sdk";
import type { AgentId } from "../lib/types";
import { supabaseAdmin } from "../lib/supabase";
import { webSearch } from "./web-search";
import { readFootrankStats } from "./supabase-read";
import { queueSocialPost } from "./social";
import { queuePushNotification } from "./notifications";
import { queueGithubAction } from "./github";

export const TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: "web_search",
    description:
      "Search the web for football news, trends, or competitor activity. Call this when current information would improve a decision.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "read_footrank_stats",
    description:
      "Read live FootRank usage data (recent signups, match activity, team counts). Call this to ground decisions in real numbers.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "queue_social_post",
    description:
      "Queue a social post for owner approval. Use for Facebook, Instagram, TikTok, or YouTube. The post does NOT publish until the owner approves.",
    input_schema: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["facebook", "instagram", "tiktok", "youtube"] },
        text: { type: "string", description: "Caption or script, tailored to the platform." },
        media_hint: { type: "string", description: "Suggested image/video direction." },
      },
      required: ["platform", "text"],
    },
  },
  {
    name: "queue_push_notification",
    description:
      "Queue a push notification to FootRank users for owner approval. Does NOT send until approved.",
    input_schema: {
      type: "object",
      properties: { title: { type: "string" }, body: { type: "string" }, audience: { type: "string" } },
      required: ["title", "body", "audience"],
    },
  },
  {
    name: "queue_github_action",
    description: "Queue a GitHub issue or PR for owner approval. Does NOT create until approved.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["issue", "pr"] },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["kind", "title", "body"],
    },
  },
  {
    name: "save_content_draft",
    description:
      "Save a content asset (onboarding tip, campaign idea, email copy, feature highlight) to the content library for owner review.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["onboarding_tip", "campaign", "email", "feature_highlight"] },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["type", "title", "body"],
    },
  },
];

export async function dispatchTool(
  agent: AgentId,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "web_search":
      return webSearch(String(input.query));
    case "read_footrank_stats":
      return readFootrankStats();
    case "queue_social_post":
      return queueSocialPost(agent, input as Parameters<typeof queueSocialPost>[1]);
    case "queue_push_notification":
      return queuePushNotification(agent, input as Parameters<typeof queuePushNotification>[1]);
    case "queue_github_action":
      return queueGithubAction(agent, input as Parameters<typeof queueGithubAction>[1]);
    case "save_content_draft": {
      await supabaseAdmin.from("content_drafts").insert({ agent, ...input });
      return "Saved to the content library for owner review.";
    }
    default:
      return `Unknown tool: ${name}`;
  }
}
