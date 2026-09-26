import { runFreeLoop, type ToolDef } from "./free-loop";
import { FIX_TIER } from "./agent-tiers";
import { AGENT_BY_ID } from "./registry";
import { webSearch } from "../tools/web-search";
import { listRepo, readRepoFile } from "../tools/github-read";
import { dbRead } from "../tools/db-read";
import { commitToBranch, fileExistsOnBase } from "../tools/github-ci";
import { validateFixFiles } from "../lib/fix-paths";
import type { AgentId, Suggestion } from "../lib/types";

const TOOLS: ToolDef[] = [
  {
    name: "list_repo",
    description: "List files/folders in the FootRank repo at a path (e.g. 'lib').",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "read_repo_file",
    description: "Read a file's contents (e.g. 'lib/main.dart').",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "web_search",
    description: "Search the web (APIs, deprecations, errors) when needed.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "db_read",
    description:
      "READ-ONLY, single-statement SQL (runs as a read-only database role) to verify real state (pg_catalog.pg_policies, storage.buckets, information_schema) BEFORE writing a migration — so you never recreate a policy/table that already exists. SELECT/WITH only. Personal columns (names, emails, phones, tokens…) and the auth/vault schemas are blocked; use counts/aggregates for user data.",
    input_schema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] },
  },
  {
    name: "submit_fix",
    description:
      "Submit the change. Provide the FULL new content of each changed file. This commits to a QA branch and runs the emulator test suite; if it passes, a pull request is opened for the OWNER to review and merge (nothing is merged or deployed automatically). Database changes must be a NEW file supabase/migrations/YYYYMMDDHHMMSS_name.sql — it is never executed by you or by Mission Control. .github/, secrets and signing files cannot be modified.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One paragraph: what you changed and why." },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
      },
      required: ["summary", "files"],
    },
  },
];

export interface FixResult {
  text: string;
  committed: boolean;
}

// Runs the responsible agent to produce/repair a code fix and commit it to the
// QA branch. `failureContext` is the emulator/test failure to repair (null on
// the first attempt).
export async function runFixAgent(
  s: Suggestion,
  branch: string,
  failureContext: string | null,
): Promise<FixResult> {
  const spec = AGENT_BY_ID[s.agent];
  let committed = false;

  const dispatch = async (_agent: AgentId, name: string, input: Record<string, unknown>): Promise<string> => {
    switch (name) {
      case "list_repo":
        return listRepo(String(input.path ?? ""));
      case "read_repo_file":
        return readRepoFile(String(input.path));
      case "web_search":
        return webSearch(String(input.query));
      case "db_read":
        return dbRead(String(input.sql));
      case "submit_fix": {
        const checked = validateFixFiles(input.files);
        if (!checked.ok) return `Rejected — nothing committed:\n- ${checked.errors.join("\n- ")}`;
        for (const m of checked.migrations) {
          const exists = await fileExistsOnBase(m);
          if (exists !== false) {
            return exists === null
              ? `Rejected — could not verify that ${m} is a new file (GitHub API error). Nothing committed.`
              : `Rejected — ${m} already exists. Never edit an existing migration; add a new timestamped file instead. Nothing committed.`;
          }
        }
        const files = checked.files;
        const res = await commitToBranch(branch, `mc: ${s.title.slice(0, 60)}`, files);
        if (res.startsWith("Committed")) committed = true;
        return res;
      }
      default:
        return `Unknown tool: ${name}`;
    }
  };

  const system = `${spec.system}

MODE: CODE FIX. Implement the change as actual code and submit_fix with the full new file contents. The fix is committed to a test branch and run against the FootRank emulator test suite — it must not break existing app flows. If it passes, a pull request is opened and the OWNER reviews and merges it; nothing you do reaches production on its own.

DATABASE CHANGES: you have no way to execute SQL against any database, and must not try. Express a schema/RLS/security change ONLY as a NEW migration file supabase/migrations/YYYYMMDDHHMMSS_short_snake_name.sql (UTC timestamp later than every existing migration; list_repo supabase/migrations first). Make it idempotent (IF EXISTS / IF NOT EXISTS, DROP POLICY IF EXISTS before CREATE POLICY) and never edit an existing migration. The owner applies it by hand after merging.

If you cannot express this as a code or migration-file change (it needs a dashboard setting, a secret, or manual ops), do NOT submit_fix; instead explain exactly what the owner must do.`;

  const userMessage = failureContext
    ? `Your previous fix for "${s.title}" FAILED the emulator test suite. Fix the failure and submit_fix again (full file contents). Test failure output:\n\n${failureContext}`
    : `Implement this suggestion as a code change, then submit_fix:\nTitle: ${s.title}\nDetails:\n${s.body}`;

  // "high" tier: strongest free Gemini model only, never the local 4B model.
  // Authority is unchanged: the same five tools, submit_fix still commits
  // only to the qa/* branch after path validation, and a human merges the PR.
  const { text } = await runFreeLoop({
    agent: s.agent,
    tier: FIX_TIER,
    system,
    userMessage,
    tools: TOOLS,
    maxTurns: 14,
    dispatch,
  });
  return { text, committed };
}
