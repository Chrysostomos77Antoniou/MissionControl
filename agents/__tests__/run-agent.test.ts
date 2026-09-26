import { describe, it, expect, vi, beforeEach } from "vitest";

const { runFreeLoop, writeMemory } = vi.hoisted(() => ({ runFreeLoop: vi.fn(), writeMemory: vi.fn() }));
vi.mock("../free-loop", () => ({ runFreeLoop }));
vi.mock("../../lib/supabase", () => ({ supabaseAdmin: {} }));
vi.mock("../../lib/memory", () => ({ writeMemory: (...a: unknown[]) => writeMemory(...a), recentMemory: vi.fn().mockResolvedValue([]), logActivity: vi.fn() }));
vi.mock("../../lib/suggestions", () => ({
  openSuggestionsForAgent: vi.fn().mockResolvedValue([]),
  allOpenSuggestionsDigest: vi.fn().mockResolvedValue([]),
  suggestionsSince: vi.fn().mockResolvedValue([]),
  saveSuggestion: vi.fn(),
}));
vi.mock("../../lib/usage", () => ({ withinBudget: vi.fn().mockResolvedValue({ ok: true, detail: "" }) }));
vi.mock("../../lib/lock", () => ({ acquireAgentLock: vi.fn().mockResolvedValue(true), releaseAgentLock: vi.fn() }));
vi.mock("../../lib/health", () => ({ alertIfCredentialsBroken: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../lib/consensus", () => ({ reviewCycleConsensus: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../lib/evals", () => ({ gradeAgentRun: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../lib/anthropic", () => {
  throw new Error("the migrated agent path must not load lib/anthropic");
});
vi.mock("../run-loop", () => {
  throw new Error("the migrated agent path must not load the legacy Anthropic loop");
});

import { runOne } from "../run-agent";
import { AGENTS, AGENT_BY_ID } from "../registry";
import { AGENT_TIER } from "../agent-tiers";
import { toolsFor } from "../../tools/registry";

beforeEach(() => {
  runFreeLoop.mockReset();
  writeMemory.mockReset();
  runFreeLoop.mockResolvedValue({ text: "cycle summary", toolOutputs: [] });
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
    runFreeLoop.mockResolvedValue({ text: "Engagement is 6% across 19 existing users.", toolOutputs: ["[{\"users\":19}]"] });
    const text = await runOne("growth");
    const stored = writeMemory.mock.calls[0][1] as string;
    expect(writeMemory).toHaveBeenCalledTimes(1);
    expect(stored).toBe("[⚠ figures marked [unverified] were not in this cycle's data] Engagement is 6% [unverified] across 19 existing users.");
    expect(text).toBe("Engagement is 6% across 19 existing users."); // the caller still gets the raw text
  });

  it("16. memory: a fully verified summary is stored unchanged", async () => {
    runFreeLoop.mockResolvedValue({ text: "2 of 19 users active (10.5%).", toolOutputs: ["[{\"users\":19,\"active\":2}]"] });
    await runOne("growth");
    expect(writeMemory).toHaveBeenCalledWith("growth", "2 of 19 users active (10.5%).");
  });
});
