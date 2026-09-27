import { describe, it, expect, vi } from "vitest";

vi.mock("../../lib/supabase", () => ({ supabaseAdmin: {} }));
import { AGENTS } from "../registry";
import { toolsFor } from "../../tools/registry";

// The agent instructions must describe the CURRENT save_suggestion contract
// (7b gate + 7c verifier), without pressuring agents to manufacture findings.
describe("agent prompts match the structured finding contract", () => {
  it.each(AGENTS.map((a) => [a.id, a.system] as const))("%s: classes, evidence refs, honesty rules and zero-findings permission", (_id, system) => {
    // 1. the three classes
    for (const c of ["verified_bug", "plausible_risk", "product_idea"]) expect(system).toContain(c);
    // 2. submit only a concrete new finding that actually exists
    expect(system).toContain("Use save_suggestion for each concrete NEW finding when one actually exists");
    // 3. investigate code findings first
    expect(system).toContain("Investigate code findings before submitting");
    // 4-6. evidence refs from the four recorded tools; never invented
    expect(system).toContain("Results from read_repo_file, search_code, read_footrank_stats and db_read end with an evidence ref");
    expect(system).toContain("cite the refs from THIS run");
    expect(system).toContain("Never invent an evidence ref, an excerpt or a line number");
    // 7. ideas need no evidence but must be genuinely new
    expect(system).toContain("A product idea needs no evidence, but it must be a genuinely new, concrete idea");
    // 8. required content for bugs and risks
    expect(system).toMatch(/Bugs and risks must state: the specific claim, the failure scenario \(where applicable\), the impact, the proposed change, what you checked to disprove it, and the supporting evidence/);
    // 9. absence claims
    expect(system).toMatch(/Absence claims \("no validation", "missing guard", "never checked", "fewer than N"\)/);
    // 10. no resubmitting open/done/dismissed findings without new evidence
    expect(system).toContain("Do not resubmit a finding that is open, done or dismissed");
    // 11. zero findings stays valid (both the procedure and the contract say so)
    expect(system).toContain("Saving zero findings is completely valid when nothing new is warranted");
    expect(system).toContain("IT IS CORRECT to save zero or very few new suggestions");
    // 12-13. scope-honest conclusions
    expect(system).toContain("SCOPE-HONEST CONCLUSIONS");
    expect(system).toContain('never "all systems checked"');
  });

  it("no prompt pressures the agent to submit or keeps the old free-form wording", () => {
    for (const a of AGENTS) {
      expect(a.system).not.toMatch(/must (always )?(submit|save) (a|at least one) (finding|suggestion)/i);
      expect(a.system).not.toMatch(/at all costs/i);
      expect(a.system).not.toContain("Each suggestion must contain: the specific problem");
      expect(a.system).not.toContain("Use save_suggestion for each concrete recommendation");
    }
  });

  it("agents that can read code are told about search_code, and every agent that is told has the tool", () => {
    for (const a of AGENTS) {
      const hasSearch = toolsFor(a.id).some((t) => t.name === "search_code");
      if (a.system.includes("search_code (exact-text search")) expect(hasSearch).toBe(true);
      if (hasSearch) expect(a.system).toContain("search_code (exact-text search: definitions, callers, tests)");
    }
  });

  it("the prompt's classes match the save_suggestion schema", () => {
    const save = toolsFor("developer").find((t) => t.name === "save_suggestion")!;
    const cls = (save.input_schema.properties as Record<string, { enum?: string[] }>).class.enum;
    expect(cls).toEqual(["verified_bug", "plausible_risk", "product_idea"]);
  });
});
