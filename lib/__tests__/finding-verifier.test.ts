import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { saveSuggestion, logActivity } = vi.hoisted(() => ({ saveSuggestion: vi.fn(), logActivity: vi.fn() }));
vi.mock("../suggestions", () => ({ saveSuggestion: (...a: unknown[]) => saveSuggestion(...a) }));
vi.mock("../memory", () => ({ logActivity: (...a: unknown[]) => logActivity(...a) }));
vi.mock("../supabase", () => ({ supabaseAdmin: {} }));

import {
  verifyFinding,
  parseVerifierOutput,
  createVerifierRuntime,
  guardNumbers,
  absenceIdentifiers,
  isGuardLine,
  MAX_VERIFIER_MODEL_CALLS_PER_RUN,
  MAX_VERIFIER_TOOL_CALLS_PER_FINDING,
  MAX_VERIFIER_TOOL_CALLS_PER_RUN,
  VERIFIER_MODEL_TIMEOUT_MS,
  VERIFIER_TIER,
  type VerifierRuntime,
} from "../finding-verifier";
import { evaluateFinding, type GateResult } from "../finding-gate";
import { submitFinding } from "../finding-submit";
import { case1, runWith, fakeRepoTools, fakeModel, fakeVerifier, SURVIVES_JSON, OUT, PIN, MATCHES_PAGE, CITIES } from "./finding-fixtures";
import type { EvidenceLedger } from "../evidence-ledger";

beforeEach(() => {
  saveSuggestion.mockReset();
  logActivity.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

const accepted = (r: GateResult) => {
  if (r.decision !== "accept") throw new Error(`gate rejected: ${r.code} ${r.reasons.join(" | ")}`);
  return r;
};
const verify = (input: Record<string, unknown>, ledger: EvidenceLedger, rt: VerifierRuntime) => {
  const g = accepted(evaluateFinding(input, ledger));
  return verifyFinding({ finding: g.finding, cls: g.finalClass, evidence: g.evidence }, ledger, rt);
};
const J = (o: Record<string, unknown>) => JSON.stringify(o);

// Case 1 with a scripted verifier.
function c1(...replies: (string | Error)[]) {
  const model = fakeModel(...(replies.length ? replies : [SURVIVES_JSON]));
  const tools = fakeRepoTools();
  const rt = fakeVerifier({ tools, model });
  const c = case1();
  return { ...c, rt, model, tools };
}

// The 7b known gap: an absence proof cherry-picked to a query that happens to
// find nothing ("memberCount < 5" scoped to matches_page.dart). It passes the
// gate; the verifier must still reject it.
function cherryPickedCase3(cls = "verified_bug") {
  const { run, refs } = runWith([
    ["read_repo_file", { path: MATCHES_PAGE, start_line: 271, end_line: 310 }, OUT.propose()],
  ]);
  const none = run.ledger.record("search_code", { query: "memberCount < 5", path: MATCHES_PAGE }, `search_code "memberCount < 5" in ${MATCHES_PAGE}\nrepo: Chrysostomos77Antoniou/footrank @ ${PIN} (pinned for this run; uncommitted local work is not searched)\n\nNo matches.`)!;
  const input = {
    class: cls,
    title: "Teams can propose matches with fewer than 5 players",
    location: { file: MATCHES_PAGE, symbol: "_propose", line: 305 },
    claim: "Teams can propose matches with fewer than 5 players.",
    failure_scenario: "A 3-player team taps Send Proposal and the proposal is created.",
    impact: "Matches get scheduled that cannot be played.",
    evidence: [{ ref: refs[0], excerpt: "await _matchRepo.proposeMatch(requestId: opponent.id, teamId: team.id);" }],
    assertion: { kind: "absence", ref: none },
    what_checked_to_disprove: "Searched memberCount < 5 in matches_page.dart: no matches.",
    proposed_change: "Check the member count before proposing.",
    priority: "high",
  };
  return { run, input };
}

describe("verdicts", () => {
  it("SURVIVES: a supported verified bug stays a verified bug after independent probes and one bounded model call", async () => {
    const { run, input, rt, model, tools } = c1(J({ verdict: "SURVIVES", reason_code: "supported", supporting: ["E1", "E2", "P1"], contradicting: [] }));
    const v = await verify(input, run.ledger, rt);
    expect(v).toMatchObject({ verdict: "SURVIVES", reason: "supported", from: "verified_bug", to: "verified_bug", failed: false, stage: "model", modelCalls: 1 });
    // The verifier re-read the cited code itself (with context) and looked for callers/definitions and tests.
    expect(tools.calls).toEqual([
      "read lib/rankings/presentation/widgets/player_leaderboard.dart 144-194",
      "read lib/rankings/data/ranking_repository.dart 1-32",
      'search "hint"',
      'search "hint" in test',
    ]);
    expect(v.toolCalls).toBe(4);
    const req = model.requests[0];
    expect(req.json).toBeDefined();
    expect(req.maxOutputTokens).toBeLessThanOrEqual(600);
    expect(req.tools).toBeUndefined(); // the verifier model gets NO tools at all
    expect(String(req.messages[0].content)).toMatch(/E1 \[read_repo_file lib\/rankings\/data\/ranking_repository\.dart:7\]/);
    expect(String(req.messages[0].content)).toMatch(/P1 — read lib\/rankings\/presentation\/widgets\/player_leaderboard\.dart lines 144-194/);
  });

  it("DOWNGRADE: an overstated bug becomes a risk; an explicit downgrade to an idea is honoured", async () => {
    const a = c1(J({ verdict: "DOWNGRADE", reason_code: "overstated", downgrade_to: null, supporting: ["E1"], contradicting: [] }));
    expect(await verify(a.input, a.run.ledger, a.rt)).toMatchObject({ verdict: "DOWNGRADE", reason: "overstated", to: "plausible_risk" });
    const b = c1(J({ verdict: "DOWNGRADE", reason_code: "impact_unproven", downgrade_to: "product_idea", supporting: [], contradicting: [] }));
    expect(await verify(b.input, b.run.ledger, b.rt)).toMatchObject({ verdict: "DOWNGRADE", reason: "impact_unproven", to: "product_idea" });
  });

  it("REJECT: a finding the verifier finds contradicted is rejected (nothing to save)", async () => {
    const { run, input, rt } = c1(J({ verdict: "REJECT", reason_code: "contradicted", supporting: [], contradicting: ["P2"] }));
    expect(await verify(input, run.ledger, rt)).toMatchObject({ verdict: "REJECT", reason: "contradicted", to: null, failed: false, hard: false, contradicting: ["P2"] });
  });

  it("a verifier can only keep or weaken: 'downgrading' to an equal or stronger class is malformed (fail closed)", async () => {
    const risk = runWith([["read_repo_file", { path: CITIES }, OUT.cities()]]);
    const input = { class: "plausible_risk", title: "t", location: { file: CITIES, symbol: "canonicalCity" }, claim: "Unknown cities map to null.", failure_scenario: "f", impact: "i", evidence: [{ ref: risk.refs[0], excerpt: "return null;" }], proposed_change: "p", priority: "high" };
    for (const d of ["verified_bug", "plausible_risk"]) {
      const rt = fakeVerifier({ model: fakeModel(J({ verdict: "DOWNGRADE", reason_code: "overstated", downgrade_to: d, supporting: [], contradicting: [] })) });
      expect(await verify(input, risk.run.ledger, rt)).toMatchObject({ verdict: "REJECT", reason: "malformed_output", failed: true });
    }
    // SURVIVES keeps a risk a risk — never promoted.
    expect(await verify(input, risk.run.ledger, fakeVerifier())).toMatchObject({ verdict: "SURVIVES", to: "plausible_risk" });
  });

  it("product ideas are never verified into anything: no model call, no probes, stay ideas", async () => {
    const { run, input, rt, model, tools } = c1();
    const v = await verify({ ...input, class: "product_idea" }, run.ledger, rt);
    expect(v).toMatchObject({ verdict: "SURVIVES", reason: "idea_not_verified_as_defect", to: "product_idea", stage: "skipped", modelCalls: 0, toolCalls: 0 });
    expect(model.requests).toHaveLength(0);
    expect(tools.calls).toHaveLength(0);
  });
});

describe("strict output parsing (fail closed)", () => {
  const ids = new Set(["E1", "E2", "P1"]);
  it.each([
    ["prose instead of JSON", "Looks fine to me."],
    ["broken JSON", '{"verdict":"SURVIVES",'],
    ["unknown verdict", J({ verdict: "CONFIRMED", reason_code: "supported", supporting: ["E1"], contradicting: [] })],
    ["lower-case verdict", J({ verdict: "survives", reason_code: "supported", supporting: ["E1"], contradicting: [] })],
    ["reason code that does not fit the verdict", J({ verdict: "SURVIVES", reason_code: "contradicted", supporting: ["E1"], contradicting: [] })],
    ["SURVIVES without supporting ids", J({ verdict: "SURVIVES", reason_code: "supported", supporting: [], contradicting: [] })],
    ["SURVIVES while citing contradicting ids", J({ verdict: "SURVIVES", reason_code: "supported", supporting: ["E1"], contradicting: ["P1"] })],
    ["an id that does not exist (invented evidence)", J({ verdict: "SURVIVES", reason_code: "supported", supporting: ["P9"], contradicting: [] })],
    ["non-string ids", J({ verdict: "REJECT", reason_code: "contradicted", supporting: [], contradicting: [1] })],
    ["duplicate is not the verifier's call (7b history is authoritative)", J({ verdict: "REJECT", reason_code: "duplicate", supporting: [], contradicting: [] })],
  ])("%s", (_l, text) => {
    expect(parseVerifierOutput(text, ids, "verified_bug")).toBeNull();
  });

  it("valid output is accepted, including JSON wrapped in prose or a code fence", () => {
    expect(parseVerifierOutput("```json\n" + J({ verdict: "REJECT", reason_code: "speculative", supporting: [], contradicting: ["P1"] }) + "\n```", ids, "plausible_risk")).toMatchObject({ verdict: "REJECT", reason: "speculative" });
  });

  it("malformed model output means the finding is not verified", async () => {
    const { run, input, rt } = c1("I think this is a real bug.");
    expect(await verify(input, run.ledger, rt)).toMatchObject({ verdict: "REJECT", reason: "malformed_output", failed: true, to: null });
  });
});

describe("failures, timeouts and budget", () => {
  it("provider failure: not verified", async () => {
    const { run, input, rt } = c1(new Error("FREE_AI_QUOTA_EXHAUSTED: no approved free provider"));
    expect(await verify(input, run.ledger, rt)).toMatchObject({ verdict: "REJECT", reason: "model_failed", failed: true });
  });

  it("model timeout: not verified", async () => {
    vi.useFakeTimers();
    const c = case1();
    const rt = fakeVerifier({ model: { generate: () => new Promise(() => {}) } });
    const p = verify(c.input, c.run.ledger, rt);
    await vi.advanceTimersByTimeAsync(VERIFIER_MODEL_TIMEOUT_MS + 1);
    expect(await p).toMatchObject({ verdict: "REJECT", reason: "timeout", failed: true });
  });

  it("a code tool that fails or returns an error cannot verify anything", async () => {
    const c = case1();
    const tools = { ...fakeRepoTools(), readFile: async () => "GitHub 502: could not read x." };
    expect(await verify(c.input, c.run.ledger, fakeVerifier({ tools }))).toMatchObject({ verdict: "REJECT", reason: "tool_failed", failed: true, modelCalls: 0 });
  });

  it("a fresh read at a different commit is refused", async () => {
    const c = case1();
    const tools = fakeRepoTools("1111111111111111111111111111111111111111");
    expect(await verify(c.input, c.run.ledger, fakeVerifier({ tools }))).toMatchObject({ reason: "tool_failed", failed: true });
  });

  it("no pinned code access: code findings cannot be verified", async () => {
    const c = case1();
    const rt = createVerifierRuntime({ model: fakeModel(SURVIVES_JSON) }); // no commit => no tools
    expect(await verify(c.input, c.run.ledger, rt)).toMatchObject({ reason: "no_code_access", failed: true });
  });

  it("a cited excerpt that is not where the fresh read shows it is rejected as not reproducible", async () => {
    const c = case1();
    const base = fakeRepoTools();
    const tools = { ...base, readFile: async (p: string, s: number, e: number) => (await base.readFile(p, s, e)).replace("static const int minMatches = 2;", "static const int minMatches = 5;") };
    expect(await verify(c.input, c.run.ledger, fakeVerifier({ tools }))).toMatchObject({ verdict: "REJECT", reason: "not_reproducible", hard: true, failed: false, modelCalls: 0 });
  });

  it(`model budget: at most ${MAX_VERIFIER_MODEL_CALLS_PER_RUN} verifier calls per run, then fail closed without calling`, async () => {
    const model = fakeModel(SURVIVES_JSON);
    const rt = fakeVerifier({ model });
    const results = [];
    for (let i = 0; i < MAX_VERIFIER_MODEL_CALLS_PER_RUN + 2; i++) {
      const c = case1();
      results.push(await verify(c.input, c.run.ledger, rt));
    }
    expect(model.requests).toHaveLength(MAX_VERIFIER_MODEL_CALLS_PER_RUN);
    expect(results.slice(0, MAX_VERIFIER_MODEL_CALLS_PER_RUN).every((r) => r.verdict === "SURVIVES")).toBe(true);
    expect(results.slice(MAX_VERIFIER_MODEL_CALLS_PER_RUN).map((r) => r.reason)).toEqual(["budget_exhausted", "budget_exhausted"]);
    expect(rt.budget.modelCalls).toBe(MAX_VERIFIER_MODEL_CALLS_PER_RUN);
  });

  it(`tool budget: never more than ${MAX_VERIFIER_TOOL_CALLS_PER_FINDING} per finding or ${MAX_VERIFIER_TOOL_CALLS_PER_RUN} per run`, async () => {
    const c = case1();
    const rt = fakeVerifier();
    rt.budget.toolCalls = MAX_VERIFIER_TOOL_CALLS_PER_RUN - 2; // only 2 left in this run
    expect(await verify(c.input, c.run.ledger, rt)).toMatchObject({ reason: "budget_exhausted", failed: true, toolCalls: 2 });
    expect(rt.budget.toolCalls).toBe(MAX_VERIFIER_TOOL_CALLS_PER_RUN);
    // The heaviest probe plan (2 files re-read, symbol + tests, 2 widened absence searches) stays within the per-finding cap.
    const { run, refs } = runWith([
      ["read_repo_file", { path: MATCHES_PAGE, start_line: 118, end_line: 128 }, OUT.matchesCity()],
      ["read_repo_file", { path: "lib/rankings/data/ranking_repository.dart", start_line: 1, end_line: 20 }, OUT.rankingRepo()],
    ]);
    const none = run.ledger.record("search_code", { query: "members.length < minMatches" }, `search_code "members.length < minMatches"\nrepo: Chrysostomos77Antoniou/footrank @ ${PIN} (pinned for this run; uncommitted local work is not searched)\n\nNo matches.`)!;
    const heavy = { class: "plausible_risk", title: "t", location: { file: MATCHES_PAGE, symbol: "MatchesPage" }, claim: "MatchesPage never checks that a team has at least 5 players.", failure_scenario: "f", impact: "i", evidence: [{ ref: refs[0], excerpt: "_filterCity = canonicalCity(sel.city) ?? kCities.first;" }, { ref: refs[1], excerpt: "static const int minMatches = 2;" }], assertion: { kind: "absence", ref: none }, what_checked_to_disprove: "x", proposed_change: "p", priority: "low" };
    const tools = fakeRepoTools();
    const hv = await verify(heavy, run.ledger, fakeVerifier({ tools }));
    expect(tools.calls).toHaveLength(MAX_VERIFIER_TOOL_CALLS_PER_FINDING);
    expect(hv).toMatchObject({ verdict: "REJECT", reason: "absence_not_established", toolCalls: MAX_VERIFIER_TOOL_CALLS_PER_FINDING });
  });

  it("the verifier uses the medium free tier by default — never the high tier", () => {
    expect(VERIFIER_TIER).toBe("medium");
  });
});

describe("absence claims: one narrow no-match search is never proof", () => {
  it("Case 3 (cherry-picked absence proof that passes the 7b gate) is REJECTED: the re-read function contains the guard at line 298", async () => {
    const { run, input } = cherryPickedCase3();
    const model = fakeModel(SURVIVES_JSON);
    const tools = fakeRepoTools();
    const v = await verify(input, run.ledger, fakeVerifier({ tools, model }));
    expect(v).toMatchObject({ verdict: "REJECT", reason: "contradicted", hard: true, failed: false, stage: "deterministic" });
    expect(v.contradicting).toEqual(["P1:298"]);
    expect(tools.calls[0]).toBe(`read ${MATCHES_PAGE} 280-330`);
    expect(model.requests).toHaveLength(0); // decided without a model call, whatever a model would say
  });

  it("a guard elsewhere in the cited file (found by the widened search) means the absence is not established", async () => {
    const { run, refs } = runWith([["read_repo_file", { path: MATCHES_PAGE, start_line: 118, end_line: 128 }, OUT.matchesCity()]]);
    const none = run.ledger.record("search_code", { query: "memberCount < 5", path: MATCHES_PAGE }, `search_code "memberCount < 5" in ${MATCHES_PAGE}\nrepo: Chrysostomos77Antoniou/footrank @ ${PIN} (pinned for this run; uncommitted local work is not searched)\n\nNo matches.`)!;
    const input = { class: "plausible_risk", title: "No 5-player check on the matches screen", location: { file: MATCHES_PAGE, symbol: "MatchesPage" }, claim: "MatchesPage never checks that a team has at least 5 players.", failure_scenario: "f", impact: "i", evidence: [{ ref: refs[0], excerpt: "_filterCity = canonicalCity(sel.city) ?? kCities.first;" }], assertion: { kind: "absence", ref: none }, what_checked_to_disprove: "searched memberCount < 5", proposed_change: "p", priority: "medium" };
    const tools = fakeRepoTools();
    const model = fakeModel(SURVIVES_JSON);
    const risk = await verify(input, run.ledger, fakeVerifier({ tools, model }));
    // Widened: the identifier of the claimed-missing check was searched repo-wide.
    expect(tools.calls).toContain('search "memberCount"');
    expect(risk).toMatchObject({ verdict: "REJECT", reason: "absence_not_established", hard: false, stage: "deterministic" });
    expect(risk.contradicting).toContain(`P4:${MATCHES_PAGE}:614`);
    expect(model.requests).toHaveLength(0);
    // The same finding as a verified bug is capped at risk, whatever the model says.
    const g = accepted(evaluateFinding(input, run.ledger));
    const bug = await verifyFinding({ finding: g.finding, cls: "verified_bug", evidence: g.evidence }, run.ledger, fakeVerifier());
    expect(bug).toMatchObject({ verdict: "DOWNGRADE", reason: "absence_not_established", to: "plausible_risk" });
  });

  it("an absence claim with no counter-evidence is still not accepted without the model's independent judgement", async () => {
    const { run, refs } = runWith([["read_repo_file", { path: CITIES }, OUT.cities()]]);
    const none = run.ledger.record("search_code", { query: "logCityMiss", path: "lib" }, `search_code "logCityMiss" in lib\nrepo: Chrysostomos77Antoniou/footrank @ ${PIN} (pinned for this run; uncommitted local work is not searched)\n\nNo matches.`)!;
    const input = { class: "plausible_risk", title: "Unknown cities are not logged", location: { file: CITIES, symbol: "canonicalCity" }, claim: "canonicalCity does not log unknown city strings.", failure_scenario: "f", impact: "i", evidence: [{ ref: refs[0], excerpt: "return null;" }], assertion: { kind: "absence", ref: none }, what_checked_to_disprove: "searched logCityMiss", proposed_change: "p", priority: "low" };
    const tools = fakeRepoTools();
    const model = fakeModel(J({ verdict: "DOWNGRADE", reason_code: "absence_not_established", downgrade_to: "product_idea", supporting: ["E1"], contradicting: [] }));
    const v = await verify(input, run.ledger, fakeVerifier({ tools, model }));
    expect(tools.calls).toEqual([`read ${CITIES} 1-39`, 'search "canonicalCity"', 'search "canonicalCity" in test', 'search "logCityMiss"']);
    expect(model.requests).toHaveLength(1);
    expect(v).toMatchObject({ verdict: "DOWNGRADE", reason: "absence_not_established", to: "product_idea" });
  });

  it("helpers: guard numbers, code identifiers, guard lines", () => {
    expect(guardNumbers("Teams can propose matches with fewer than 5 players")).toEqual(["5"]);
    expect(guardNumbers("needs at least 2 matches; Min. 3 teams")).toEqual(["2", "3"]);
    expect(absenceIdentifiers("memberCount < 5")).toEqual(["memberCount"]);
    expect(absenceIdentifiers("members.length < 5")).toEqual(["members.length"]);
    expect(absenceIdentifiers("no validation here")).toEqual([]);
    expect(isGuardLine("    if (members.length < 5) {", ["5"])).toBe(true);
    expect(isGuardLine("final underStaffed = (_memberCount ?? 5) < 5;", ["5"])).toBe(true);
    expect(isGuardLine("static const int minMatches = 25;", ["5"])).toBe(false);
    expect(isGuardLine("const x = items.length < 50;", ["5"])).toBe(false);
  });
});

describe("safety boundary", () => {
  const src = readFileSync(join(__dirname, "..", "finding-verifier.ts"), "utf8");
  const code = src.replace(/\/\/.*$/gm, "");

  it("the verifier has no write, save, alert, memory, DB, PR or merge authority", () => {
    const imports = [...code.matchAll(/from "([^"]+)"/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(["../tools/code-search", "../tools/github-read", "./evidence-ledger", "./finding-gate", "./free-llm", "./llm"]);
    expect(code).not.toMatch(/saveSuggestion|notify|logActivity|writeMemory|supabase|dispatchTool|submit_fix|qa-loop|fix-agent|github-ci|openPullRequest|commitToBranch|merge|process\.env|dbRead|fetch\(/);
  });

  it("the only tools it can call are read_repo_file and search_code, bound to the run's pinned commit", () => {
    const rt = createVerifierRuntime({ commit: PIN, model: fakeModel(SURVIVES_JSON) });
    expect(Object.keys(rt.tools!).sort()).toEqual(["readFile", "searchCode"]);
    expect(createVerifierRuntime({ commit: "HEAD", model: fakeModel(SURVIVES_JSON) }).tools).toBeUndefined();
  });

  it("no secrets or model prose reach the logs or the saved suggestion", async () => {
    const KEY = ["AIza", "Sy", "Q".repeat(33)].join("");
    process.env.GEMINI_API_KEY = KEY;
    try {
      const { run, input } = case1();
      run.verifier = fakeVerifier({ model: fakeModel(J({ verdict: "SURVIVES", reason_code: "supported", supporting: ["E1"], contradicting: [], explanation: `trust me ${KEY} 99% sure` })) });
      await submitFinding("uxdesign", input, { run, title: String(input.title), body: "b" });
      const logged = logActivity.mock.calls.map((c) => String(c[2])).join("\n");
      const saved = String(saveSuggestion.mock.calls[0][0].body);
      for (const text of [logged, saved]) {
        expect(text).not.toContain(KEY);
        expect(text).not.toContain("trust me");
        expect(text).not.toContain("99%");
      }
      const prompt = String((run.verifier.model as ReturnType<typeof fakeModel>).requests[0].messages[0].content);
      expect(prompt).not.toContain(KEY);
    } finally {
      delete process.env.GEMINI_API_KEY;
    }
  });
});
