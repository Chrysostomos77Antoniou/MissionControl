import { describe, it, expect, vi, beforeEach } from "vitest";

const { gh, updateQa } = vi.hoisted(() => ({
  gh: {
    latestRunId: vi.fn(),
    runStatus: vi.fn(),
    runFailureSummary: vi.fn(),
    deleteBranch: vi.fn(),
    openPullRequest: vi.fn(),
    pullRequestState: vi.fn(),
  },
  updateQa: vi.fn(),
}));
vi.mock("../../tools/github-ci", () => gh);
vi.mock("../suggestions", () => ({ updateQa: (...a: unknown[]) => updateQa(...a), getSuggestion: vi.fn() }));
vi.mock("../memory", () => ({ logActivity: vi.fn() }));
vi.mock("../notify", () => ({ notify: vi.fn() }));
vi.mock("../usage", () => ({ withinBudget: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock("../../agents/fix-agent", () => ({ runFixAgent: vi.fn() }));

import { tick, goLive } from "../qa-loop";
import type { Suggestion } from "../types";

const base: Suggestion = {
  id: "abcdef123456", agent: "engineering", category: "bug", title: "Fix it", body: "details", priority: "high",
  status: "new", result: null, pr_url: null, outcome: null, qa_status: "testing", qa_branch: "qa/s-abcdef12",
  qa_run_id: "1", qa_attempts: 1, qa_log: null, created_at: "",
};

describe("QA loop: human-merge only", () => {
  beforeEach(() => { Object.values(gh).forEach((f) => f.mockReset()); updateQa.mockReset(); });

  it("on a passing QA run it opens a PR and does NOT merge", async () => {
    gh.latestRunId.mockResolvedValue("9");
    gh.runStatus.mockResolvedValue({ status: "completed", conclusion: "success" });
    gh.openPullRequest.mockResolvedValue({ ok: true, url: "https://github.com/o/r/pull/7" });
    const out = await tick(base);
    expect(out.qa_status).toBe("passed");
    expect(out.pr_url).toBe("https://github.com/o/r/pull/7");
    expect(gh.openPullRequest).toHaveBeenCalledWith("qa/s-abcdef12", expect.any(String), expect.stringMatching(/Human review required/));
    expect(updateQa).toHaveBeenCalledWith(base.id, expect.objectContaining({ qa_status: "passed", pr_url: "https://github.com/o/r/pull/7" }));
  });

  it("if the PR cannot be opened, it hands back to the owner", async () => {
    gh.latestRunId.mockResolvedValue("9");
    gh.runStatus.mockResolvedValue({ status: "completed", conclusion: "success" });
    gh.openPullRequest.mockResolvedValue({ ok: false, detail: "403" });
    expect((await tick(base)).qa_status).toBe("needs_owner");
  });

  it("'I merged it' only checks GitHub — refuses while the PR is still open", async () => {
    gh.pullRequestState.mockResolvedValue({ state: "open", detail: "PR is open." });
    const r = await goLive({ ...base, qa_status: "passed", pr_url: "https://github.com/o/r/pull/7" });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/Not merged yet/);
  });

  it("'I merged it' succeeds once the owner merged on GitHub", async () => {
    gh.pullRequestState.mockResolvedValue({ state: "merged", detail: "PR merged." });
    expect((await goLive({ ...base, qa_status: "passed", pr_url: "https://github.com/o/r/pull/7" })).ok).toBe(true);
  });

  it("refuses when no PR exists", async () => {
    expect((await goLive({ ...base, qa_status: "passed", pr_url: null })).ok).toBe(false);
  });
});
