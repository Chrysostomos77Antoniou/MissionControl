import type Anthropic from "@anthropic-ai/sdk";
import type { AgentId } from "../lib/types";
import { webSearch } from "./web-search";
import { readFootrankStats } from "./supabase-read";
import { listRepo, readRepoFile } from "./github-read";
import { saveSuggestion } from "../lib/suggestions";

type ToolName =
  | "web_search"
  | "read_footrank_stats"
  | "list_repo"
  | "read_repo_file"
  | "save_suggestion";

const ALL_TOOLS: Record<ToolName, Anthropic.Tool> = {
  web_search: {
    name: "web_search",
    description:
      "Search the web for news, trends, competitors, libraries, CVEs, or best practices. Call this when current information would improve a suggestion.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  read_footrank_stats: {
    name: "read_footrank_stats",
    description:
      "Read live FootRank usage data (signups, matches, teams, behavior reports, notifications). Call this to ground suggestions in real numbers.",
    input_schema: { type: "object", properties: {} },
  },
  list_repo: {
    name: "list_repo",
    description:
      "List files/folders in the FootRank Flutter GitHub repo at a path (e.g. '' for root, 'lib', 'lib/auth'). Use to navigate the codebase.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  read_repo_file: {
    name: "read_repo_file",
    description: "Read the contents of one file in the FootRank repo (e.g. 'lib/main.dart').",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  save_suggestion: {
    name: "save_suggestion",
    description:
      "Save ONE recommendation to the owner's suggestions inbox. Be specific and actionable. The owner reads and acts on these — nothing is executed automatically.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Short tag, e.g. 'bug', 'feature', 'security', 'video-idea', 'campaign'." },
        title: { type: "string", description: "One-line summary." },
        body: { type: "string", description: "The detailed recommendation, with concrete steps or rationale." },
        priority: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["category", "title", "body", "priority"],
    },
  },
};

const BASE: ToolName[] = ["web_search", "read_footrank_stats", "save_suggestion"];
const WITH_CODE: ToolName[] = ["web_search", "read_footrank_stats", "list_repo", "read_repo_file", "save_suggestion"];

// Technical agents get codebase access; the rest get research + data + save.
const TOOLSETS: Record<AgentId, ToolName[]> = {
  cybersecurity: WITH_CODE,
  engineering: WITH_CODE,
  developer: WITH_CODE,
  qa: WITH_CODE,
  uxdesign: WITH_CODE,
  marketing: BASE,
  growth: BASE,
  data: BASE,
  community: BASE,
  competitive: BASE,
  monetization: BASE,
};

export function toolsFor(agent: AgentId): Anthropic.Tool[] {
  return TOOLSETS[agent].map((t) => ALL_TOOLS[t]);
}

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
    case "list_repo":
      return listRepo(String(input.path ?? ""));
    case "read_repo_file":
      return readRepoFile(String(input.path));
    case "save_suggestion":
      await saveSuggestion({
        agent,
        category: String(input.category ?? "general"),
        title: String(input.title),
        body: String(input.body),
        priority: (["low", "medium", "high"].includes(String(input.priority))
          ? String(input.priority)
          : "medium") as "low" | "medium" | "high",
      });
      return "Saved to the owner's suggestions inbox.";
    default:
      return `Unknown tool: ${name}`;
  }
}
