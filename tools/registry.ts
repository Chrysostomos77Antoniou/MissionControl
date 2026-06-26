import type Anthropic from "@anthropic-ai/sdk";
import type { AgentId } from "../lib/types";
import { webSearch } from "./web-search";
import { readFootrankStats } from "./supabase-read";
import { listRepo, readRepoFile } from "./github-read";
import { dbRead } from "./db-read";
import { openPr } from "./github-write";
import { applyMigration } from "./db-migrate";
import { saveSuggestion } from "../lib/suggestions";
import { notify } from "../lib/notify";
import { AGENT_BY_ID } from "../agents/registry";

type ToolName =
  | "web_search"
  | "read_footrank_stats"
  | "list_repo"
  | "read_repo_file"
  | "save_suggestion"
  | "open_github_pr"
  | "apply_db_migration"
  | "db_read";

const ALL_TOOLS: Record<ToolName, Anthropic.Tool> = {
  web_search: {
    name: "web_search",
    description:
      "Search the web for news, trends, competitors, libraries, CVEs, or best practices. Call when current information would help.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  read_footrank_stats: {
    name: "read_footrank_stats",
    description:
      "Read live FootRank usage data (signups, matches, teams, behavior reports, notifications). Use to ground work in real numbers.",
    input_schema: { type: "object", properties: {} },
  },
  db_read: {
    name: "db_read",
    description:
      "Run a READ-ONLY SQL query against the LIVE FootRank Supabase database to verify the real state — RLS policies (select * from pg_policies), tables/columns (information_schema.columns), storage buckets/policies (select * from storage.buckets), settings. ALWAYS use this to confirm whether something already exists before suggesting it; the repo does NOT contain the live database config. SELECT/WITH only.",
    input_schema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] },
  },
  list_repo: {
    name: "list_repo",
    description:
      "List files/folders in the FootRank Flutter GitHub repo at a path (e.g. '' for root, 'lib'). Navigate the codebase.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  read_repo_file: {
    name: "read_repo_file",
    description: "Read one file's contents in the FootRank repo (e.g. 'lib/main.dart').",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  save_suggestion: {
    name: "save_suggestion",
    description:
      "Save ONE recommendation to the owner's inbox. Be specific and actionable — the owner reviews each and clicks Okay to have you execute it.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Short tag, e.g. 'bug', 'feature', 'security', 'growth'." },
        title: { type: "string", description: "One-line summary." },
        body: { type: "string", description: "Detailed recommendation, with concrete rationale or steps." },
        priority: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["category", "title", "body", "priority"],
    },
  },
  open_github_pr: {
    name: "open_github_pr",
    description:
      "Open a pull request against the FootRank repo with the actual code fix. Read the relevant files first so your changes are correct and complete. Provide the full new content of each changed file.",
    input_schema: {
      type: "object",
      properties: {
        branch: { type: "string", description: "New branch name, e.g. 'mc/fix-rls-policy'." },
        title: { type: "string" },
        body: { type: "string", description: "PR description: what changed and why." },
        files: {
          type: "array",
          description: "Files to create/update, each with the FULL new file content.",
          items: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
      },
      required: ["branch", "title", "body", "files"],
    },
  },
  apply_db_migration: {
    name: "apply_db_migration",
    description:
      "Apply a SQL migration DIRECTLY to the live FootRank database. Use for security/data fixes (e.g. enabling RLS, adding a policy). Be careful and idempotent (use IF EXISTS / IF NOT EXISTS). Runs in a transaction.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short migration name." },
        sql: { type: "string", description: "The SQL to run." },
      },
      required: ["name", "sql"],
    },
  },
};

const BASE: ToolName[] = ["web_search", "read_footrank_stats", "db_read", "save_suggestion"];
const BASE_CODE: ToolName[] = ["web_search", "read_footrank_stats", "db_read", "list_repo", "read_repo_file", "save_suggestion"];

const TECHNICAL: AgentId[] = ["cybersecurity", "engineering", "developer", "qa", "uxdesign", "devops"];
const isTechnical = (a: AgentId) => TECHNICAL.includes(a);

// Suggestion-time toolset (read-only + save). Agents only advise during cycles.
export function toolsFor(agent: AgentId): Anthropic.Tool[] {
  return (isTechnical(agent) ? BASE_CODE : BASE).map((t) => ALL_TOOLS[t]);
}

// Handler toolset (when the owner clicks Okay). Adds write powers for technical
// agents: open PRs and apply DB migrations. No save_suggestion — this is execution.
export function handlerToolsFor(agent: AgentId): Anthropic.Tool[] {
  const names: ToolName[] = isTechnical(agent)
    ? ["web_search", "read_footrank_stats", "list_repo", "read_repo_file", "open_github_pr", "apply_db_migration"]
    : ["web_search", "read_footrank_stats"];
  return names.map((t) => ALL_TOOLS[t]);
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
    case "db_read":
      return dbRead(String(input.sql));
    case "list_repo":
      return listRepo(String(input.path ?? ""));
    case "read_repo_file":
      return readRepoFile(String(input.path));
    case "save_suggestion": {
      const priority = (["low", "medium", "high"].includes(String(input.priority))
        ? String(input.priority)
        : "medium") as "low" | "medium" | "high";
      await saveSuggestion({
        agent,
        category: String(input.category ?? "general"),
        title: String(input.title),
        body: String(input.body),
        priority,
      });
      if (priority === "high") {
        await notify(`🔴 ${AGENT_BY_ID[agent]?.name ?? agent} flagged (high): ${String(input.title)}`);
      }
      return "Saved to the owner's suggestions inbox.";
    }
    case "open_github_pr":
      return openPr(input as Parameters<typeof openPr>[0]);
    case "apply_db_migration":
      return applyMigration(String(input.sql));
    default:
      return `Unknown tool: ${name}`;
  }
}
