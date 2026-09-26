import type Anthropic from "@anthropic-ai/sdk";
import type { AgentId } from "../lib/types";
import { webSearch } from "./web-search";
import { readFootrankStats } from "./supabase-read";
import { listRepo, readRepoFile } from "./github-read";
import { dbRead } from "./db-read";
import { saveSuggestion } from "../lib/suggestions";
import { notify } from "../lib/notify";
import { normalizeCategory } from "../lib/suggestion-category";
import { AGENT_BY_ID } from "../agents/registry";

type ToolName =
  | "web_search"
  | "read_footrank_stats"
  | "list_repo"
  | "read_repo_file"
  | "save_suggestion"
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
      "Run ONE read-only SQL query (SELECT/WITH, executed as a read-only database role) against the LIVE FootRank Supabase database to verify the real state — RLS policies (select * from pg_policies), tables/columns (information_schema.columns), storage buckets (select * from storage.buckets), indexes, settings. ALWAYS use this to confirm whether something already exists before suggesting it; the repo does NOT contain the live database config. For app tables (public.*): use counts/aggregates and name non-personal columns explicitly — SELECT *, personal/free-text columns (names, emails, phones, tokens, messages…), the auth/vault schemas and non-built-in functions are rejected, and IDs are masked.",
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
        evidence: {
          type: "string",
          description:
            "The specific tool call and result that supports this finding — e.g. \"db_read: select * from pg_policies where tablename='matches' returned 0 rows (no policy exists)\" or \"read_repo_file: lib/match/data/match_repository.dart:42 shows no index on scheduled_at\". If this is a strategic/creative recommendation with no single verifiable fact to cite (e.g. a marketing angle), say that plainly instead of inventing evidence — do not fabricate a citation.",
        },
        priority: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["category", "title", "body", "evidence", "priority"],
    },
  },
};

const BASE: ToolName[] = ["web_search", "read_footrank_stats", "db_read", "save_suggestion"];
const BASE_CODE: ToolName[] = ["web_search", "read_footrank_stats", "db_read", "list_repo", "read_repo_file", "save_suggestion"];

const TECHNICAL: AgentId[] = ["cybersecurity", "engineering", "developer", "qa", "uxdesign", "devops", "legal"];
const isTechnical = (a: AgentId) => TECHNICAL.includes(a);

// Suggestion-time toolset (read-only + save). Agents only advise during cycles.
export function toolsFor(agent: AgentId): Anthropic.Tool[] {
  return (isTechnical(agent) ? BASE_CODE : BASE).map((t) => ALL_TOOLS[t]);
}

// No write/execution toolset exists any more. Removed in the Phase 1 safety
// pass: open_github_pr (handler-only, unreachable) and apply_db_migration
// (ran arbitrary model-written SQL against the LIVE database). Code and DB
// changes now go exclusively through lib/qa-loop.ts -> branch -> CI -> PR ->
// human review and merge. Migrations are committed as files, never executed.

// Loop-supplied context for a tool call. Never derived from model output, so
// the model cannot set it. Used by the free loop's claim guard.
export interface DispatchContext {
  guardPassed?: boolean; // true only when the claim guard verified every figure
  notify?: boolean; // false = never send the high-priority Telegram alert
  appendix?: string; // appended to a saved suggestion's body (unverified note + provenance)
}

// Fail-closed alert rule: a high-priority suggestion alerts ONLY with explicit
// claim-guard approval. Missing context (e.g. a legacy caller) never alerts.
export function shouldAlert(priority: string, ctx?: DispatchContext): boolean {
  return priority === "high" && ctx?.guardPassed === true && ctx.notify !== false;
}

export async function dispatchTool(
  agent: AgentId,
  name: string,
  input: Record<string, unknown>,
  ctx?: DispatchContext,
): Promise<string> {
  // Defence in depth (the loop already enforces per-turn offering): never run
  // a known tool for an agent whose toolset doesn't include it.
  if (name in ALL_TOOLS && !toolsFor(agent).some((t) => t.name === name)) {
    return `Rejected: tool "${name}" is not available to ${agent}.`;
  }
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
      const evidence = String(input.evidence ?? "").trim();
      const withEvidence = evidence ? `${String(input.body)}\n\n— Evidence: ${evidence}` : String(input.body);
      const body = ctx?.appendix ? `${withEvidence}\n\n${ctx.appendix}` : withEvidence;
      await saveSuggestion({
        agent,
        category: normalizeCategory(input.category).category,
        title: String(input.title),
        body,
        priority,
      });
      // Suggestions with unverified figures are still saved for human review,
      // but never push an immediate alert.
      if (shouldAlert(priority, ctx)) {
        await notify(`🔴 ${AGENT_BY_ID[agent]?.name ?? agent} flagged (high): ${String(input.title)}`);
      }
      return "Saved to the owner's suggestions inbox.";
    }
    default:
      return `Unknown tool: ${name}`;
  }
}
