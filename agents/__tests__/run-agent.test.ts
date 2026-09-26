import { describe, it, expect, vi, beforeEach } from "vitest";

const { runFreeLoop } = vi.hoisted(() => ({ runFreeLoop: vi.fn() }));
vi.mock("../free-loop", () => ({ runFreeLoop }));
vi.mock("../../lib/supabase", () => ({ supabaseAdmin: {} }));
vi.mock("../../lib/memory", () => ({ writeMemory: vi.fn(), recentMemory: vi.fn().mockResolvedValue([]), logActivity: vi.fn() }));
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
});
