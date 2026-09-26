import { describe, it, expect, vi, beforeEach } from "vitest";

const { generate, inserted, logActivity, rows } = vi.hoisted(() => ({ generate: vi.fn(), inserted: [] as unknown[], logActivity: vi.fn(), rows: { data: [] as unknown[] } }));
vi.mock("../free-llm", () => ({ freeLlm: { generate } }));
vi.mock("../memory", () => ({ logActivity: (...a: unknown[]) => logActivity(...a) }));
vi.mock("../anthropic", () => {
  throw new Error("grader/consensus must not load lib/anthropic");
});
vi.mock("../supabase", () => {
  const q: Record<string, unknown> = {};
  for (const k of ["select", "in", "eq", "gte", "order", "limit"]) q[k] = () => q;
  (q as { then: unknown }).then = (res: (v: unknown) => void) => res(rows);
  return { supabaseAdmin: { from: () => ({ ...q, insert: (r: unknown) => { inserted.push(r); return Promise.resolve({ error: null }); } }) } };
});

import { gradeAgentRun } from "../evals";
import { reviewCycleConsensus } from "../consensus";

beforeEach(() => {
  generate.mockReset();
  inserted.length = 0;
  logActivity.mockReset();
  rows.data = [];
});

describe("grader and consensus use the free router ('simple' tier)", () => {
  it("grader parses the score and stores it", async () => {
    generate.mockResolvedValue({ text: "SCORE: 4 REASON: verified with db_read", toolCalls: [] });
    await gradeAgentRun("growth", "2026-09-26T00:00:00Z", "summary", [], []);
    expect(generate.mock.calls[0][0]).toBe("simple");
    expect(generate.mock.calls[0][1]).toMatchObject({ maxOutputTokens: 150 });
    expect(inserted[0]).toMatchObject({ agent: "growth", score: 4, reasoning: "verified with db_read" });
  });

  it("grader failure never throws and stores nothing", async () => {
    generate.mockRejectedValue(new Error("FREE_AI_QUOTA_EXHAUSTED: nope"));
    await expect(gradeAgentRun("growth", "t", "s", [], [])).resolves.toBeUndefined();
    expect(inserted).toHaveLength(0);
  });

  it("consensus flags overlaps from the model's reply", async () => {
    rows.data = [
      { id: "1", agent: "engineering", category: "db", title: "Add index" },
      { id: "2", agent: "developer", category: "db", title: "Missing index" },
    ];
    generate.mockResolvedValue({ text: "Entries 1 and 2 duplicate the same index issue.", toolCalls: [] });
    await reviewCycleConsensus(["engineering", "developer"], "2026-09-26T00:00:00Z");
    expect(generate.mock.calls[0][0]).toBe("simple");
    expect(generate.mock.calls[0][1]).toMatchObject({ maxOutputTokens: 250 });
    expect(logActivity).toHaveBeenCalledWith("engineering", "consensus:flag", expect.stringContaining("duplicate"));
  });

  it("consensus failure never throws", async () => {
    rows.data = [{ id: "1", agent: "a", category: null, title: "x" }, { id: "2", agent: "b", category: null, title: "y" }];
    generate.mockRejectedValue(new Error("down"));
    await expect(reviewCycleConsensus(["engineering"], "t")).resolves.toBeUndefined();
  });
});
