import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { generate, logActivity, saveSuggestion, notify } = vi.hoisted(() => ({ generate: vi.fn(), logActivity: vi.fn(), saveSuggestion: vi.fn(), notify: vi.fn() }));
vi.mock("../../lib/free-llm", () => ({ freeLlm: { generate } }));
vi.mock("../../lib/memory", () => ({ logActivity: (...a: unknown[]) => logActivity(...a) }));
vi.mock("../../lib/suggestions", () => ({ saveSuggestion: (...a: unknown[]) => saveSuggestion(...a) }));
vi.mock("../../lib/supabase", () => ({ supabaseAdmin: {} }));
vi.mock("../../lib/notify", () => ({ notify: (...a: unknown[]) => notify(...a) }));

import { runFreeLoop, TURN_MAX_OUTPUT_TOKENS, type ToolDef } from "../free-loop";
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
    expect(out).toEqual({ text: "final answer", toolOutputs: ["result-a", "result-b"] });
    const m = reqAt(1).messages;
    expect(m[1]).toEqual({ role: "assistant", content: "thinking", toolCalls: [{ id: "c0", name: "db_read", input: { q: "a" } }] });
    expect(m[2]).toMatchObject({ role: "tool", toolCallId: "c0", name: "db_read", content: expect.stringMatching(/^result-a\n\n\[Mission Control\] You have 2 turns left/) });
    expect(reqAt(2).messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringMatching(/absolute final turn/) });
  });

  it("7. save_suggestion goes through the real registry dispatcher and saves the suggestion", async () => {
    generate
      .mockResolvedValueOnce(reply("", [{ name: "save_suggestion", input: { category: "growth", title: "Fix onboarding", body: "details", evidence: "db_read: 3 signups", priority: "medium" } }]))
      .mockResolvedValueOnce(reply("saved one"));
    const out = await runFreeLoop({ agent: "growth", tier: "medium", system: "s", userMessage: "u", tools: toolsFor("growth") });
    expect(saveSuggestion).toHaveBeenCalledWith({ agent: "growth", category: "growth", title: "Fix onboarding", body: "details\n\n— Evidence: db_read: 3 [unverified] signups\n\n⚠ Unverified figures (not found in or derivable from this cycle's data): 3\nGenerated by ollama/qwen3.5:4b", priority: "medium" }); // no tool data this cycle, so "3" is unsupported
    expect(out.toolOutputs).toEqual(["Saved to the owner's suggestions inbox."]);
  });

  it("8/9/16. router failure (e.g. no free provider) stops the loop once, gracefully, and logs the marker", async () => {
    generate.mockRejectedValue(new LlmError("PROVIDER_UNAVAILABLE", "FREE_AI_QUOTA_EXHAUSTED: no approved free provider could serve this high request (gemini:gemini-3.8-flash=provider_unavailable). Stopping — no paid fallback exists.", { provider: "router" }));
    const dispatch = vi.fn();
    const out = await runFreeLoop({ agent: "cybersecurity", tier: "high", system: "s", userMessage: "u", tools: [tool("db_read")], maxTurns: 16, dispatch });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(out.text).toMatch(/^⚠ Agent error: free AI unavailable — FREE_AI_QUOTA_EXHAUSTED/);
    expect(logActivity).toHaveBeenCalledWith("cybersecurity", "free-ai:stopped", expect.stringContaining("FREE_AI_QUOTA_EXHAUSTED"));
  });

  it("16b. the loop is bounded by maxTurns even if the model never stops calling tools", async () => {
    generate.mockResolvedValue(reply("still going", [{ name: "db_read", input: { q: "x" } }]));
    const out = await runFreeLoop({ agent: "devops", tier: "medium", system: "s", userMessage: "u", tools: [tool("db_read")], maxTurns: 5, dispatch: vi.fn().mockResolvedValue("x") });
    expect(generate).toHaveBeenCalledTimes(5);
    expect(out.text).toBe("still going");
  });

  describe("claim guard integration", () => {
    const withData = (provider: string, model: string, suggestion: Record<string, unknown>, data = "total_teams: 19, active_teams: 2") => {
      generate
        .mockResolvedValueOnce({ ...reply("", [{ name: "db_read", input: { q: "select count" } }]), provider, model })
        .mockResolvedValueOnce({ ...reply("", [{ name: "save_suggestion", input: suggestion }]), provider, model })
        .mockResolvedValueOnce({ ...reply("done"), provider, model });
      const dispatchReal = async (agent: AgentId, name: string, input: Record<string, unknown>, ctx?: DispatchContext) =>
        name === "db_read" ? data : dispatchTool(agent, name, input, ctx);
      return runFreeLoop({ agent: "growth", tier: "medium", system: "s", userMessage: "u", tools: toolsFor("growth"), dispatch: dispatchReal });
    };

    it("12. the saved body carries a provenance line with the provider/model that actually answered (ollama)", async () => {
      await withData("ollama", "qwen3.5:4b", { category: "growth", title: "Low activation", body: "Only 2 of 19 teams are active (10.5%).", priority: "medium" });
      const saved = saveSuggestion.mock.calls[0][0];
      expect(saved.body).toBe("Only 2 of 19 teams are active (10.5%).\n\nGenerated by ollama/qwen3.5:4b");
      expect(saved.body).not.toMatch(/unverified/i);
    });

    it("17. provenance reflects Gemini when Gemini answered", async () => {
      await withData("gemini", "gemini-3.5-flash-lite", { category: "growth", title: "Low activation", body: "2 of 19 teams active.", priority: "low" });
      expect(saveSuggestion.mock.calls[0][0].body).toMatch(/\n\nGenerated by gemini\/gemini-3\.5-flash-lite$/);
    });

    it("13. an unverified figure is marked, footnoted, logged, and suppresses the high-priority Telegram alert", async () => {
      await withData("ollama", "qwen3.5:4b", { category: "growth", title: "Engagement is only 6%", body: "Engagement sits at 6% across 19 teams.", priority: "high" });
      const saved = saveSuggestion.mock.calls[0][0];
      expect(saved.priority).toBe("high");
      expect(saved.title).toBe("Engagement is only 6% [unverified]");
      expect(saved.body).toMatch(/^Engagement sits at 6% \[unverified\] across 19 teams\./);
      expect(saved.body).toMatch(/⚠ Unverified figures \(not found in or derivable from this cycle's data\): 6%/);
      expect(saved.body).toMatch(/Generated by ollama\/qwen3\.5:4b$/);
      expect(notify).not.toHaveBeenCalled();
      expect(logActivity).toHaveBeenCalledWith("growth", "claims:unverified", "6%");
    });

    it("14. a fully verified high-priority suggestion still sends the Telegram alert", async () => {
      await withData("ollama", "qwen3.5:4b", { category: "growth", title: "Only 2 of 19 teams active", body: "Activation is 10.5%.", priority: "high" });
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][0]).toMatch(/flagged \(high\): Only 2 of 19 teams active$/);
      expect(logActivity).not.toHaveBeenCalledWith("growth", "claims:unverified", expect.anything());
    });

    it("non-save tools are dispatched without a guard context", async () => {
      generate.mockResolvedValueOnce(reply("", [{ name: "db_read", input: { q: "x" } }])).mockResolvedValueOnce(reply("ok"));
      const dispatch = vi.fn().mockResolvedValue("6%");
      await runFreeLoop({ agent: "growth", tier: "medium", system: "s", userMessage: "u", tools: [tool("db_read")], dispatch });
      expect(dispatch.mock.calls[0]).toEqual(["growth", "db_read", { q: "x" }]); // no 4th (guard) argument
    });
  });

  it("10/17. the loop source uses only the free router — no Anthropic, OpenAI or legacy loop", () => {
    const src = readFileSync(join(__dirname, "..", "free-loop.ts"), "utf8");
    expect(src).toMatch(/from "\.\.\/lib\/free-llm"/);
    expect(src).not.toMatch(new RegExp(["@anthro" + "pic-ai", "lib/anthro" + "pic", "run-loop\"", "open" + "ai", "process\\.env"].join("|"), "i"));
  });
});
