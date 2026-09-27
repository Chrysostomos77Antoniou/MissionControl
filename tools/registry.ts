import type Anthropic from "@anthropic-ai/sdk";
import type { AgentId } from "../lib/types";
import { webSearch } from "./web-search";
import { readFootrankStats } from "./supabase-read";
import { listRepo, readRepoFileLines } from "./github-read";
import { searchCode } from "./code-search";
import { dbRead } from "./db-read";
import { submitFinding, type FindingContext } from "../lib/finding-submit";
import { notify } from "../lib/notify";
import { AGENT_BY_ID } from "../agents/registry";

type ToolName =
  | "web_search"
  | "read_footrank_stats"
  | "list_repo"
  | "read_repo_file"
  | "search_code"
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
    description:
      "Read part of one file in the FootRank repo, with exact line numbers (e.g. path 'lib/main.dart'). Returns the commit read, the line range shown and the file's total line count. Without start_line/end_line it shows the first 250 lines; request later ranges to read further (max 400 lines per call). Quote line numbers only from this output.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        start_line: { type: "integer", description: "First line to show (1-based). Default 1." },
        end_line: { type: "integer", description: "Last line to show (inclusive)." },
      },
      required: ["path"],
    },
  },
  search_code: {
    name: "search_code",
    description:
      "Search the pushed FootRank code for an exact text (case-sensitive, not a regex): a function or class name to find its definition and callers, an import, a test, or a string. Returns file:line matches. Optional path limits the search to a file or folder (e.g. 'lib/match' or 'test'). Then open a match with read_repo_file.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Exact text to find, e.g. 'canonicalCity(' or 'class MatchRepository'." },
        path: { type: "string", description: "Optional file or folder to search within." },
      },
      required: ["query"],
    },
  },
  // 7b: structured finding submission. Checked by a deterministic evidence
  // gate (lib/finding-gate.ts) and duplicate check (lib/finding-fingerprint.ts)
  // before anything is saved.
  save_suggestion: {
    name: "save_suggestion",
    description:
      "Submit ONE structured finding to the owner's inbox. A deterministic gate checks it before saving: every evidence item must cite an evidence ref printed under a tool result from THIS run, with an excerpt copied exactly from that output (line numbers only as the tool printed them). " +
      "Classes: verified_bug = a defect proven by the tool output (needs location file+symbol, >= 2 independent evidence items, a mismatch or absence assertion, and what you checked to disprove it; no hedging). plausible_risk = evidence-backed risk, not confirmed. product_idea = a product/growth idea, never a bug. " +
      "A claim that something is missing/not checked needs an absence assertion citing a search_code (or db_read) ref that returned nothing. Unsupported bugs are downgraded or rejected; duplicates of open, dismissed or rejected findings are not saved.",
    input_schema: {
      type: "object",
      properties: {
        class: { type: "string", enum: ["verified_bug", "plausible_risk", "product_idea"] },
        title: { type: "string", description: "One-line summary." },
        location: {
          type: "object",
          description: "Where the finding lives. Required for verified_bug; file must be one you read or searched in this run.",
          properties: {
            file: { type: "string", description: "Repo path, e.g. 'lib/rankings/data/ranking_repository.dart' (or 'db:<table>' for a database object)." },
            symbol: { type: "string", description: "Function or class, e.g. 'RankingRepository.fetchPlayers'." },
            line: { type: "integer", description: "Optional; only a line number shown by read_repo_file/search_code." },
          },
        },
        claim: { type: "string", description: "The exact claim, stated plainly." },
        failure_scenario: { type: "string", description: "Concrete steps/state in which it goes wrong (bugs and risks)." },
        impact: { type: "string", description: "Who is affected and how." },
        evidence: {
          type: "array",
          description: "Evidence from THIS run's tool results.",
          items: {
            type: "object",
            properties: {
              ref: { type: "string", description: "The evidence ref printed under the tool result, e.g. 'ev3-1a2b3c'." },
              file: { type: "string" },
              start_line: { type: "integer" },
              end_line: { type: "integer" },
              excerpt: { type: "string", description: "Text copied exactly from that tool result." },
            },
            required: ["ref", "excerpt"],
          },
        },
        assertion: {
          type: "object",
          description: "Machine-checkable core of a bug. mismatch: a_value occurs in evidence a_evidence and a different b_value in evidence b_evidence (1-based). absence: ref of a search_code/db_read from this run that returned nothing. presence: the quoted code itself (not enough for verified_bug).",
          properties: {
            kind: { type: "string", enum: ["mismatch", "absence", "presence"] },
            a_evidence: { type: "integer" },
            a_value: { type: "string" },
            b_evidence: { type: "integer" },
            b_value: { type: "string" },
            ref: { type: "string" },
          },
          required: ["kind"],
        },
        what_checked_to_disprove: { type: "string", description: "What you searched/read to try to prove this wrong, and what it showed." },
        proposed_change: { type: "string", description: "The concrete recommended change." },
        priority: { type: "string", enum: ["low", "medium", "high"] },
        category: { type: "string", description: "Optional topic tag for product ideas, e.g. 'growth' or 'video-idea'." },
      },
      required: ["class", "title", "claim", "impact", "proposed_change", "priority"],
    },
  },
};

const BASE: ToolName[] = ["web_search", "read_footrank_stats", "db_read", "save_suggestion"];
const BASE_CODE: ToolName[] = ["web_search", "read_footrank_stats", "db_read", "list_repo", "read_repo_file", "search_code", "save_suggestion"];

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
  codeCommit?: string; // read_repo_file / search_code only: the run's pinned FootRank commit
  finding?: FindingContext; // save_suggestion only: the run's evidence ledger/history + guarded prose (7b)
}

// Tools that read FootRank code and must all use the run's single pinned commit
// (resolved once in agents/run-agent.ts, handed over by agents/free-loop.ts).
export const PINNED_CODE_TOOLS: ReadonlySet<string> = new Set(["read_repo_file", "search_code"]);

const NO_PINNED_COMMIT =
  "No pinned FootRank commit for this run (GitHub could not be reached when the run started) — code reading is unavailable. Nothing was read.";

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
      // The commit always comes from the loop-supplied context (pinned once at
      // run start), never from the model's input.
      if (!ctx?.codeCommit) return NO_PINNED_COMMIT;
      return readRepoFileLines(input.path, input.start_line, input.end_line, ctx.codeCommit);
    case "search_code":
      if (!ctx?.codeCommit) return NO_PINNED_COMMIT;
      return searchCode(input.query, input.path, ctx.codeCommit);
    case "save_suggestion": {
      // 7b: the deterministic gate + duplicate check decide what is saved and
      // with which class/priority. Without loop-supplied run context nothing is
      // saved (a legacy caller has no evidence ledger).
      const finding = ctx?.finding ? { ...ctx.finding, ...(ctx.appendix ? { appendix: ctx.appendix } : {}) } : undefined;
      const out = await submitFinding(agent, input, finding);
      // Only a gate-verified bug that SURVIVED independent verification (7c)
      // can alert, and only with explicit claim-guard approval (unchanged 6a
      // rule). Risks and ideas never alert.
      if (out.saved && out.saved.finalClass === "verified_bug" && out.saved.verified === true && shouldAlert(out.saved.priority, ctx)) {
        await notify(`🔴 ${AGENT_BY_ID[agent]?.name ?? agent} flagged (high): ${out.saved.title}`);
      }
      return out.message;
    }
    default:
      return `Unknown tool: ${name}`;
  }
}
