import { describe, it, expect, vi, beforeEach } from "vitest";

type Dispatch = (a: string, n: string, i: Record<string, unknown>) => Promise<string>;
let captured: { dispatch: Dispatch; system: string; tools: { name: string }[]; tier: string } | null = null;
vi.mock("../free-loop", () => ({
  runFreeLoop: vi.fn(async (o: { dispatch: Dispatch; system: string; tools: { name: string }[]; tier: string }) => { captured = o; return { text: "", toolOutputs: [] }; }),
}));
const { commitToBranch, fileExistsOnBase } = vi.hoisted(() => ({ commitToBranch: vi.fn(), fileExistsOnBase: vi.fn() }));
vi.mock("../../tools/github-ci", () => ({ commitToBranch: (...a: unknown[]) => commitToBranch(...a), fileExistsOnBase: (...a: unknown[]) => fileExistsOnBase(...a) }));
vi.mock("../../tools/github-read", () => ({ listRepo: vi.fn(), readRepoFile: vi.fn() }));
vi.mock("../../tools/web-search", () => ({ webSearch: vi.fn() }));
vi.mock("../../tools/db-read", () => ({ dbRead: vi.fn() }));

import { runFixAgent } from "../fix-agent";
import type { Suggestion } from "../../lib/types";

const s = { id: "1", agent: "cybersecurity", title: "Tighten RLS", body: "b" } as Suggestion;

describe("fix agent: submit_fix safety", () => {
  beforeEach(async () => {
    commitToBranch.mockReset();
    commitToBranch.mockResolvedValue("Committed 1 file(s) to qa/x.");
    fileExistsOnBase.mockReset();
    await runFixAgent(s, "qa/x", null);
  });

  it("runs on the free loop at the HIGH tier (never the local 4B model), with the same five tools", () => {
    expect(captured!.tier).toBe("high");
    expect(captured!.tools.map((t) => t.name).sort()).toEqual(["db_read", "list_repo", "read_repo_file", "submit_fix", "web_search"]);
  });

  it("offers no SQL-execution tool and tells the model migrations are files only", () => {
    const names = captured!.tools.map((t) => t.name);
    expect(names).not.toContain("apply_db_migration");
    expect(captured!.system).toMatch(/no way to execute SQL/);
  });
  it("rejects workflow edits without committing anything", async () => {
    const r = await captured!.dispatch("cybersecurity", "submit_fix", { summary: "x", files: [{ path: ".github/workflows/integration.yml", content: "x" }] });
    expect(r).toMatch(/Rejected/);
    expect(commitToBranch).not.toHaveBeenCalled();
  });
  it("rejects editing an existing migration", async () => {
    fileExistsOnBase.mockResolvedValue(true);
    const r = await captured!.dispatch("cybersecurity", "submit_fix", { summary: "x", files: [{ path: "supabase/migrations/20260918120000_fix_fee.sql", content: "x" }] });
    expect(r).toMatch(/already exists/);
    expect(commitToBranch).not.toHaveBeenCalled();
  });
  it("rejects when migration novelty can't be verified", async () => {
    fileExistsOnBase.mockResolvedValue(null);
    const r = await captured!.dispatch("cybersecurity", "submit_fix", { summary: "x", files: [{ path: "supabase/migrations/20260926120000_new_policy.sql", content: "x" }] });
    expect(r).toMatch(/could not verify/);
    expect(commitToBranch).not.toHaveBeenCalled();
  });
  it("commits a new migration file (it is never executed)", async () => {
    fileExistsOnBase.mockResolvedValue(false);
    const r = await captured!.dispatch("cybersecurity", "submit_fix", { summary: "x", files: [{ path: "supabase/migrations/20260926120000_new_policy.sql", content: "create policy ..." }] });
    expect(r).toMatch(/Committed/);
    expect(commitToBranch).toHaveBeenCalledTimes(1);
  });
});
