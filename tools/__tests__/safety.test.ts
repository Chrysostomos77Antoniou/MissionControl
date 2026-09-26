import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

vi.mock("../../lib/suggestions", () => ({ saveSuggestion: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabaseAdmin: {} }));

import { toolsFor, dispatchTool } from "../registry";
import { dbRead } from "../db-read";
import type { AgentId } from "../../lib/types";

const ROOT = join(__dirname, "..", "..");
const AGENTS: AgentId[] = ["cybersecurity", "engineering", "developer", "qa", "uxdesign", "marketing", "growth", "community", "competitive", "devops", "copywriter", "legal"];

describe("no live-database write path exists", () => {
  it("no agent is offered a migration / SQL-execution / PR tool", () => {
    for (const a of AGENTS) {
      const names = toolsFor(a).map((t) => t.name);
      expect(names).not.toContain("apply_db_migration");
      expect(names).not.toContain("open_github_pr");
    }
  });
  it("dispatching apply_db_migration does nothing", async () => {
    expect(await dispatchTool("cybersecurity", "apply_db_migration", { sql: "drop table x" })).toBe("Unknown tool: apply_db_migration");
  });
  it("dispatch refuses a known tool the agent is not given", async () => {
    expect(await dispatchTool("marketing", "read_repo_file", { path: "lib/main.dart" })).toMatch(/not available/);
  });
  it("the migration executor and auto-merge modules are gone", () => {
    expect(existsSync(join(ROOT, "tools", "db-migrate.ts"))).toBe(false);
    expect(existsSync(join(ROOT, "lib", "github-merge.ts"))).toBe(false);
    const ci = readFileSync(join(ROOT, "tools", "github-ci.ts"), "utf8");
    expect(ci).not.toMatch(/\/merges|\/merge"|mergeBranch/);
  });
  it("no source file calls the Management API's unrestricted query endpoint", () => {
    const files = ["tools/db-read.ts", "tools/registry.ts", "agents/fix-agent.ts", "lib/qa-loop.ts", "lib/health.ts"];
    for (const f of files) {
      const s = readFileSync(join(ROOT, f), "utf8");
      expect(s, f).not.toMatch(/database\/query[`"']/);
    }
  });
});

describe("dbRead", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    process.env.SUPABASE_PROJECT_REF = "ref123";
    process.env.SUPABASE_ACCESS_TOKEN = "tok";
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("rejects unsafe SQL without making any request", async () => {
    const out = await dbRead("select email from public.users");
    expect(out).toMatch(/rejected by the read-only guard/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("uses the read-only endpoint and redacts personal data in results", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [{ id: "3f2b8c1e-9a4d-4e2f-8b7a-1c2d3e4f5a6b", status: "reported by a@b.com" }] });
    const out = await dbRead("select id, status from public.matches");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.supabase.com/v1/projects/ref123/database/query/read-only");
    expect(out).not.toMatch(/a@b\.com|3f2b8c1e/);
  });
  it("leaves catalog output readable", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [{ tablename: "matches", policyname: "p" }] });
    const out = await dbRead("select tablename, policyname from pg_policies");
    expect(out).toContain("matches");
  });
});
