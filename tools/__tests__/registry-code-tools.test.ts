import { describe, it, expect, vi, beforeEach } from "vitest";

const { readRepoFileLines, readRepoFile, searchCode } = vi.hoisted(() => ({
  readRepoFileLines: vi.fn<(...args: unknown[]) => Promise<string>>(async () => "numbered"),
  readRepoFile: vi.fn<(...args: unknown[]) => Promise<string>>(async () => "raw"),
  searchCode: vi.fn<(...args: unknown[]) => Promise<string>>(async () => "hits"),
}));
vi.mock("../github-read", () => ({ readRepoFileLines, readRepoFile, listRepo: vi.fn(async () => "") }));
vi.mock("../code-search", () => ({ searchCode }));
vi.mock("../../lib/suggestions", () => ({ saveSuggestion: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabaseAdmin: {} }));

import { toolsFor, dispatchTool, PINNED_CODE_TOOLS } from "../registry";
import { READ_ONLY_TOOLS } from "../../agents/free-loop";
import type { AgentId } from "../../lib/types";

const PIN = "27e1e5ac5a89cb9d5f5cb7ca6a1368afa0582a46";
const CODE_AGENTS: AgentId[] = ["cybersecurity", "engineering", "developer", "qa", "uxdesign", "devops", "legal"];
const OTHER_AGENTS: AgentId[] = ["marketing", "growth", "community", "competitive", "copywriter"];

beforeEach(() => {
  readRepoFileLines.mockClear();
  readRepoFile.mockClear();
  searchCode.mockClear();
});

describe("7a code tools in the registry", () => {
  it("search_code is offered exactly to the agents that already read code", () => {
    for (const a of CODE_AGENTS) expect(toolsFor(a).map((t) => t.name), a).toContain("search_code");
    for (const a of OTHER_AGENTS) expect(toolsFor(a).map((t) => t.name), a).not.toContain("search_code");
  });

  it("no new write authority: the technical toolset is the old one plus search_code", () => {
    expect(toolsFor("engineering").map((t) => t.name)).toEqual(["web_search", "read_footrank_stats", "db_read", "list_repo", "read_repo_file", "search_code", "save_suggestion"]);
  });

  it("read_repo_file takes path + optional start_line/end_line; search_code takes query + optional path", () => {
    const read = toolsFor("qa").find((t) => t.name === "read_repo_file")!;
    expect(read.input_schema.required).toEqual(["path"]);
    expect(Object.keys(read.input_schema.properties as object)).toEqual(["path", "start_line", "end_line"]);
    const search = toolsFor("qa").find((t) => t.name === "search_code")!;
    expect(search.input_schema.required).toEqual(["query"]);
    expect(Object.keys(search.input_schema.properties as object)).toEqual(["query", "path"]);
  });

  it("dispatch routes read_repo_file to the numbered reader at the pinned commit (not the fix agent's raw reader)", async () => {
    expect(await dispatchTool("engineering", "read_repo_file", { path: "lib/a.dart", start_line: 10, end_line: 20 }, { codeCommit: PIN })).toBe("numbered");
    expect(readRepoFileLines).toHaveBeenCalledWith("lib/a.dart", 10, 20, PIN);
    expect(readRepoFile).not.toHaveBeenCalled();
  });

  it("dispatch routes search_code at the pinned commit, and refuses it for agents without code access", async () => {
    expect(await dispatchTool("qa", "search_code", { query: "canonicalCity(", path: "lib" }, { codeCommit: PIN })).toBe("hits");
    expect(searchCode).toHaveBeenCalledWith("canonicalCity(", "lib", PIN);
    expect(await dispatchTool("marketing", "search_code", { query: "x" }, { codeCommit: PIN })).toMatch(/not available to marketing/);
    expect(searchCode).toHaveBeenCalledTimes(1);
  });

  it("both code tools get exactly the same pinned commit", async () => {
    await dispatchTool("developer", "read_repo_file", { path: "lib/a.dart" }, { codeCommit: PIN });
    await dispatchTool("developer", "search_code", { query: "x" }, { codeCommit: PIN });
    expect(readRepoFileLines.mock.calls[0][3]).toBe(PIN);
    expect(searchCode.mock.calls[0][2]).toBe(PIN);
    expect([...PINNED_CODE_TOOLS].sort()).toEqual(["read_repo_file", "search_code"]);
  });

  it("without a pinned commit both code tools refuse (fail closed) and nothing is read", async () => {
    for (const name of ["read_repo_file", "search_code"]) {
      expect(await dispatchTool("engineering", name, { path: "lib/a.dart", query: "x" })).toMatch(/^No pinned FootRank commit for this run/);
      expect(await dispatchTool("engineering", name, { path: "lib/a.dart", query: "x" }, { guardPassed: true })).toMatch(/^No pinned FootRank commit/);
    }
    expect(readRepoFileLines).not.toHaveBeenCalled();
    expect(searchCode).not.toHaveBeenCalled();
  });

  it("the model cannot choose or override the commit through its tool input", async () => {
    const other = "1111111111111111111111111111111111111111";
    await dispatchTool("engineering", "read_repo_file", { path: "lib/a.dart", commit: other, ref: other, codeCommit: other }, { codeCommit: PIN });
    await dispatchTool("engineering", "search_code", { query: "x", commit: other, codeCommit: other }, { codeCommit: PIN });
    expect(readRepoFileLines).toHaveBeenCalledWith("lib/a.dart", undefined, undefined, PIN);
    expect(searchCode).toHaveBeenCalledWith("x", undefined, PIN);
    // and a model-supplied value alone never counts as a pin
    expect(await dispatchTool("engineering", "search_code", { query: "x", codeCommit: other })).toMatch(/^No pinned FootRank commit/);
  });

  it("the free loop treats search_code as read-only (timeout + error-as-result, never a run-stopping write failure)", () => {
    expect(READ_ONLY_TOOLS.has("search_code")).toBe(true);
    expect(READ_ONLY_TOOLS.has("save_suggestion")).toBe(false);
  });
});
