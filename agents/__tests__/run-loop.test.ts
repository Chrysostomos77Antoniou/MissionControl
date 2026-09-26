import { describe, it, expect, vi, beforeEach } from "vitest";

const { create, logActivity } = vi.hoisted(() => ({ create: vi.fn(), logActivity: vi.fn() }));
vi.mock("../../lib/anthropic", () => ({ anthropic: { messages: { create } }, OPUS: "m-opus", HAIKU: "m-haiku" }));
vi.mock("../../lib/usage", () => ({ recordUsage: vi.fn(), flagApiError: vi.fn() }));
vi.mock("../../lib/memory", () => ({ logActivity: (...a: unknown[]) => logActivity(...a) }));
vi.mock("../../tools/registry", () => ({ dispatchTool: vi.fn() }));

import { runAgentLoop } from "../run-loop";

const tool = (name: string) => ({ name, description: name, input_schema: { type: "object" as const, properties: {} } });

describe("runAgentLoop tool-offering enforcement", () => {
  beforeEach(() => {
    create.mockReset();
    logActivity.mockReset();
  });

  it("never executes a tool that was not offered, logs a security event, and continues", async () => {
    create
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        usage: {},
        content: [
          { type: "tool_use", id: "t1", name: "apply_db_migration", input: { sql: "drop table public.users" } },
          { type: "tool_use", id: "t2", name: "db_read", input: { sql: "select 1" } },
        ],
      })
      .mockResolvedValueOnce({ stop_reason: "end_turn", usage: {}, content: [{ type: "text", text: "done" }] });
    const dispatch = vi.fn().mockResolvedValue("[]");

    const out = await runAgentLoop({
      agent: "engineering",
      system: "s",
      userMessage: "u",
      tools: [tool("db_read"), tool("save_suggestion")],
      dispatch,
    });

    expect(out.text).toBe("done");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith("engineering", "db_read", { sql: "select 1" });
    expect(logActivity).toHaveBeenCalledWith("engineering", "security:tool-rejected", expect.stringContaining("apply_db_migration"));
    // The model is told the call was rejected (as an error result), not silently dropped.
    const second = create.mock.calls[1][0];
    const results = second.messages[second.messages.length - 1].content;
    const rejected = results.find((r: { tool_use_id: string }) => r.tool_use_id === "t1");
    expect(rejected.is_error).toBe(true);
    expect(rejected.content).toMatch(/not offered/);
  });

  it("on the final turn only save_suggestion may run, even if the model calls db_read", async () => {
    create.mockResolvedValue({
      stop_reason: "tool_use",
      usage: {},
      content: [{ type: "tool_use", id: "x", name: "db_read", input: { sql: "select 1" } }],
    });
    const dispatch = vi.fn().mockResolvedValue("[]");
    await runAgentLoop({ agent: "engineering", system: "s", userMessage: "u", tools: [tool("db_read"), tool("save_suggestion")], maxTurns: 2, dispatch });
    expect(dispatch).toHaveBeenCalledTimes(1); // turn 1 only; the final-turn db_read is refused
    expect(logActivity).toHaveBeenCalledWith("engineering", "security:tool-rejected", expect.stringContaining("db_read"));
  });
});
