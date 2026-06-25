import { describe, it, expect, vi } from "vitest";

vi.mock("../../lib/supabase", () => ({ supabaseAdmin: { from: () => ({ insert: vi.fn() }) } }));

import { dispatchTool, TOOL_DEFS } from "../registry";

describe("registry", () => {
  it("exposes the six tools", () => {
    expect(TOOL_DEFS.map((t) => t.name)).toContain("queue_social_post");
    expect(TOOL_DEFS).toHaveLength(6);
  });
  it("handles unknown tools gracefully", async () => {
    expect(await dispatchTool("marketing", "nope", {})).toBe("Unknown tool: nope");
  });
});
