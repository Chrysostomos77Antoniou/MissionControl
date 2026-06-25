import { describe, it, expect, vi } from "vitest";

vi.mock("../../lib/suggestions", () => ({ saveSuggestion: vi.fn() }));

import { dispatchTool, toolsFor } from "../registry";

describe("registry", () => {
  it("gives technical agents codebase tools", () => {
    const sec = toolsFor("cybersecurity").map((t) => t.name);
    expect(sec).toContain("read_repo_file");
    expect(sec).toContain("save_suggestion");
  });
  it("withholds codebase tools from non-technical agents", () => {
    const mkt = toolsFor("marketing").map((t) => t.name);
    expect(mkt).not.toContain("read_repo_file");
    expect(mkt).toContain("web_search");
  });
  it("handles unknown tools gracefully", async () => {
    expect(await dispatchTool("marketing", "nope", {})).toBe("Unknown tool: nope");
  });
});
