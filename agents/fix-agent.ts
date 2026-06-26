import type Anthropic from "@anthropic-ai/sdk";
import { runAgentLoop } from "./run-loop";
import { SONNET } from "../lib/anthropic";
import { AGENT_BY_ID } from "./registry";
import { webSearch } from "../tools/web-search";
import { listRepo, readRepoFile } from "../tools/github-read";
import { commitToBranch } from "../tools/github-ci";
import type { AgentId, Suggestion } from "../lib/types";

const TOOLS: Anthropic.Tool[] = [
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
    name: "submit_fix",
    description:
      "Submit the code fix. Provide the FULL new content of each changed file. This commits to the QA branch and runs the emulator test suite. Read the files first so your changes are complete and correct.",
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
      case "submit_fix": {
        const files = (input.files as { path: string; content: string }[]) ?? [];
        const res = await commitToBranch(branch, `mc: ${s.title.slice(0, 60)}`, files);
        if (res.startsWith("Committed")) committed = true;
        return res;
      }
      default:
        return `Unknown tool: ${name}`;
    }
  };

  const system = `${spec.system}

MODE: CODE FIX. Implement the change as actual code and submit_fix with the full new file contents. The fix is committed to a test branch and run against the FootRank emulator test suite — it must not break existing app flows. If you cannot express this as a code change (it needs a dashboard setting, a secret, or manual ops), do NOT submit_fix; instead explain exactly what the owner must do.`;

  const userMessage = failureContext
    ? `Your previous fix for "${s.title}" FAILED the emulator test suite. Fix the failure and submit_fix again (full file contents). Test failure output:\n\n${failureContext}`
    : `Implement this suggestion as a code change, then submit_fix:\nTitle: ${s.title}\nDetails:\n${s.body}`;

  const { text } = await runAgentLoop({
    agent: s.agent,
    system,
    userMessage,
    tools: TOOLS,
    maxTurns: 10,
    model: SONNET, // fixes run on Sonnet to keep cost down (Opus was ~2x)
    effort: "low",
    dispatch,
  });
  return { text, committed };
}
