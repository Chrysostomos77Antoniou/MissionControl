import { describe, it, expect, vi, beforeEach } from "vitest";

const { runFreeLoop, writeMemory, logActivity, acquireAgentLock, releaseAgentLock, gradeAgentRun, resolveFootRankCommit, loadFindingHistory } = vi.hoisted(() => ({
  resolveFootRankCommit: vi.fn(),
  loadFindingHistory: vi.fn(),
  runFreeLoop: vi.fn(),
  writeMemory: vi.fn(),
  logActivity: vi.fn(),
  acquireAgentLock: vi.fn(),
  releaseAgentLock: vi.fn(),
  gradeAgentRun: vi.fn(),
}));
vi.mock("../free-loop", () => ({ runFreeLoop }));
vi.mock("../../tools/github-read", async (orig) => ({
  ...(await orig<typeof import("../../tools/github-read")>()),
  resolveFootRankCommit: (...a: unknown[]) => resolveFootRankCommit(...a),
}));
vi.mock("../../lib/supabase", () => ({ supabaseAdmin: {} }));
vi.mock("../../lib/memory", () => ({ writeMemory: (...a: unknown[]) => writeMemory(...a), recentMemory: vi.fn().mockResolvedValue([]), logActivity: (...a: unknown[]) => logActivity(...a) }));
vi.mock("../../lib/suggestions", () => ({
  openSuggestionsForAgent: vi.fn().mockResolvedValue([]),
  allOpenSuggestionsDigest: vi.fn().mockResolvedValue([]),
  suggestionsSince: vi.fn().mockResolvedValue([]),
  saveSuggestion: vi.fn(),
}));
vi.mock("../../lib/usage", () => ({ withinBudget: vi.fn().mockResolvedValue({ ok: true, detail: "" }) }));
vi.mock("../../lib/lock", () => ({ acquireAgentLock: (...a: unknown[]) => acquireAgentLock(...a), releaseAgentLock: (...a: unknown[]) => releaseAgentLock(...a) }));
vi.mock("../../lib/health", () => ({ alertIfCredentialsBroken: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../lib/consensus", () => ({ reviewCycleConsensus: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../lib/evals", () => ({ gradeAgentRun: (...a: unknown[]) => gradeAgentRun(...a) }));
vi.mock("../../lib/finding-history", async (orig) => ({
  ...(await orig<typeof import("../../lib/finding-history")>()),
  loadFindingHistory: (...a: unknown[]) => loadFindingHistory(...a),
}));
vi.mock("../../lib/anthropic", () => {
  throw new Error("the migrated agent path must not load lib/anthropic");
});
vi.mock("../run-loop", () => {
  throw new Error("the migrated agent path must not load the legacy Anthropic loop");
});

import { runAgent, runAgentDetailed } from "../run-agent";
import { AGENTS, AGENT_BY_ID } from "../registry";
import type { AgentId } from "../../lib/types";
import { AGENT_TIER } from "../agent-tiers";
import { toolsFor } from "../../tools/registry";

const runOne = (id: AgentId) => runAgent(AGENT_BY_ID[id]);

beforeEach(() => {
  runFreeLoop.mockReset();
  writeMemory.mockReset();
  runFreeLoop.mockResolvedValue({ text: "cycle summary", toolOutputs: [], status: "ok" });
  logActivity.mockReset();
  logActivity.mockResolvedValue(undefined);
  acquireAgentLock.mockReset();
  acquireAgentLock.mockResolvedValue({ status: "acquired", token: "2026-09-26T10:00:00.000Z" });
  releaseAgentLock.mockReset();
  releaseAgentLock.mockResolvedValue(true);
  gradeAgentRun.mockReset();
  gradeAgentRun.mockResolvedValue(undefined);
  resolveFootRankCommit.mockReset();
  resolveFootRankCommit.mockResolvedValue({ ok: false, reason: "GITHUB_REPO / GITHUB_TOKEN not set" });
  loadFindingHistory.mockReset();
  loadFindingHistory.mockRejectedValue(new Error("no database in tests"));
});

describe("run-agent on the free loop", () => {
  it("every agent has an explicit tier; only cybersecurity is 'high'", () => {
    for (const a of AGENTS) expect(["simple", "medium", "high"]).toContain(AGENT_TIER[a.id]);
    expect(Object.entries(AGENT_TIER).filter(([, t]) => t === "high").map(([a]) => a)).toEqual(["cybersecurity"]);
  });

  it.each(AGENTS.map((a) => a.id))("1/2/3. %s runs through the free loop with its tier, prompt, tools and 16-turn cap", async (id) => {
    const text = await runOne(id);
    expect(text).toBe("cycle summary");
    expect(runFreeLoop).toHaveBeenCalledTimes(1);
    const o = runFreeLoop.mock.calls[0][0];
    expect(o.agent).toBe(id);
    expect(o.tier).toBe(AGENT_TIER[id]);
    expect(o.system).toBe(AGENT_BY_ID[id].system);
    expect(o.tools).toEqual(toolsFor(id));
    expect(o.maxTurns).toBe(16);
    expect(o.userMessage).toMatch(/Run your review now per your standard procedure\.$/);
    expect(Object.keys(o).sort()).toEqual(["agent", "maxTurns", "system", "tier", "tools", "userMessage"]);
  });

  it("15. memory: a summary with figures not in this cycle's data is stored annotated, not as fact", async () => {
    runFreeLoop.mockResolvedValue({ text: "Engagement is 6% across 19 existing users.", toolOutputs: ["[{\"users\":19}]"], status: "ok" });
    const text = await runOne("growth");
    const stored = writeMemory.mock.calls[0][1] as string;
    expect(writeMemory).toHaveBeenCalledTimes(1);
    expect(stored).toBe("[⚠ figures marked [unverified] were not in this cycle's data] Engagement is 6% [unverified] across 19 existing users.");
    expect(text).toBe("Engagement is 6% across 19 existing users."); // the caller still gets the raw text
  });

  it("16. memory: a fully verified summary is stored unchanged", async () => {
    runFreeLoop.mockResolvedValue({ text: "2 of 19 users active (10.5%).", toolOutputs: ["[{\"users\":19,\"active\":2}]"], status: "ok" });
    await runOne("growth");
    expect(writeMemory).toHaveBeenCalledWith("growth", "2 of 19 users active (10.5%).");
  });

  describe("memory hygiene (6a)", () => {
    it.each([
      ["stopped", "free-ai-unavailable", "⚠ Agent error: free AI unavailable — FREE_AI_QUOTA_EXHAUSTED: …"],
      ["stopped", "deadline", "⚠ Agent stopped: time limit reached before the run finished."],
      ["stopped", "tool-error:save_suggestion", "⚠ Agent stopped: save_suggestion failed (insert failed)."],
      ["max_turns", undefined, "Reached max turns."],
    ])("status %s (%s) writes NO memory and logs why", async (status, detail, text) => {
      runFreeLoop.mockResolvedValue({ text, toolOutputs: ["Saved to the owner's suggestions inbox."], status, ...(detail ? { detail } : {}) });
      const out = await runOne("growth");
      expect(out).toBe(text); // the caller still sees what happened
      expect(writeMemory).not.toHaveBeenCalled();
      expect(logActivity).toHaveBeenCalledWith("growth", "memory:skipped", `loop ${status}${detail ? ` (${detail})` : ""}`);
    });

    it("a successful (ok) conclusion still goes through the claim guard into memory", async () => {
      runFreeLoop.mockResolvedValue({ text: "Engagement is 6%.", toolOutputs: [], status: "ok" });
      await runOne("growth");
      expect(writeMemory).toHaveBeenCalledWith("growth", "[⚠ figures marked [unverified] were not in this cycle's data] Engagement is 6% [unverified].");
      expect(logActivity).not.toHaveBeenCalledWith("growth", "memory:skipped", expect.anything());
    });
  });

  describe("run lock (6a)", () => {
    it("contention: another run holds the lock -> skipped, nothing runs", async () => {
      acquireAgentLock.mockResolvedValue({ status: "held" });
      expect(await runOne("growth")).toBe("Skipped — already running.");
      expect(runFreeLoop).not.toHaveBeenCalled();
      expect(releaseAgentLock).not.toHaveBeenCalled();
      expect(logActivity).toHaveBeenCalledWith("growth", "cycle:skipped-overlap", expect.any(String));
    });

    it("a lock/database error is NOT treated as contention -> nothing runs, logged as a lock error", async () => {
      acquireAgentLock.mockResolvedValue({ status: "error", detail: "connection refused" });
      expect(await runOne("growth")).toBe("⚠ Skipped — could not verify the run lock (connection refused). Nothing was run.");
      expect(runFreeLoop).not.toHaveBeenCalled();
      expect(logActivity).toHaveBeenCalledWith("growth", "cycle:lock-error", "connection refused");
      expect(logActivity).not.toHaveBeenCalledWith("growth", "cycle:skipped-overlap", expect.anything());
    });

    it("releases with its own owner token, also when the loop throws", async () => {
      runFreeLoop.mockRejectedValue(new Error("boom"));
      await expect(runOne("growth")).rejects.toThrow("boom");
      expect(releaseAgentLock).toHaveBeenCalledWith("growth", "2026-09-26T10:00:00.000Z");
      expect(writeMemory).not.toHaveBeenCalled();
    });

    it("logs when the lock could not be released (expired and taken over)", async () => {
      releaseAgentLock.mockResolvedValue(false);
      await runOne("growth");
      expect(logActivity).toHaveBeenCalledWith("growth", "lock:not-released", expect.any(String));
    });
  });

  describe("run result + grader (6b)", () => {
    it("runAgentDetailed reports the loop outcome and stop reason", async () => {
      runFreeLoop.mockResolvedValue({ text: "⚠ Agent error: free AI unavailable — x", toolOutputs: [], status: "stopped", detail: "free-ai-unavailable" });
      expect(await runAgentDetailed(AGENT_BY_ID.growth)).toEqual({ outcome: "stopped", text: "⚠ Agent error: free AI unavailable — x", detail: "free-ai-unavailable" });
      runFreeLoop.mockResolvedValue({ text: "done", toolOutputs: [], status: "ok" });
      expect(await runAgentDetailed(AGENT_BY_ID.growth)).toEqual({ outcome: "ok", text: "done" });
    });

    it("lock contention and lock errors are distinct outcomes", async () => {
      acquireAgentLock.mockResolvedValue({ status: "held" });
      expect((await runAgentDetailed(AGENT_BY_ID.growth)).outcome).toBe("skipped-overlap");
      acquireAgentLock.mockResolvedValue({ status: "error", detail: "db down" });
      expect(await runAgentDetailed(AGENT_BY_ID.growth)).toMatchObject({ outcome: "lock-error", detail: "db down" });
    });

    it("a stopped run is not graded (no extra LLM call right after the providers failed)", async () => {
      runFreeLoop.mockResolvedValue({ text: "x", toolOutputs: [], status: "stopped", detail: "free-ai-unavailable" });
      await runOne("growth");
      expect(gradeAgentRun).not.toHaveBeenCalled();
    });

    it.each(["ok", "max_turns"])("a %s run is still graded", async (status) => {
      runFreeLoop.mockResolvedValue({ text: "x", toolOutputs: [], status });
      await runOne("growth");
      expect(gradeAgentRun).toHaveBeenCalledTimes(1);
    });

    it("run-agent no longer exports group/single runners (all runs go through agents/cycle.ts)", async () => {
      const mod = await import("../run-agent");
      expect(Object.keys(mod).sort()).toEqual(["runAgent", "runAgentDetailed"]);
    });
  });

  describe("pinned FootRank commit (7a)", () => {
    const PIN = "27e1e5ac5a89cb9d5f5cb7ca6a1368afa0582a46";

    it.each(["cybersecurity", "engineering", "developer", "qa", "uxdesign", "devops", "legal"] as const)(
      "%s: the commit is resolved exactly once at run start and handed to the loop",
      async (id) => {
        resolveFootRankCommit.mockResolvedValue({ ok: true, sha: PIN });
        await runOne(id);
        expect(resolveFootRankCommit).toHaveBeenCalledTimes(1);
        expect(resolveFootRankCommit.mock.invocationCallOrder[0]).toBeLessThan(runFreeLoop.mock.invocationCallOrder[0]);
        expect(runFreeLoop.mock.calls[0][0].codeCommit).toBe(PIN);
      },
    );

    it.each(["marketing", "growth", "community", "competitive", "copywriter"] as const)("%s (no code tools): nothing is resolved or pinned", async (id) => {
      resolveFootRankCommit.mockResolvedValue({ ok: true, sha: PIN });
      await runOne(id);
      expect(resolveFootRankCommit).not.toHaveBeenCalled();
      expect(runFreeLoop.mock.calls[0][0]).not.toHaveProperty("codeCommit");
    });

    it("if the commit cannot be resolved, no pin is passed (code tools fail closed), it is logged, and the run continues", async () => {
      resolveFootRankCommit.mockResolvedValue({ ok: false, reason: "GitHub 503 while resolving the current commit" });
      expect(await runOne("engineering")).toBe("cycle summary");
      expect(runFreeLoop.mock.calls[0][0]).not.toHaveProperty("codeCommit");
      expect(logActivity).toHaveBeenCalledWith("engineering", "code:pin-failed", "GitHub 503 while resolving the current commit");
    });
  });

  describe("finding history (7b)", () => {
    const p = { family: "defect" as const, fp: null, symbol: "_propose", files: ["matches_page.dart"], anchors: [], terms: [] };
    const history = { entries: [
      { id: "1", source: "open" as const, agent: "qa", title: "Still open", createdAt: "2026-09-26T00:00:00Z", print: p },
      { id: "2", source: "dismissed" as const, agent: "developer", title: "Robust City Fallback for Match Filters", createdAt: "2026-09-26T21:47:33Z", print: p },
      { id: "3", source: "rejected" as const, agent: "developer", title: "Teams can propose with fewer than 5 players", createdAt: "2026-09-27T10:00:00Z", print: p, rejectCode: "contradicted" as const },
    ] };

    it("dismissed and gate-rejected findings are shown to the agent compactly and the history is handed to the loop", async () => {
      loadFindingHistory.mockResolvedValue(history);
      await runOne("developer");
      const o = runFreeLoop.mock.calls[0][0];
      expect(o.findingHistory).toBe(history);
      expect(o.userMessage).toContain("Findings recently DISMISSED by the owner or REJECTED by the evidence gate (last 90 days)");
      expect(o.userMessage).toContain("- [rejected by the evidence gate: contradicted] Teams can propose with fewer than 5 players (matches_page.dart › _propose)");
      expect(o.userMessage).toContain("- [dismissed by the owner] Robust City Fallback for Match Filters");
      expect(o.userMessage).not.toContain("Still open (matches_page");
    });

    it("if the history cannot be loaded the run continues without it (the first submission retries and fails closed)", async () => {
      await runOne("developer");
      const o = runFreeLoop.mock.calls[0][0];
      expect(o).not.toHaveProperty("findingHistory");
      expect(o.userMessage).not.toContain("REJECTED by the evidence gate");
    });
  });
});
