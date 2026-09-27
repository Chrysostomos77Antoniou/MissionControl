import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Module-level mocks: the real runAgentDetailed is exercised in the
// integration tests below with the free router mocked out.
const m = vi.hoisted(() => ({
  generate: vi.fn(),
  acquireAgentLock: vi.fn(),
  releaseAgentLock: vi.fn(),
  writeMemory: vi.fn(),
  logActivity: vi.fn(),
  saveSuggestion: vi.fn(),
  gradeAgentRun: vi.fn(),
}));
vi.mock("../../lib/free-llm", () => ({ freeLlm: { generate: m.generate } }));
vi.mock("../../lib/supabase", () => ({ supabaseAdmin: {} }));
vi.mock("../../lib/lock", async (orig) => ({
  ...(await orig<typeof import("../../lib/lock")>()),
  acquireAgentLock: m.acquireAgentLock,
  releaseAgentLock: m.releaseAgentLock,
}));
vi.mock("../../lib/memory", () => ({ writeMemory: m.writeMemory, recentMemory: vi.fn().mockResolvedValue([]), logActivity: m.logActivity }));
vi.mock("../../lib/suggestions", () => ({
  openSuggestionsForAgent: vi.fn().mockResolvedValue([]),
  allOpenSuggestionsDigest: vi.fn().mockResolvedValue([]),
  suggestionsSince: vi.fn().mockResolvedValue([]),
  saveSuggestion: m.saveSuggestion,
}));
vi.mock("../../lib/evals", () => ({ gradeAgentRun: m.gradeAgentRun }));
// 7b: finding history (duplicate check) comes from the database; empty here.
vi.mock("../../lib/finding-history", async (orig) => ({ ...(await orig<typeof import("../../lib/finding-history")>()), loadFindingHistory: vi.fn().mockResolvedValue({ entries: [] }) }));
// The real run path pins a FootRank commit at run start; keep it off the network.
vi.mock("../../tools/github-read", async (orig) => ({
  ...(await orig<typeof import("../../tools/github-read")>()),
  resolveFootRankCommit: async () => ({ ok: false, reason: "not configured in tests" }),
}));
vi.mock("../../lib/notify", () => ({ notify: vi.fn() }));
vi.mock("../../lib/usage", () => ({ withinBudget: vi.fn().mockResolvedValue({ ok: true, detail: "" }) }));
vi.mock("../../lib/health", () => ({ alertIfCredentialsBroken: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../lib/consensus", () => ({ reviewCycleConsensus: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../lib/anthropic", () => {
  throw new Error("cycles must not load lib/anthropic");
});
vi.mock("../run-loop", () => {
  throw new Error("cycles must not load the legacy loop");
});

import { runScheduledCycle, runManual, runOne, runGroup, defaultCycleDeps, CYCLE_START_WINDOW_MS, type CycleDeps } from "../cycle";
import * as runAgentModule from "../run-agent";
import { AGENT_TIER } from "../agent-tiers";
import { AGENT_BY_ID } from "../registry";
import { makeBaseline, buildSourceHashes, MAX_BASELINE_AGE_MS, type Baseline, type FootrankTotals, type OpenSuggestionState } from "../../lib/change-detect";
import { CYCLE_LOCK_TTL_MS, AGENT_LOCK_TTL_MS } from "../../lib/lock";
import type { AgentId } from "../../lib/types";
import type { AgentRunResult } from "../run-agent";

const T0 = new Date("2026-09-27T09:00:00.000Z");
const TOTALS: FootrankTotals = { users: 19, matches: 12, teams: 6, behavior_reports: 36, notifications: 373 };

function makeDeps(over: Partial<CycleDeps> = {}) {
  const state = {
    t: T0.getTime(),
    totals: { ...TOTALS } as FootrankTotals | null,
    open: new Map<AgentId, OpenSuggestionState[] | null>(),
    baselines: new Map<AgentId, Baseline>(),
    baselineReadError: new Set<AgentId>(),
    lockHeld: false,
  };
  const log = vi.fn<(agent: AgentId, action: string, detail: string) => Promise<void>>(async () => {});
  const deps: CycleDeps = {
    acquireCycleLock: vi.fn(async () => {
      if (state.lockHeld) return { status: "held" as const };
      state.lockHeld = true;
      return { status: "acquired" as const, token: "cycle-token" };
    }),
    releaseCycleLock: vi.fn(async (token: string) => {
      const ok = state.lockHeld && token === "cycle-token";
      state.lockHeld = false;
      return ok;
    }),
    runAgent: vi.fn(async (): Promise<AgentRunResult> => ({ outcome: "ok", text: "done" })),
    tierFor: (a) => AGENT_TIER[a],
    readTotals: vi.fn(async () => state.totals),
    readOpenSuggestions: vi.fn(async (a: AgentId) => (state.open.has(a) ? state.open.get(a)! : [])),
    readBaseline: vi.fn(async (a: AgentId) => (state.baselineReadError.has(a) ? { ok: false as const, detail: "timeout" } : { ok: true as const, baseline: state.baselines.get(a) ?? null })),
    writeBaseline: vi.fn(async (a: AgentId, b: Baseline) => {
      state.baselines.set(a, b);
      return true;
    }),
    preflight: vi.fn(async () => ({ ok: true, detail: "" })),
    consensus: vi.fn(async () => {}),
    log,
    now: () => new Date(state.t),
    ...over,
  };
  return { deps, state, log };
}

// A baseline equal to the agent's current inputs, taken at `atMs`.
function currentBaseline(state: ReturnType<typeof makeDeps>["state"], agent: AgentId, atMs = state.t): Baseline {
  const b = buildSourceHashes(agent, { totals: state.totals, openSuggestions: state.open.get(agent) ?? [] });
  if (!b.ok) throw new Error(b.detail);
  return makeBaseline(agent, b.sources, new Date(atMs));
}
const actions = (log: ReturnType<typeof makeDeps>["log"]) => log.mock.calls.map((c) => `${c[0]} ${c[1]}`);
const outcomes = (r: { agents: { agent: AgentId; outcome: string }[] }) => Object.fromEntries(r.agents.map((a) => [a.agent, a.outcome]));

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.acquireAgentLock.mockResolvedValue({ status: "acquired", token: "agent-token" });
  m.releaseAgentLock.mockResolvedValue(true);
  m.logActivity.mockResolvedValue(undefined);
  m.gradeAgentRun.mockResolvedValue(undefined);
});

describe("cycle lock", () => {
  it("is acquired first and released with its token afterwards", async () => {
    const { deps } = makeDeps();
    const r = await runScheduledCycle("4h", deps);
    expect(r.status).toBe("completed");
    expect(deps.acquireCycleLock).toHaveBeenCalledTimes(1);
    expect(deps.releaseCycleLock).toHaveBeenCalledWith("cycle-token");
  });

  it("overlap: a held cycle lock skips the whole cycle (not queued), reads nothing, runs nothing", async () => {
    const { deps, state, log } = makeDeps();
    state.lockHeld = true;
    const r = await runScheduledCycle("daily", deps);
    expect(r).toMatchObject({ status: "skipped-overlap", agents: [] });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.readBaseline).not.toHaveBeenCalled();
    expect(deps.releaseCycleLock).not.toHaveBeenCalled();
    expect(actions(log)).toEqual(["marketing cycle:skipped-overlap"]);
  });

  it("a lock/database error is not contention: nothing runs and it is logged as a lock error", async () => {
    const { deps, log } = makeDeps({ acquireCycleLock: vi.fn(async () => ({ status: "error" as const, detail: "connection refused" })) });
    const r = await runScheduledCycle("4h", deps);
    expect(r).toMatchObject({ status: "lock-error", detail: "connection refused" });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(actions(log)).toEqual(["cybersecurity cycle:lock-error"]);
  });

  it("two overlapping cycles: the second is skipped and no agent runs twice", async () => {
    const { deps } = makeDeps();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    (deps.runAgent as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await gate;
      return { outcome: "ok", text: "done" };
    });
    const first = runScheduledCycle("4h", deps);
    await new Promise((r) => setTimeout(r, 0));
    const second = await runScheduledCycle("4h", deps);
    expect(second.status).toBe("skipped-overlap");
    release();
    expect((await first).status).toBe("completed");
    expect(deps.runAgent).toHaveBeenCalledTimes(3); // cybersecurity, engineering, developer — once each
  });

  it("the lock is released even when an agent throws", async () => {
    const { deps } = makeDeps({ runAgent: vi.fn(async () => { throw new Error("boom"); }) });
    await runScheduledCycle("4h", deps);
    expect(deps.releaseCycleLock).toHaveBeenCalledWith("cycle-token");
  });

  it("the cycle start window keeps every started agent inside the cycle-lock TTL", async () => {
    expect(CYCLE_START_WINDOW_MS + AGENT_LOCK_TTL_MS).toBeLessThanOrEqual(CYCLE_LOCK_TTL_MS);
    const { deps, state } = makeDeps({
      runAgent: vi.fn(async () => {
        state.t += CYCLE_START_WINDOW_MS + 1;
        return { outcome: "ok" as const, text: "done" };
      }),
    });
    const r = await runScheduledCycle("daily", deps);
    expect(deps.runAgent).toHaveBeenCalledTimes(1);
    expect(outcomes(r)).toEqual({ marketing: "ran-ok", growth: "skipped-time", community: "skipped-time", devops: "skipped-time" });
  });
});

describe("due agents", () => {
  it.each([
    ["4h", ["cybersecurity", "engineering", "developer"]],
    ["daily", ["marketing", "growth", "community", "devops"]],
    ["5day", ["uxdesign", "competitive", "legal"]],
    ["hourly", []],
  ] as const)("group %s runs exactly the registry's agents for that cadence, in order", async (group, want) => {
    const { deps } = makeDeps();
    await runScheduledCycle(group, deps);
    expect((deps.runAgent as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(want);
  });

  it("on-demand agents (qa, copywriter) are never scheduled", async () => {
    const { deps } = makeDeps();
    for (const g of ["hourly", "4h", "daily", "5day"] as const) await runScheduledCycle(g, deps);
    const ran = (deps.runAgent as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(ran).not.toContain("qa");
    expect(ran).not.toContain("copywriter");
  });

  it("agents run strictly one at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { deps } = makeDeps({
      runAgent: vi.fn(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { outcome: "ok" as const, text: "done" };
      }),
    });
    await runScheduledCycle("daily", deps);
    expect(deps.runAgent).toHaveBeenCalledTimes(4);
    expect(maxInFlight).toBe(1);
  });
});

describe("change detection in scheduled cycles", () => {
  it("missing baseline -> runs, logs it, and writes a baseline only after the ok run", async () => {
    const { deps, state, log } = makeDeps();
    const r = await runScheduledCycle("daily", deps);
    expect(deps.runAgent).toHaveBeenCalledTimes(4);
    expect(actions(log)).toContain("growth cycle:baseline-missing");
    expect(outcomes(r).growth).toBe("ran-ok");
    expect(state.baselines.get("growth")).toEqual(currentBaseline(state, "growth", T0.getTime()));
  });

  it("unchanged inputs + young baseline -> skipped: no agent run, no baseline write, no consensus", async () => {
    const { deps, state, log } = makeDeps();
    for (const a of ["cybersecurity", "engineering", "developer"] as const) state.baselines.set(a, currentBaseline(state, a));
    state.t += 60 * 60 * 1000;
    const r = await runScheduledCycle("4h", deps);
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.writeBaseline).not.toHaveBeenCalled();
    expect(deps.consensus).not.toHaveBeenCalled();
    expect(Object.values(outcomes(r))).toEqual(["skipped-no-change", "skipped-no-change", "skipped-no-change"]);
    expect(actions(log).filter((a) => a.endsWith("cycle:agent-skipped-no-change"))).toHaveLength(3);
  });

  it("changed FootRank totals -> the totals agents run; others (no totals source) are unaffected", async () => {
    const { deps, state } = makeDeps();
    for (const a of ["marketing", "growth", "community", "devops", "engineering"] as const) state.baselines.set(a, currentBaseline(state, a));
    state.totals = { ...TOTALS, users: 20 };
    state.t += 1000;
    const daily = await runScheduledCycle("daily", deps);
    expect(Object.values(outcomes(daily))).toEqual(["ran-ok", "ran-ok", "ran-ok", "ran-ok"]);
    expect(daily.agents[0].reason).toBe("changed:footrank_totals");
    (deps.readTotals as ReturnType<typeof vi.fn>).mockClear();
    const fourH = await runScheduledCycle("4h", deps);
    expect(outcomes(fourH).engineering).toBe("skipped-no-change");
    expect(deps.readTotals).not.toHaveBeenCalled(); // not queried for agents that don't use it
  });

  it("changed open suggestions -> that agent runs", async () => {
    const { deps, state } = makeDeps();
    for (const a of ["cybersecurity", "engineering", "developer"] as const) state.baselines.set(a, currentBaseline(state, a));
    state.open.set("engineering", [{ id: "s1", status: "new", priority: "high", title: "owner reopened this" }]);
    const r = await runScheduledCycle("4h", deps);
    expect(outcomes(r)).toEqual({ cybersecurity: "skipped-no-change", engineering: "ran-ok", developer: "skipped-no-change" });
    expect(r.agents[1].reason).toBe("changed:open_suggestions");
  });

  it("an agent's OWN new suggestions do not trigger it again next cycle (baseline re-reads them after the run)", async () => {
    const { deps, state } = makeDeps({
      runAgent: vi.fn(async (a: AgentId) => {
        state.open.set(a, [{ id: `new-${a}`, status: "new", priority: "medium", title: "saved this run" }]);
        return { outcome: "ok" as const, text: "done" };
      }),
    });
    await runScheduledCycle("4h", deps);
    state.t += 4 * 60 * 60 * 1000;
    const next = await runScheduledCycle("4h", deps);
    expect(Object.values(outcomes(next))).toEqual(["skipped-no-change", "skipped-no-change", "skipped-no-change"]);
  });

  it("stale baseline (7+ days) -> runs even though nothing changed, and the baseline is refreshed after ok", async () => {
    const { deps, state } = makeDeps();
    state.baselines.set("legal", currentBaseline(state, "legal", T0.getTime()));
    state.baselines.set("uxdesign", currentBaseline(state, "uxdesign", T0.getTime()));
    state.baselines.set("competitive", currentBaseline(state, "competitive", T0.getTime()));
    state.t = T0.getTime() + MAX_BASELINE_AGE_MS;
    const r = await runScheduledCycle("5day", deps);
    expect(Object.values(outcomes(r))).toEqual(["ran-ok", "ran-ok", "ran-ok"]);
    expect(r.agents[0].reason).toBe("stale");
    expect(state.baselines.get("legal")!.at).toBe(new Date(state.t).toISOString());
  });

  it("just under 7 days with no change -> still skipped", async () => {
    const { deps, state } = makeDeps();
    state.baselines.set("legal", currentBaseline(state, "legal", T0.getTime()));
    state.t = T0.getTime() + MAX_BASELINE_AGE_MS - 1;
    const r = await runScheduledCycle("5day", deps);
    expect(outcomes(r).legal).toBe("skipped-no-change");
  });

  it.each<[string, AgentRunResult | "throw"]>([
    ["stopped (free AI unavailable)", { outcome: "stopped", text: "x", detail: "free-ai-unavailable" }],
    ["stopped (deadline)", { outcome: "stopped", text: "x", detail: "deadline" }],
    ["stopped (tool failure)", { outcome: "stopped", text: "x", detail: "tool-error:save_suggestion" }],
    ["max_turns", { outcome: "max_turns", text: "Reached max turns." }],
    ["agent lock held", { outcome: "skipped-overlap", text: "Skipped" }],
    ["agent lock error", { outcome: "lock-error", text: "x", detail: "db" }],
    ["thrown error", "throw"],
  ])("%s -> the old baseline is kept (never updated)", async (_label, result) => {
    const { deps, state } = makeDeps({
      runAgent: vi.fn(async () => {
        if (result === "throw") throw new Error("process died");
        return result;
      }),
    });
    const old = currentBaseline(state, "legal", T0.getTime());
    state.baselines.set("legal", old);
    state.t = T0.getTime() + MAX_BASELINE_AGE_MS + 1; // stale -> eligible
    await runScheduledCycle("5day", deps);
    expect(deps.writeBaseline).not.toHaveBeenCalled();
    expect(state.baselines.get("legal")).toBe(old);
  });

  it("a failed first run writes no baseline, so the agent stays eligible next cycle", async () => {
    const { deps, state } = makeDeps({ runAgent: vi.fn(async () => ({ outcome: "max_turns" as const, text: "Reached max turns." })) });
    await runScheduledCycle("4h", deps);
    expect(state.baselines.size).toBe(0);
    const again = await runScheduledCycle("4h", deps);
    expect(deps.runAgent).toHaveBeenCalledTimes(6);
    expect(again.agents.every((a) => a.reason === "missing")).toBe(true);
  });

  it("detection failure (a required source unreadable) -> agent skipped, logged, baseline untouched — never 'unchanged'", async () => {
    const { deps, state, log } = makeDeps();
    for (const a of ["marketing", "growth", "community", "devops"] as const) state.baselines.set(a, currentBaseline(state, a));
    state.totals = null;
    const r = await runScheduledCycle("daily", deps);
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.writeBaseline).not.toHaveBeenCalled();
    expect(Object.values(outcomes(r))).toEqual(["skipped-detect-failed", "skipped-detect-failed", "skipped-detect-failed", "skipped-detect-failed"]);
    expect(actions(log)).toContain("growth cycle:detect-failed");
    expect(actions(log).some((a) => a.endsWith("no-change"))).toBe(false);
  });

  it("detection failure with NO baseline is still a skip (unknown source beats missing baseline)", async () => {
    const { deps, state } = makeDeps();
    state.totals = null;
    const r = await runScheduledCycle("daily", deps);
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(outcomes(r).growth).toBe("skipped-detect-failed");
  });

  it("an unreadable baseline or open-suggestion list is a detection failure too", async () => {
    const { deps, state } = makeDeps();
    state.baselineReadError.add("engineering");
    state.open.set("developer", null);
    const r = await runScheduledCycle("4h", deps);
    expect(outcomes(r)).toEqual({ cybersecurity: "ran-ok", engineering: "skipped-detect-failed", developer: "skipped-detect-failed" });
    expect((deps.runAgent as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(["cybersecurity"]);
  });

  it("a baseline that cannot be written is logged; the agent simply stays eligible", async () => {
    const { deps, log } = makeDeps({ writeBaseline: vi.fn(async () => false) });
    await runScheduledCycle("4h", deps);
    expect(actions(log)).toContain("engineering cycle:baseline-write-failed");
  });

  it("if open suggestions can't be re-read after an ok run, no baseline is written", async () => {
    const { deps, state, log } = makeDeps({
      runAgent: vi.fn(async (a: AgentId) => {
        state.open.set(a, null);
        return { outcome: "ok" as const, text: "done" };
      }),
    });
    await runScheduledCycle("4h", deps);
    expect(deps.writeBaseline).not.toHaveBeenCalled();
    expect(actions(log)).toContain("engineering cycle:baseline-skipped");
  });

  it("one agent failing does not stop later eligible agents", async () => {
    const { deps } = makeDeps({
      runAgent: vi.fn(async (a: AgentId) => {
        if (a === "marketing") throw new Error("boom");
        return { outcome: "ok" as const, text: "done" };
      }),
    });
    const r = await runScheduledCycle("daily", deps);
    expect(outcomes(r)).toEqual({ marketing: "error", growth: "ran-ok", community: "ran-ok", devops: "ran-ok" });
  });

  it("a budget/preflight refusal runs nothing", async () => {
    const { deps } = makeDeps({ preflight: vi.fn(async () => ({ ok: false, detail: "Daily cap reached" })) });
    const r = await runScheduledCycle("daily", deps);
    expect(r).toMatchObject({ status: "skipped-budget", agents: [] });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.releaseCycleLock).toHaveBeenCalled();
  });

  it("consensus runs once, only over agents that actually ran", async () => {
    const { deps, state } = makeDeps();
    state.baselines.set("cybersecurity", currentBaseline(state, "cybersecurity"));
    await runScheduledCycle("4h", deps);
    expect(deps.consensus).toHaveBeenCalledTimes(1);
    expect(deps.consensus).toHaveBeenCalledWith(["engineering", "developer"], T0.toISOString());
  });

  it("logs cycle:started and cycle:completed with a deterministic summary", async () => {
    const { deps, log } = makeDeps();
    await runScheduledCycle("4h", deps);
    expect(log).toHaveBeenCalledWith("cybersecurity", "cycle:started", "scheduled 4h: 3 agent(s), one at a time");
    expect(log).toHaveBeenCalledWith("cybersecurity", "cycle:completed", "scheduled 4h: ok 3, unchanged 0, failed 0");
  });
});

describe("free-AI exhaustion", () => {
  it("once a tier's free AI is unavailable, later agents on that tier are not started (no repeated attempts)", async () => {
    const { deps, log } = makeDeps({ runAgent: vi.fn(async () => ({ outcome: "stopped" as const, text: "⚠", detail: "free-ai-unavailable" })) });
    const r = await runScheduledCycle("daily", deps);
    expect(deps.runAgent).toHaveBeenCalledTimes(1);
    expect(outcomes(r)).toEqual({ marketing: "ran-stopped", growth: "skipped-exhausted", community: "skipped-exhausted", devops: "skipped-exhausted" });
    expect(actions(log)).toContain("growth cycle:agent-skipped-exhausted");
    expect(deps.writeBaseline).not.toHaveBeenCalled();
  });

  it("cybersecurity (high tier, no Gemini key) stopping does not block medium-tier agents that can still run", async () => {
    const { deps } = makeDeps({
      runAgent: vi.fn(async (a: AgentId) => (a === "cybersecurity" ? { outcome: "stopped" as const, text: "⚠", detail: "free-ai-unavailable" } : { outcome: "ok" as const, text: "done" })),
    });
    const r = await runScheduledCycle("4h", deps);
    expect(outcomes(r)).toEqual({ cybersecurity: "ran-stopped", engineering: "ran-ok", developer: "ran-ok" });
    expect(AGENT_TIER.cybersecurity).toBe("high");
  });

  it("other stop reasons (deadline) do not mark the tier exhausted", async () => {
    const { deps } = makeDeps({ runAgent: vi.fn(async () => ({ outcome: "stopped" as const, text: "⚠", detail: "deadline" })) });
    await runScheduledCycle("daily", deps);
    expect(deps.runAgent).toHaveBeenCalledTimes(4);
  });
});

describe("manual runs (explicit human request)", () => {
  it("bypass change detection only: an unchanged agent still runs, no detection reads, no baseline write", async () => {
    const { deps, state } = makeDeps();
    state.baselines.set("growth", currentBaseline(state, "growth"));
    const r = await runManual(["growth"], deps);
    expect(outcomes(r)).toEqual({ growth: "ran-ok" });
    expect(r.agents[0]).toMatchObject({ reason: "manual", text: "done" });
    expect(deps.readBaseline).not.toHaveBeenCalled();
    expect(deps.readTotals).not.toHaveBeenCalled();
    expect(deps.writeBaseline).not.toHaveBeenCalled();
  });

  it("still take the cycle lock: a manual run during a cycle is skipped, not run in parallel", async () => {
    const { deps, state } = makeDeps();
    state.lockHeld = true;
    expect((await runManual(["growth"], deps)).status).toBe("skipped-overlap");
    expect(await runOne("growth", deps)).toBe("Skipped — another agent run is in progress. Try again when it finishes.");
    expect(deps.runAgent).not.toHaveBeenCalled();
  });

  it('"all" is one sequential run of the 10 scheduled agents (on-demand ones excluded), never parallel', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { deps } = makeDeps({
      runAgent: vi.fn(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return { outcome: "ok" as const, text: "done" };
      }),
    });
    const r = await runGroup("all", deps);
    expect(r.agents.map((a) => a.agent)).toEqual(["cybersecurity", "engineering", "developer", "uxdesign", "marketing", "growth", "community", "competitive", "devops", "legal"]);
    expect(maxInFlight).toBe(1);
    expect(deps.acquireCycleLock).toHaveBeenCalledTimes(1);
  });

  it("still respect free-AI exhaustion and one-agent-failure isolation", async () => {
    const { deps } = makeDeps({ runAgent: vi.fn(async () => ({ outcome: "stopped" as const, text: "⚠", detail: "free-ai-unavailable" })) });
    const r = await runGroup("daily", deps);
    expect(deps.runAgent).toHaveBeenCalledTimes(1);
    expect(outcomes(r).growth).toBe("skipped-exhausted");
  });

  it("runOne returns the agent's reply; unknown ids are ignored", async () => {
    const { deps } = makeDeps();
    expect(await runOne("marketing", deps)).toBe("done");
    expect((await runManual(["nope" as AgentId, "growth", "growth"], deps)).agents.map((a) => a.agent)).toEqual(["growth"]);
  });

  it("scheduled responses never carry model output; manual ones carry only the agent's reply", async () => {
    const { deps } = makeDeps();
    const s = await runScheduledCycle("4h", deps);
    expect(s.agents.every((a) => !("text" in a))).toBe(true);
  });
});

describe("real run path (router mocked): no-change means zero LLM calls", () => {
  const realDeps = (over: Partial<CycleDeps> = {}) => makeDeps({ runAgent: (a) => runAgentModule.runAgentDetailed(AGENT_BY_ID[a]), ...over });

  it("an unchanged agent produces ZERO router calls, zero memory writes and no grader", async () => {
    const { deps, state } = realDeps();
    for (const a of ["cybersecurity", "engineering", "developer"] as const) state.baselines.set(a, currentBaseline(state, a));
    await runScheduledCycle("4h", deps);
    expect(m.generate).not.toHaveBeenCalled();
    expect(m.writeMemory).not.toHaveBeenCalled();
    expect(m.gradeAgentRun).not.toHaveBeenCalled();
    expect(m.acquireAgentLock).not.toHaveBeenCalled();
  });

  it("a changed agent goes through the agent lock and the free router (only)", async () => {
    m.generate.mockResolvedValue({ text: "All good.", toolCalls: [], stopReason: "end", usage: {}, provider: "ollama", model: "qwen3.5:4b", tier: "medium", cost: 0, attempts: [] });
    const { deps } = realDeps();
    const r = await runManual(["growth"], deps);
    expect(outcomes(r)).toEqual({ growth: "ran-ok" });
    expect(m.acquireAgentLock).toHaveBeenCalledWith("growth");
    expect(m.generate).toHaveBeenCalledTimes(1);
    expect(m.generate.mock.calls[0][0]).toBe("medium");
    expect(m.writeMemory).toHaveBeenCalledWith("growth", "All good.");
  });

  it("exhausted free AI: the router is tried once for the first agent, never again for the rest of the tier", async () => {
    m.generate.mockRejectedValue(new Error("FREE_AI_QUOTA_EXHAUSTED: no approved free provider could serve this medium request. Stopping — no paid fallback exists."));
    const { deps } = realDeps();
    const r = await runScheduledCycle("daily", deps);
    expect(m.generate).toHaveBeenCalledTimes(1);
    expect(m.gradeAgentRun).not.toHaveBeenCalled();
    expect(m.writeMemory).not.toHaveBeenCalled();
    expect(outcomes(r)).toEqual({ marketing: "ran-stopped", growth: "skipped-exhausted", community: "skipped-exhausted", devops: "skipped-exhausted" });
  });

  it("the claim guard stays in place: an unverified figure is marked and the high-priority alert suppressed", async () => {
    const notify = (await import("../../lib/notify")).notify as unknown as ReturnType<typeof vi.fn>;
    notify.mockReset();
    m.generate
      .mockResolvedValueOnce({ text: "", toolCalls: [{ id: "c0", name: "save_suggestion", input: { class: "product_idea", title: "Engagement is 6%", claim: "b", impact: "i", proposed_change: "p", priority: "high" } }], stopReason: "tool_calls", usage: {}, provider: "ollama", model: "qwen3.5:4b", tier: "medium", cost: 0, attempts: [] })
      .mockResolvedValueOnce({ text: "Engagement is 6%.", toolCalls: [], stopReason: "end", usage: {}, provider: "ollama", model: "qwen3.5:4b", tier: "medium", cost: 0, attempts: [] });
    const { deps } = realDeps();
    await runManual(["growth"], deps);
    expect(m.saveSuggestion.mock.calls[0][0].title).toBe("[Idea] Engagement is 6% [unverified]");
    expect(m.saveSuggestion.mock.calls[0][0].priority).toBe("low"); // 7b: ideas are never high priority
    expect(notify).not.toHaveBeenCalled();
    expect(m.writeMemory.mock.calls[0][1]).toMatch(/6% \[unverified\]/);
  });
});

describe("default wiring + static safety", () => {
  it("the default runner is the real agent path (agent lock -> free router -> guarded memory)", async () => {
    m.generate.mockResolvedValue({ text: "Nothing new.", toolCalls: [], stopReason: "end", usage: {}, provider: "ollama", model: "qwen3.5:4b", tier: "medium", cost: 0, attempts: [] });
    expect(await defaultCycleDeps.runAgent("devops")).toEqual({ outcome: "ok", text: "Nothing new." });
    expect(m.acquireAgentLock).toHaveBeenCalledWith("devops");
    expect(m.generate.mock.calls[0][0]).toBe(AGENT_TIER.devops);
    expect(m.writeMemory).toHaveBeenCalledWith("devops", "Nothing new.");
    expect(m.releaseAgentLock).toHaveBeenCalledWith("devops", "agent-token");
  });

  const src = readFileSync(join(__dirname, "..", "cycle.ts"), "utf8");
  const code = src.replace(/\/\/.*$/gm, "");

  it("never imports or calls the fix / QA / GitHub-CI / merge path", () => {
    expect(src).not.toMatch(/qa-loop|fix-agent|github-ci|runFixAgent|startHandling|openPullRequest|commitToBranch/);
    expect(code).not.toMatch(/merge/i);
  });

  it("never saves suggestions, writes memory, or calls a model / loop directly", () => {
    expect(code).not.toMatch(/saveSuggestion|writeMemory|freeLlm|runFreeLoop|free-loop|providers\/|generate\(/);
    expect(src).toMatch(/from "\.\/run-agent"/);
  });

  it("never runs agents in parallel and reads no environment", () => {
    expect(code).not.toMatch(/Promise\.all|allSettled|process\.env/);
  });

  it("no paid provider path", () => {
    expect(src).not.toMatch(/anthropic|openai|9router/i);
  });
});
