import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { generate, logActivity, saveSuggestion, notify } = vi.hoisted(() => ({ generate: vi.fn(), logActivity: vi.fn(), saveSuggestion: vi.fn(), notify: vi.fn() }));
vi.mock("../../lib/free-llm", () => ({ freeLlm: { generate } }));
vi.mock("../../lib/memory", () => ({ logActivity: (...a: unknown[]) => logActivity(...a) }));
vi.mock("../../lib/suggestions", () => ({ saveSuggestion: (...a: unknown[]) => saveSuggestion(...a) }));
vi.mock("../../lib/supabase", () => ({ supabaseAdmin: {} }));
vi.mock("../../lib/notify", () => ({ notify: (...a: unknown[]) => notify(...a) }));

import { runFreeLoop, TURN_MAX_OUTPUT_TOKENS, MAX_TURNS_CAP, MAX_TOOL_CALLS_PER_TURN, LOOP_DEADLINE_MS, TOOL_TIMEOUT_MS, type ToolDef } from "../free-loop";
import { toolsFor, dispatchTool, type DispatchContext } from "../../tools/registry";
import { LlmError } from "../../lib/llm-errors";
import type { LlmRequest } from "../../lib/llm";
import type { AgentId } from "../../lib/types";

const tool = (name: string): ToolDef => ({ name, description: name, input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } });
const reply = (text: string, calls: { name: string; input?: Record<string, unknown> }[] = []) => ({
  text,
  toolCalls: calls.map((c, i) => ({ id: `c${i}`, name: c.name, input: c.input ?? {} })),
  stopReason: calls.length ? "tool_calls" : "end",
  usage: { inputTokens: 1, outputTokens: 1, estimated: false },
  provider: "ollama",
  model: "qwen3.5:4b",
  tier: "medium",
  cost: 0,
  attempts: [],
});
const reqAt = (i: number) => generate.mock.calls[i][1] as LlmRequest;
// 7b: save_suggestion takes a structured finding. A product idea needs no
// code evidence, which keeps these loop-level tests about the loop itself.
const idea = (over: Record<string, unknown> = {}) => ({ class: "product_idea", title: "Fix onboarding", claim: "details", impact: "more activation", proposed_change: "add a checklist", priority: "medium", ...over });
const NO_HISTORY = { entries: [] };

beforeEach(() => {
  generate.mockReset();
  logActivity.mockReset();
  saveSuggestion.mockReset();
  notify.mockReset();
});

describe("free loop", () => {
  it("1/2/3. calls the free router with the caller's tier, system prompt and exactly the offered tools", async () => {
    generate.mockResolvedValueOnce(reply("all good"));
    const out = await runFreeLoop({ agent: "growth", tier: "medium", system: "SYS", userMessage: "go", tools: [tool("db_read"), tool("save_suggestion")], dispatch: vi.fn() });
    expect(out.text).toBe("all good");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0]).toBe("medium");
    const r = reqAt(0);
    expect(r.system).toBe("SYS");
    expect(r.messages).toEqual([{ role: "user", content: "go" }]);
    expect(r.tools!.map((t) => t.name)).toEqual(["db_read", "save_suggestion"]);
    expect(r.tools![0].parameters).toEqual({ type: "object", properties: { q: { type: "string" } }, required: ["q"] });
    expect(r.maxOutputTokens).toBe(TURN_MAX_OUTPUT_TOKENS);
    expect(Object.keys(r).sort()).toEqual(["maxOutputTokens", "messages", "system", "tools"]); // no model/provider fields
  });

  it("4. an unoffered tool call is refused, logged, reported as an error, and never dispatched", async () => {
    generate.mockResolvedValueOnce(reply("", [{ name: "apply_db_migration", input: { sql: "drop table x" } }, { name: "db_read", input: { q: "select 1" } }])).mockResolvedValueOnce(reply("done"));
    const dispatch = vi.fn().mockResolvedValue("[1]");
    await runFreeLoop({ agent: "cybersecurity", tier: "high", system: "s", userMessage: "u", tools: [tool("db_read")], dispatch });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith("cybersecurity", "db_read", { q: "select 1" });
    expect(logActivity).toHaveBeenCalledWith("cybersecurity", "security:tool-rejected", expect.stringContaining("apply_db_migration"));
    const toolMsgs = reqAt(1).messages.filter((m) => m.role === "tool");
    expect(toolMsgs[0]).toMatchObject({ role: "tool", name: "apply_db_migration", isError: true, content: expect.stringMatching(/not offered/) });
  });

  it("5. on the last turn only save_suggestion is offered, and other calls are refused", async () => {
    generate.mockResolvedValue(reply("", [{ name: "db_read", input: { q: "x" } }]));
    const dispatch = vi.fn().mockResolvedValue("[]");
    await runFreeLoop({ agent: "engineering", tier: "medium", system: "s", userMessage: "u", tools: [tool("db_read"), tool("save_suggestion")], maxTurns: 3, dispatch });
    expect(generate).toHaveBeenCalledTimes(3);
    expect(reqAt(0).tools!.map((t) => t.name)).toEqual(["db_read", "save_suggestion"]);
    expect(reqAt(2).tools!.map((t) => t.name)).toEqual(["save_suggestion"]);
    expect(dispatch).toHaveBeenCalledTimes(2); // final-turn db_read refused
    expect(logActivity).toHaveBeenCalledWith("engineering", "security:tool-rejected", expect.stringContaining("db_read"));
  });

  it("6. tool results are returned to the model in order, with wrap-up nudges on the last result", async () => {
    generate
      .mockResolvedValueOnce(reply("thinking", [{ name: "db_read", input: { q: "a" } }]))
      .mockResolvedValueOnce(reply("", [{ name: "db_read", input: { q: "b" } }]))
      .mockResolvedValueOnce(reply("final answer"));
    const dispatch = vi.fn().mockImplementation(async (_a, _n, i: { q: string }) => `result-${i.q}`);
    const out = await runFreeLoop({ agent: "growth", tier: "medium", system: "s", userMessage: "u", tools: [tool("db_read"), tool("save_suggestion")], maxTurns: 3, dispatch });
    expect(out).toMatchObject({ text: "final answer", status: "ok" });
    // 7b: with save_suggestion offered, each recorded result carries its run-bound evidence ref.
    expect(out.toolOutputs).toHaveLength(2);
    expect(out.toolOutputs[0]).toMatch(/^result-a\n\n\[evidence ref: ev1-[0-9a-f]{6} /);
    expect(out.toolOutputs[1]).toMatch(/^result-b\n\n\[evidence ref: ev2-[0-9a-f]{6} /);
    const m = reqAt(1).messages;
    expect(m[1]).toEqual({ role: "assistant", content: "thinking", toolCalls: [{ id: "c0", name: "db_read", input: { q: "a" } }] });
    expect(m[2]).toMatchObject({ role: "tool", toolCallId: "c0", name: "db_read", content: expect.stringMatching(/^result-a\n\n\[evidence ref: ev1-[0-9a-f]{6} [^\n]*\n\n\[Mission Control\] You have 2 turns left/) });
    expect(reqAt(2).messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringMatching(/absolute final turn/) });
  });

  it("7. save_suggestion goes through the real registry dispatcher, the gate and the claim guard, then saves", async () => {
    generate
      .mockResolvedValueOnce(reply("", [{ name: "save_suggestion", input: idea({ category: "growth", claim: "3 signups this week" }) }]))
      .mockResolvedValueOnce(reply("saved one"));
    const out = await runFreeLoop({ agent: "growth", tier: "medium", system: "s", userMessage: "u", tools: toolsFor("growth"), findingHistory: NO_HISTORY });
    expect(saveSuggestion).toHaveBeenCalledTimes(1);
    const saved = saveSuggestion.mock.calls[0][0];
    expect(saved).toMatchObject({ agent: "growth", category: "growth", title: "[Idea] Fix onboarding", priority: "low" });
    // no tool data this cycle, so "3" is unsupported and marked
    expect(saved.body).toContain("**Claim:** 3 [unverified] signups this week");
    expect(saved.body).toContain("⚠ Unverified figures (not found in or derivable from this cycle's data): 3\nGenerated by ollama/qwen3.5:4b");
    expect(saved.body).toMatch(/^\*\*Class:\*\* Idea — a product suggestion, NOT a bug\./);
    // The gate's reply is shown to the model but is never claim-guard material.
    expect(out.toolOutputs).toEqual([]);
    expect(reqAt(1).messages.at(-1)).toMatchObject({ role: "tool", name: "save_suggestion", content: expect.stringMatching(/^Saved to the owner's suggestions inbox as a PRODUCT IDEA/) });
  });

  it("8/9/16. router failure (e.g. no free provider) stops the loop once, gracefully, and logs the marker", async () => {
    generate.mockRejectedValue(new LlmError("PROVIDER_UNAVAILABLE", "FREE_AI_QUOTA_EXHAUSTED: no approved free provider could serve this high request (gemini:gemini-3.8-flash=provider_unavailable). Stopping — no paid fallback exists.", { provider: "router" }));
    const dispatch = vi.fn();
    const out = await runFreeLoop({ agent: "cybersecurity", tier: "high", system: "s", userMessage: "u", tools: [tool("db_read")], maxTurns: 16, dispatch });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(out.text).toMatch(/^⚠ Agent error: free AI unavailable — FREE_AI_QUOTA_EXHAUSTED/);
    expect(out.status).toBe("stopped");
    expect(out.detail).toBe("free-ai-unavailable");
    expect(logActivity).toHaveBeenCalledWith("cybersecurity", "free-ai:stopped", expect.stringContaining("FREE_AI_QUOTA_EXHAUSTED"));
  });

  it("16b. the loop is bounded by maxTurns even if the model never stops calling tools", async () => {
    generate.mockResolvedValue(reply("still going", [{ name: "db_read", input: { q: "x" } }]));
    const out = await runFreeLoop({ agent: "devops", tier: "medium", system: "s", userMessage: "u", tools: [tool("db_read")], maxTurns: 5, dispatch: vi.fn().mockResolvedValue("x") });
    expect(generate).toHaveBeenCalledTimes(5);
    expect(out.text).toBe("still going");
    expect(out.status).toBe("max_turns");
  });

  describe("claim guard integration", () => {
    const withData = (provider: string, model: string, suggestion: Record<string, unknown>, data = "total_teams: 19, active_teams: 2") => {
      generate
        .mockResolvedValueOnce({ ...reply("", [{ name: "db_read", input: { q: "select count" } }]), provider, model })
        .mockResolvedValueOnce({ ...reply("", [{ name: "save_suggestion", input: suggestion }]), provider, model })
        .mockResolvedValueOnce({ ...reply("done"), provider, model });
      const dispatchReal = async (agent: AgentId, name: string, input: Record<string, unknown>, ctx?: DispatchContext) =>
        name === "db_read" ? data : dispatchTool(agent, name, input, ctx);
      return runFreeLoop({ agent: "growth", tier: "medium", system: "s", userMessage: "u", tools: toolsFor("growth"), dispatch: dispatchReal, findingHistory: NO_HISTORY });
    };

    it("12. the saved body carries a provenance line with the provider/model that actually answered (ollama)", async () => {
      await withData("ollama", "qwen3.5:4b", idea({ title: "Low activation", claim: "Only 2 of 19 teams are active (10.5%)." }));
      const saved = saveSuggestion.mock.calls[0][0];
      expect(saved.body).toContain("**Claim:** Only 2 of 19 teams are active (10.5%).");
      expect(saved.body).toMatch(/\n\nGenerated by ollama\/qwen3\.5:4b\n\nFinding-Fingerprint: v1 /);
      expect(saved.body).not.toMatch(/unverified/i);
    });

    it("17. provenance reflects Gemini when Gemini answered", async () => {
      await withData("gemini", "gemini-3.5-flash-lite", idea({ title: "Low activation", claim: "2 of 19 teams active.", priority: "low" }));
      expect(saveSuggestion.mock.calls[0][0].body).toMatch(/\n\nGenerated by gemini\/gemini-3\.5-flash-lite\n\nFinding-Fingerprint: /);
    });

    it("13. an unverified figure is marked, footnoted and logged; an idea is never high priority and never alerts", async () => {
      await withData("ollama", "qwen3.5:4b", idea({ title: "Engagement is only 6%", claim: "Engagement sits at 6% across 19 teams.", priority: "high" }));
      const saved = saveSuggestion.mock.calls[0][0];
      expect(saved.priority).toBe("low");
      expect(saved.title).toBe("[Idea] Engagement is only 6% [unverified]");
      expect(saved.body).toContain("**Claim:** Engagement sits at 6% [unverified] across 19 teams.");
      expect(saved.body).toMatch(/⚠ Unverified figures \(not found in or derivable from this cycle's data\): 6%/);
      expect(saved.body).toMatch(/Generated by ollama\/qwen3\.5:4b\n\nFinding-Fingerprint: /);
      expect(notify).not.toHaveBeenCalled();
      expect(logActivity).toHaveBeenCalledWith("growth", "claims:unverified", "6%");
    });

    it("14. a fully verified high-priority product idea is saved as a low-priority idea and never alerts (only gate-verified bugs alert)", async () => {
      await withData("ollama", "qwen3.5:4b", idea({ title: "Only 2 of 19 teams active", claim: "Activation is 10.5%.", priority: "high" }));
      expect(saveSuggestion.mock.calls[0][0]).toMatchObject({ priority: "low", title: "[Idea] Only 2 of 19 teams active" });
      expect(notify).not.toHaveBeenCalled();
      expect(logActivity).not.toHaveBeenCalledWith("growth", "claims:unverified", expect.anything());
    });

    it("14b. a data-backed plausible_risk cites the run's evidence ref, stays a risk and is capped below high", async () => {
      generate
        .mockResolvedValueOnce(reply("", [{ name: "db_read", input: { q: "select count" } }]))
        .mockImplementationOnce(async (_tier: string, req: LlmRequest) => {
          const ref = /\[evidence ref: (ev\d+-[0-9a-f]{6})/.exec(String(req.messages.at(-1)?.content))![1];
          return reply("", [{ name: "save_suggestion", input: { class: "plausible_risk", title: "Only 2 of 19 teams are active", claim: "Only 2 of 19 teams are active.", failure_scenario: "New players find no opponents.", impact: "Churn.", evidence: [{ ref, excerpt: "total_teams: 19, active_teams: 2" }], proposed_change: "Run a captain outreach.", priority: "high" } }]);
        })
        .mockResolvedValueOnce(reply("done"));
      await runFreeLoop({ agent: "growth", tier: "medium", system: "s", userMessage: "u", tools: toolsFor("growth"), findingHistory: NO_HISTORY, dispatch: async (a, n, i, c) => (n === "db_read" ? "total_teams: 19, active_teams: 2" : dispatchTool(a, n, i, c)) });
      const saved = saveSuggestion.mock.calls[0][0];
      expect(saved).toMatchObject({ category: "risk", priority: "medium", title: "[Risk] Only 2 of 19 teams are active" });
      expect(saved.body).toMatch(/^\*\*Class:\*\* Risk — NOT a confirmed defect\./);
      expect(saved.body).toContain("- db_read — `total_teams: 19, active_teams: 2`");
      expect(notify).not.toHaveBeenCalled();
    });

    it("non-save tools are dispatched without a guard context", async () => {
      generate.mockResolvedValueOnce(reply("", [{ name: "db_read", input: { q: "x" } }])).mockResolvedValueOnce(reply("ok"));
      const dispatch = vi.fn().mockResolvedValue("6%");
      await runFreeLoop({ agent: "growth", tier: "medium", system: "s", userMessage: "u", tools: [tool("db_read")], dispatch });
      expect(dispatch.mock.calls[0]).toEqual(["growth", "db_read", { q: "x" }]); // no 4th (guard) argument
    });
  });

  describe("bounded execution (6a)", () => {
    it("maxTurns above the 16-turn cap is clamped to 16", async () => {
      generate.mockResolvedValue(reply("", [{ name: "db_read", input: { q: "x" } }]));
      const out = await runFreeLoop({ agent: "devops", tier: "medium", system: "s", userMessage: "u", tools: [tool("db_read")], maxTurns: 40, dispatch: vi.fn().mockResolvedValue("x") });
      expect(MAX_TURNS_CAP).toBe(16);
      expect(generate).toHaveBeenCalledTimes(16);
      expect(out.status).toBe("max_turns");
    });

    it("no new turn starts after the wall-clock deadline; the loop stops without throwing", async () => {
      let t = 0;
      generate.mockImplementation(async () => {
        t += LOOP_DEADLINE_MS; // the first turn alone uses up the whole budget
        return reply("", [{ name: "db_read", input: { q: "x" } }]);
      });
      const out = await runFreeLoop({ agent: "devops", tier: "medium", system: "s", userMessage: "u", tools: [tool("db_read")], maxTurns: 16, dispatch: vi.fn().mockResolvedValue("x"), now: () => t });
      expect(generate).toHaveBeenCalledTimes(1);
      expect(out).toMatchObject({ status: "stopped", detail: "deadline" });
      expect(out.text).toMatch(/time limit/);
      expect(logActivity).toHaveBeenCalledWith("devops", "loop:deadline", expect.stringContaining("turn 2/16"));
    });

    it("a caller can shorten the deadline but never extend it", async () => {
      let t = 0;
      generate.mockImplementation(async () => {
        t += LOOP_DEADLINE_MS;
        return reply("", [{ name: "db_read", input: { q: "x" } }]);
      });
      const out = await runFreeLoop({ agent: "devops", tier: "medium", system: "s", userMessage: "u", tools: [tool("db_read")], maxTurns: 5, deadlineMs: 10 * LOOP_DEADLINE_MS, dispatch: vi.fn().mockResolvedValue("x"), now: () => t });
      expect(generate).toHaveBeenCalledTimes(1);
      expect(out.status).toBe("stopped");
      t = 0;
      generate.mockReset();
      generate.mockImplementation(async () => {
        t += 1000;
        return reply("", [{ name: "db_read", input: { q: "x" } }]);
      });
      const short = await runFreeLoop({ agent: "devops", tier: "medium", system: "s", userMessage: "u", tools: [tool("db_read")], maxTurns: 5, deadlineMs: 1500, dispatch: vi.fn().mockResolvedValue("x"), now: () => t });
      expect(generate).toHaveBeenCalledTimes(2);
      expect(short.status).toBe("stopped");
    });

    it("executes at most MAX_TOOL_CALLS_PER_TURN calls per turn; the rest are refused, not run", async () => {
      const calls = Array.from({ length: 7 }, (_, i) => ({ name: "db_read", input: { q: `q${i}` } }));
      generate.mockResolvedValueOnce(reply("", calls)).mockResolvedValueOnce(reply("done"));
      const dispatch = vi.fn().mockImplementation(async (_a, _n, i: { q: string }) => `r-${i.q}`);
      const out = await runFreeLoop({ agent: "growth", tier: "medium", system: "s", userMessage: "u", tools: [tool("db_read")], dispatch });
      expect(MAX_TOOL_CALLS_PER_TURN).toBe(5);
      expect(dispatch).toHaveBeenCalledTimes(5);
      expect(out.toolOutputs).toEqual(["r-q0", "r-q1", "r-q2", "r-q3", "r-q4"]);
      const toolMsgs = reqAt(1).messages.filter((m) => m.role === "tool");
      expect(toolMsgs).toHaveLength(7); // every call still gets a result, in order
      expect(toolMsgs.slice(5)).toEqual([
        expect.objectContaining({ isError: true, content: expect.stringMatching(/^Not executed: at most 5 tool calls/) }),
        expect.objectContaining({ isError: true, content: expect.stringMatching(/^Not executed/) }),
      ]);
      expect(logActivity.mock.calls.filter((c) => c[1] === "loop:tool-cap")).toHaveLength(1);
    });
  });

  describe("tool errors (6a)", () => {
    it("a thrown read-only tool error goes back to the model as an explicit error, is not data, and is not retried", async () => {
      generate
        .mockResolvedValueOnce(reply("", [{ name: "web_search", input: { query: "x" } }, { name: "db_read", input: { q: "y" } }]))
        .mockResolvedValueOnce(reply("concluded"));
      const dispatch = vi.fn().mockImplementation(async (_a, name: string) => {
        if (name === "web_search") throw new Error("fetch failed 503");
        return "rows: 19";
      });
      const out = await runFreeLoop({ agent: "growth", tier: "medium", system: "s", userMessage: "u", tools: [tool("web_search"), tool("db_read")], dispatch });
      expect(dispatch).toHaveBeenCalledTimes(2); // no retry
      expect(out.toolOutputs).toEqual(["rows: 19"]); // the error text can never support a figure
      const toolMsgs = reqAt(1).messages.filter((m) => m.role === "tool");
      expect(toolMsgs[0]).toMatchObject({ name: "web_search", isError: true, content: expect.stringMatching(/^Tool error: web_search failed \(fetch failed 503\)\. It was not retried/) });
      expect(logActivity).toHaveBeenCalledWith("growth", "tool:error", "web_search: fetch failed 503");
      expect(out.status).toBe("ok"); // the model saw the failure and concluded anyway
    });

    it("a read-only tool that hangs times out into an error result", async () => {
      vi.useFakeTimers();
      try {
        generate.mockResolvedValueOnce(reply("", [{ name: "db_read", input: { q: "x" } }])).mockResolvedValueOnce(reply("done"));
        const dispatch = vi.fn().mockReturnValue(new Promise<string>(() => {}));
        const p = runFreeLoop({ agent: "growth", tier: "medium", system: "s", userMessage: "u", tools: [tool("db_read")], dispatch });
        await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_MS + 1);
        const out = await p;
        expect(out.toolOutputs).toEqual([]);
        expect(reqAt(1).messages.at(-1)).toMatchObject({ isError: true, content: expect.stringMatching(/db_read timed out after 60 s/) });
      } finally {
        vi.useRealTimers();
      }
    });

    it("a thrown save_suggestion error stops the run (status stopped) instead of becoming a completed cycle", async () => {
      saveSuggestion.mockRejectedValueOnce(new Error("insert failed"));
      generate
        .mockResolvedValueOnce(reply("", [{ name: "save_suggestion", input: idea({ priority: "low" }) }]))
        .mockResolvedValueOnce(reply("I saved the suggestion."));
      const out = await runFreeLoop({ agent: "growth", tier: "medium", system: "s", userMessage: "u", tools: toolsFor("growth"), findingHistory: NO_HISTORY });
      expect(out).toMatchObject({ status: "stopped", detail: "tool-error:save_suggestion" });
      expect(out.text).toBe("⚠ Agent stopped: save_suggestion failed (insert failed).");
      expect(generate).toHaveBeenCalledTimes(1); // the model never gets to claim success
      expect(logActivity).toHaveBeenCalledWith("growth", "tool:error", "save_suggestion: insert failed");
    });

    it("any non-read-only tool that throws (e.g. the fix agent's submit_fix) also stops the run", async () => {
      generate.mockResolvedValueOnce(reply("", [{ name: "submit_fix", input: { files: [] } }])).mockResolvedValueOnce(reply("done"));
      const dispatch = vi.fn().mockRejectedValue(new Error("GitHub 502"));
      const out = await runFreeLoop({ agent: "developer", tier: "high", system: "s", userMessage: "u", tools: [tool("submit_fix")], dispatch });
      expect(out).toMatchObject({ status: "stopped", detail: "tool-error:submit_fix" });
      expect(generate).toHaveBeenCalledTimes(1);
    });
  });

  describe("guarded logging, alert context and category (6a)", () => {
    const save = (input: Record<string, unknown>) => {
      generate.mockResolvedValueOnce(reply("", [{ name: "save_suggestion", input }])).mockResolvedValueOnce(reply("done"));
      return runFreeLoop({ agent: "growth", tier: "medium", system: "s", userMessage: "u", tools: toolsFor("growth"), findingHistory: NO_HISTORY });
    };
    const loggedLines = () => logActivity.mock.calls.map((c) => String(c[2] ?? ""));
    const UNMARKED_6 = /6%(?! \[unverified\])/;

    it("the save_suggestion activity record is written after the guard: an unsupported 6% only appears marked", async () => {
      await save({ category: "growth", title: "Engagement is 6%", body: "Only 6% engage.", evidence: "none", priority: "medium" });
      const rec = logActivity.mock.calls.find((c) => c[1] === "tool:save_suggestion");
      expect(rec?.[2]).toContain("6% [unverified]");
      expect(rec?.[2]).not.toMatch(UNMARKED_6);
      // The only other place the figure appears is the explicit list of unverified figures.
      const others = logActivity.mock.calls.filter((c) => c[1] !== "claims:unverified").map((c) => String(c[2] ?? ""));
      expect(others.some((l) => UNMARKED_6.test(l))).toBe(false);
      expect(logActivity).toHaveBeenCalledWith("growth", "claims:unverified", "6%");
      const order = logActivity.mock.calls.map((c) => c[1]);
      expect(order.indexOf("claims:unverified")).toBeLessThan(order.indexOf("tool:save_suggestion"));
    });

    it("truncating the activity record can never leave an unsupported figure unmarked", async () => {
      for (let pad = 180; pad < 300; pad += 7) {
        logActivity.mockReset();
        generate.mockReset();
        await save({ category: "growth", title: `${"x".repeat(pad)} 6% churn`, body: "b", evidence: "none", priority: "low" });
        const rec = logActivity.mock.calls.find((c) => c[1] === "tool:save_suggestion");
        expect(String(rec?.[2])).not.toMatch(UNMARKED_6);
      }
    });

    it("a refused (unoffered) save_suggestion is logged without its unguarded content", async () => {
      generate.mockResolvedValueOnce(reply("", [{ name: "save_suggestion", input: { title: "Engagement is 6%", body: "6%" } }])).mockResolvedValueOnce(reply("done"));
      await runFreeLoop({ agent: "growth", tier: "medium", system: "s", userMessage: "u", tools: [tool("db_read")], dispatch: vi.fn() });
      expect(logActivity).toHaveBeenCalledWith("growth", "security:tool-rejected", "save_suggestion keys=title,body");
      expect(loggedLines().some((l) => /6%/.test(l))).toBe(false);
    });

    it("dispatch receives explicit guard approval only when every figure is verified", async () => {
      const dispatch = vi.fn().mockResolvedValue("Saved.");
      generate
        .mockResolvedValueOnce(reply("", [{ name: "save_suggestion", input: { category: "growth", title: "6% engage", body: "b", evidence: "none", priority: "high" } }]))
        .mockResolvedValueOnce(reply("", [{ name: "save_suggestion", input: { category: "growth", title: "Fix onboarding", body: "b", evidence: "none", priority: "high" } }]))
        .mockResolvedValueOnce(reply("done"));
      await runFreeLoop({ agent: "growth", tier: "medium", system: "s", userMessage: "u", tools: toolsFor("growth"), dispatch });
      expect(dispatch.mock.calls[0][3]).toMatchObject({ guardPassed: false });
      expect(dispatch.mock.calls[1][3]).toMatchObject({ guardPassed: true });
      expect(dispatch.mock.calls[0][3]).not.toHaveProperty("notify");
    });

    it("an invalid category is replaced by the default before saving and is not logged raw", async () => {
      await save(idea({ category: "6% churn!!", priority: "low" }));
      expect(saveSuggestion.mock.calls[0][0].category).toBe("general");
      expect(logActivity).toHaveBeenCalledWith("growth", "category:invalid", 'replaced with "general" (original was 10 chars; not logged)');
      expect(loggedLines().some((l) => /churn/.test(l))).toBe(false);
    });

    it("a valid category is normalised to a lowercase tag", async () => {
      await save(idea({ category: " Video Idea ", priority: "low" }));
      expect(saveSuggestion.mock.calls[0][0].category).toBe("video-idea");
    });
  });

  describe("pinned FootRank commit handover (7a)", () => {
    const PIN = "27e1e5ac5a89cb9d5f5cb7ca6a1368afa0582a46";
    const calls = () => [
      { name: "read_repo_file", input: { path: "lib/a.dart" } },
      { name: "search_code", input: { query: "x" } },
      { name: "db_read", input: { q: "select 1" } },
    ];

    it("only read_repo_file and search_code receive the run's pinned commit, as loop-supplied context", async () => {
      generate.mockResolvedValueOnce(reply("", calls())).mockResolvedValueOnce(reply("done"));
      const dispatch = vi.fn().mockResolvedValue("ok");
      await runFreeLoop({ agent: "engineering", tier: "medium", system: "s", userMessage: "u", tools: [tool("read_repo_file"), tool("search_code"), tool("db_read")], dispatch, codeCommit: PIN });
      expect(dispatch.mock.calls[0]).toEqual(["engineering", "read_repo_file", { path: "lib/a.dart" }, { codeCommit: PIN }]);
      expect(dispatch.mock.calls[1]).toEqual(["engineering", "search_code", { query: "x" }, { codeCommit: PIN }]);
      expect(dispatch.mock.calls[2]).toEqual(["engineering", "db_read", { q: "select 1" }]); // other tools: unchanged, no context
    });

    it("the same pin is used for every code call in the run, whatever the model asks for", async () => {
      generate
        .mockResolvedValueOnce(reply("", [{ name: "read_repo_file", input: { path: "a", commit: "1111111111111111111111111111111111111111" } }]))
        .mockResolvedValueOnce(reply("", [{ name: "search_code", input: { query: "y", codeCommit: "2222222222222222222222222222222222222222" } }]))
        .mockResolvedValueOnce(reply("done"));
      const dispatch = vi.fn().mockResolvedValue("ok");
      await runFreeLoop({ agent: "qa", tier: "medium", system: "s", userMessage: "u", tools: [tool("read_repo_file"), tool("search_code")], dispatch, codeCommit: PIN });
      expect(dispatch.mock.calls.map((c) => c[3])).toEqual([{ codeCommit: PIN }, { codeCommit: PIN }]);
    });

    it("save_suggestion's guard context never carries the pin", async () => {
      generate.mockResolvedValueOnce(reply("", [{ name: "save_suggestion", input: { category: "bug", title: "t", body: "b", evidence: "e", priority: "low" } }])).mockResolvedValueOnce(reply("done"));
      const dispatch = vi.fn().mockResolvedValue("Saved.");
      await runFreeLoop({ agent: "qa", tier: "medium", system: "s", userMessage: "u", tools: [tool("save_suggestion")], dispatch, codeCommit: PIN });
      expect(dispatch.mock.calls[0][3]).not.toHaveProperty("codeCommit");
    });

    it("without a pin (e.g. the fix agent's loop) code tools are dispatched exactly as before", async () => {
      generate.mockResolvedValueOnce(reply("", [{ name: "read_repo_file", input: { path: "lib/a.dart" } }])).mockResolvedValueOnce(reply("done"));
      const dispatch = vi.fn().mockResolvedValue("raw");
      await runFreeLoop({ agent: "developer", tier: "high", system: "s", userMessage: "u", tools: [tool("read_repo_file")], dispatch });
      expect(dispatch.mock.calls[0]).toEqual(["developer", "read_repo_file", { path: "lib/a.dart" }]);
    });
  });

  it("10/17. the loop source uses only the free router — no Anthropic, OpenAI or legacy loop", () => {
    const src = readFileSync(join(__dirname, "..", "free-loop.ts"), "utf8");
    expect(src).toMatch(/from "\.\.\/lib\/free-llm"/);
    expect(src).not.toMatch(new RegExp(["@anthro" + "pic-ai", "lib/anthro" + "pic", "run-loop\"", "open" + "ai", "process\\.env"].join("|"), "i"));
  });
});
