import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LlmRequest } from "../../lib/llm";

const { generate, runGroup, runOne, logActivity } = vi.hoisted(() => ({ generate: vi.fn(), runGroup: vi.fn(), runOne: vi.fn(), logActivity: vi.fn() }));
vi.mock("../../lib/free-llm", () => ({ freeLlm: { generate } }));
vi.mock("../cycle", () => ({ runGroup, runOne }));
vi.mock("../../lib/briefing", () => ({ getOrchestratorBriefing: vi.fn().mockResolvedValue("AGENT STATUS: all idle") }));
vi.mock("../../lib/memory", () => ({ logActivity: (...a: unknown[]) => logActivity(...a) }));
vi.mock("../../lib/anthropic", () => {
  throw new Error("chat must not load lib/anthropic");
});

import { streamChat, streamAgentChat } from "../orchestrator";

const read = async (s: ReadableStream) => {
  const r = s.getReader();
  let out = "";
  for (;;) {
    const { value, done } = await r.read();
    if (done) return out;
    out += new TextDecoder().decode(value);
  }
};
const resp = (text: string, calls: { name: string; input?: unknown }[] = []) => ({ text, toolCalls: calls.map((c, i) => ({ id: `t${i}`, name: c.name, input: c.input ?? {} })), usage: {}, provider: "ollama", model: "qwen3.5:4b", cost: 0 });

beforeEach(() => {
  generate.mockReset();
  runGroup.mockReset().mockResolvedValue({});
  runOne.mockReset().mockResolvedValue("");
  logActivity.mockReset();
});

describe("15. orchestrator chat on the free router", () => {
  it("streams text, uses the 'simple' tier, and dispatches via its one offered tool", async () => {
    generate
      .mockImplementationOnce(async (_tier: string, req: LlmRequest) => {
        req.onTextDelta!("On it. ");
        return resp("On it. ", [{ name: "run_agents", input: { scope: "marketing" } }]);
      })
      .mockImplementationOnce(async (_tier: string, req: LlmRequest) => {
        req.onTextDelta!("Dispatched Marketing.");
        return resp("Dispatched Marketing.");
      });
    const out = await read(await streamChat("run marketing"));
    expect(out).toBe("On it. Dispatched Marketing.");
    expect(generate.mock.calls[0][0]).toBe("simple");
    const r0 = generate.mock.calls[0][1] as LlmRequest;
    expect(r0.tools!.map((t) => t.name)).toEqual(["run_agents"]);
    expect(r0.system).toMatch(/AGENT STATUS: all idle/);
    expect(r0.maxOutputTokens).toBe(1500);
    expect(runOne).toHaveBeenCalledWith("marketing");
    const r1 = generate.mock.calls[1][1] as LlmRequest;
    expect(r1.messages.at(-1)).toMatchObject({ role: "tool", name: "run_agents", content: expect.stringMatching(/Dispatched Marketing/) });
  });

  it("per-agent chat offers only run_my_analysis; an unoffered tool is refused and logged", async () => {
    generate
      .mockResolvedValueOnce(resp("", [{ name: "run_agents", input: { scope: "all" } }]))
      .mockResolvedValueOnce(resp("ok"));
    await read(await streamAgentChat("growth", "hi"));
    expect((generate.mock.calls[0][1] as LlmRequest).tools!.map((t) => t.name)).toEqual(["run_my_analysis"]);
    expect(runGroup).not.toHaveBeenCalled();
    expect(runOne).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledWith("engineering", "security:tool-rejected", expect.stringContaining("run_agents"));
  });

  it("no free provider -> a clear message, nothing charged, no retries", async () => {
    generate.mockRejectedValue(new Error("FREE_AI_QUOTA_EXHAUSTED: no approved free provider could serve this simple request"));
    const out = await read(await streamChat("hello"));
    expect(out).toMatch(/Free AI is unavailable right now.*Nothing was charged/);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("chat turns are bounded (4 max)", async () => {
    generate.mockResolvedValue(resp("", [{ name: "run_agents", input: { scope: "nope" } }]));
    await read(await streamChat("loop forever"));
    expect(generate).toHaveBeenCalledTimes(4);
  });
});

describe("6b. chat dispatch goes through the sequential cycle runner", () => {
  it('"all" is ONE sequential manual run, not parallel cadence groups', async () => {
    generate.mockResolvedValueOnce(resp("", [{ name: "run_agents", input: { scope: "all" } }])).mockResolvedValueOnce(resp("ok"));
    await read(await streamChat("run everyone"));
    expect(runGroup).toHaveBeenCalledTimes(1);
    expect(runGroup).toHaveBeenCalledWith("all");
  });

  it("a cadence group is one manual group run", async () => {
    generate.mockResolvedValueOnce(resp("", [{ name: "run_agents", input: { scope: "daily" } }])).mockResolvedValueOnce(resp("ok"));
    await read(await streamChat("run daily"));
    expect(runGroup).toHaveBeenCalledWith("daily");
  });

  it("run_my_analysis runs the agent through the cycle runner", async () => {
    generate.mockResolvedValueOnce(resp("", [{ name: "run_my_analysis" }])).mockResolvedValueOnce(resp("ok"));
    await read(await streamAgentChat("growth", "run your analysis now"));
    expect(runOne).toHaveBeenCalledWith("growth");
  });

  it("orchestrator imports its runners from agents/cycle, not run-agent", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "..", "orchestrator.ts"), "utf8");
    expect(src).toMatch(/from "\.\/cycle"/);
    expect(src).not.toMatch(/from "\.\/run-agent"/);
  });
});
