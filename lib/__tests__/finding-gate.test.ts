import { describe, it, expect } from "vitest";
import { evaluateFinding, parseFindingInput, independentSources, containsValue, HEDGE, ABSENCE_LANGUAGE, type GateResult } from "../finding-gate";
import { EvidenceLedger } from "../evidence-ledger";
import { case1, ledgerWith, OUT, PIN, OTHER_PIN, RANKING_REPO, LEADERBOARD, CITIES, MATCHES_PAGE } from "./finding-fixtures";

const accept = (r: GateResult) => {
  if (r.decision !== "accept") throw new Error(`expected accept, got ${r.code}: ${r.reasons.join(" | ")}`);
  return r;
};
const reject = (r: GateResult) => {
  if (r.decision !== "reject") throw new Error(`expected reject, got ${r.finalClass}`);
  return r;
};
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe("evidence gate: evidence must come from this run's tool output", () => {
  it("valid evidence from the current run is accepted, with line numbers taken from the tool output", () => {
    const { run, input } = case1();
    const r = accept(evaluateFinding(input, run.ledger));
    expect(r.evidence.map((e) => `${e.file}:${e.startLine}`)).toEqual([`${RANKING_REPO}:7`, `${LEADERBOARD}:169`, `${LEADERBOARD}:169`]);
    expect(r.evidence.every((e) => e.commit === PIN)).toBe(true);
  });

  it("omitted line numbers are filled in from the tool output, never guessed", () => {
    const { run, input } = case1();
    const ev = (input.evidence as Record<string, unknown>[]).map((e) => ({ ref: e.ref, excerpt: e.excerpt }));
    const r = accept(evaluateFinding({ ...input, evidence: ev }, run.ledger));
    expect(r.evidence[0]).toMatchObject({ file: RANKING_REPO, startLine: 7, endLine: 7 });
  });

  it("evidence from another run is rejected (its ref does not exist in this run)", () => {
    const a = case1();
    const b = case1(); // same tool calls, different run
    const r = reject(evaluateFinding(a.input, b.run.ledger));
    expect(r.code).toBe("invalid_evidence");
    expect(r.reasons.join(" ")).toMatch(/was not returned by any tool in this run/);
  });

  it("a ref that looks right but was never issued is rejected", () => {
    const { run, input } = case1();
    const bad = clone(input) as Record<string, unknown>;
    (bad.evidence as Record<string, unknown>[])[0].ref = "ev1-000000";
    expect(reject(evaluateFinding(bad, run.ledger)).code).toBe("invalid_evidence");
  });

  it("evidence citing a different commit is rejected", () => {
    const { run, input } = case1();
    const bad = clone(input) as Record<string, unknown>;
    (bad.evidence as Record<string, unknown>[])[0].commit = OTHER_PIN;
    const r = reject(evaluateFinding(bad, run.ledger));
    expect(r.reasons.join(" ")).toMatch(/different commit/);
  });

  it("tool output from a different commit never becomes evidence in the first place", () => {
    const l = new EvidenceLedger({ commit: PIN });
    expect(l.record("read_repo_file", {}, OUT.cities().replace(PIN, OTHER_PIN))).toBeNull();
  });

  it("an invented line number is rejected, and the reason names where the tool really showed it", () => {
    const { run, input } = case1();
    const bad = clone(input) as Record<string, unknown>;
    (bad.evidence as Record<string, unknown>[])[0].start_line = 6; // the real suggestion claimed line 6
    const r = reject(evaluateFinding(bad, run.ledger));
    expect(r.code).toBe("invalid_evidence");
    expect(r.reasons[0]).toMatch(/ranking_repository\.dart line 7/);
  });

  it("an excerpt that is not in the tool output is rejected (no fuzzy matching)", () => {
    const { run, input } = case1();
    const bad = clone(input) as Record<string, unknown>;
    (bad.evidence as Record<string, unknown>[])[0].excerpt = "static const int minMatches = 5;";
    expect(reject(evaluateFinding(bad, run.ledger)).reasons[0]).toMatch(/does not appear/);
  });

  it("a missing source (no ref) is rejected", () => {
    const { run, input } = case1();
    const bad = clone(input) as Record<string, unknown>;
    delete (bad.evidence as Record<string, unknown>[])[0].ref;
    expect(reject(evaluateFinding(bad, run.ledger)).reasons[0]).toMatch(/missing ref/);
  });

  it("claiming a source that was never read is rejected (ref is a read of another file)", () => {
    const { run, input } = case1();
    const bad = clone(input) as Record<string, unknown>;
    (bad.evidence as Record<string, unknown>[])[0].file = CITIES;
    expect(reject(evaluateFinding(bad, run.ledger)).reasons[0]).toMatch(/is a read of .*ranking_repository\.dart, not of the file cited/);
  });

  it("a location file the run never looked at is rejected", () => {
    const { run, input } = case1();
    const r = reject(evaluateFinding({ ...input, location: { file: MATCHES_PAGE, symbol: "_propose" } }, run.ledger));
    expect(r.reasons[0]).toMatch(/was not read or found/);
  });

  it("a location line not shown by the tool is rejected", () => {
    const { run, input } = case1();
    const r = reject(evaluateFinding({ ...input, location: { file: LEADERBOARD, symbol: "EmptyView.hint", line: 188 } }, run.ledger));
    expect(r.reasons[0]).toMatch(/location\.line is not covered/);
  });

  it("row prefixes and whitespace are normalised, but tokens must match exactly", () => {
    const { run, input } = case1();
    const ok = clone(input) as Record<string, unknown>;
    (ok.evidence as Record<string, unknown>[])[0].excerpt = "7|   static const int   minMatches = 2;";
    accept(evaluateFinding(ok, run.ledger));
    (ok.evidence as Record<string, unknown>[])[0].excerpt = "static const int minmatches = 2;";
    reject(evaluateFinding(ok, run.ledger));
  });

  it("multi-line excerpts must be consecutive lines of the same window", () => {
    const { ledger, refs } = ledgerWith([["read_repo_file", { path: CITIES }, OUT.cities()]]);
    const base = { class: "plausible_risk", title: "t", location: { file: CITIES, symbol: "canonicalCity" }, claim: "Unknown cities map to null.", failure_scenario: "f", impact: "i", proposed_change: "p", priority: "low" };
    const good = accept(evaluateFinding({ ...base, evidence: [{ ref: refs[0], excerpt: "  for (final c in kCities) {\n    if (c.toLowerCase() == v) return c;\n  }" }] }, ledger));
    expect(good.evidence[0]).toMatchObject({ startLine: 16, endLine: 18 });
    reject(evaluateFinding({ ...base, evidence: [{ ref: refs[0], excerpt: "for (final c in kCities) {\n  return null;" }] }, ledger));
  });

  it("data evidence (db_read) must match the output and cannot carry files or line numbers", () => {
    const { ledger, refs } = ledgerWith([["db_read", { sql: "select city, count(*)" }, "[{\"city\":\"Limassol\",\"count\":3}]"]]);
    const base = { class: "plausible_risk", title: "t", claim: "Three teams are in Limassol.", failure_scenario: "f", impact: "i", proposed_change: "p", priority: "low" };
    accept(evaluateFinding({ ...base, evidence: [{ ref: refs[0], excerpt: "\"city\":\"Limassol\",\"count\":3" }] }, ledger));
    reject(evaluateFinding({ ...base, evidence: [{ ref: refs[0], excerpt: "\"city\":\"Paphos\",\"count\":3" }] }, ledger));
    reject(evaluateFinding({ ...base, evidence: [{ ref: refs[0], start_line: 1, excerpt: "\"city\":\"Limassol\",\"count\":3" }] }, ledger));
  });
});

describe("class policy", () => {
  it("verified_bug with valid evidence, a mismatch and a disproof attempt is accepted as a verified bug", () => {
    const { run, input } = case1();
    const r = accept(evaluateFinding(input, run.ledger));
    expect(r).toMatchObject({ finalClass: "verified_bug", category: "bug", priority: "medium", downgraded: [] });
  });

  it("verified_bug without a disproof attempt is downgraded to a risk (evidence still valid)", () => {
    const { run, input } = case1();
    for (const d of ["", "none", "n/a", "checked"]) {
      const r = accept(evaluateFinding({ ...input, what_checked_to_disprove: d }, run.ledger));
      expect(r.finalClass).toBe("plausible_risk");
      expect(r.downgraded.join(" ")).toMatch(/what_checked_to_disprove/);
    }
  });

  it("a hedged verified claim is downgraded to a risk", () => {
    const { run, input } = case1();
    const r = accept(evaluateFinding({ ...input, claim: "The hint might say 5+ matches while RankingRepository.minMatches is 2." }, run.ledger));
    expect(r.finalClass).toBe("plausible_risk");
    expect(r.downgraded.join(" ")).toMatch(/hedged \("might"\)/);
  });

  it("a verified_bug with a single source is downgraded (needs 2 independent sources)", () => {
    const { run, input, refs } = case1();
    const r = accept(evaluateFinding({ ...input, evidence: [{ ref: refs[1], excerpt: "? 'Players appear here after playing 5+ matches.'" }], assertion: { kind: "presence" } }, run.ledger));
    expect(r.finalClass).toBe("plausible_risk");
    expect(r.downgraded.join(" ")).toMatch(/fewer than 2 independent sources/);
  });

  it("unsupported verified_bug (no evidence) is rejected, not downgraded", () => {
    const { run, input } = case1();
    const r = reject(evaluateFinding({ ...input, evidence: [] }, run.ledger));
    expect(r.code).toBe("invalid_input");
  });

  it("verified_bug with a fabricated excerpt is rejected, never downgraded", () => {
    const { run, input } = case1();
    const bad = clone(input) as Record<string, unknown>;
    (bad.evidence as Record<string, unknown>[])[1].excerpt = "hint: 'Players appear here after playing 10+ matches.'";
    expect(reject(evaluateFinding(bad, run.ledger)).code).toBe("invalid_evidence");
  });

  it("verified_bug needs a location file and symbol", () => {
    const { run, input } = case1();
    expect(reject(evaluateFinding({ ...input, location: { file: LEADERBOARD } }, run.ledger)).code).toBe("invalid_input");
  });

  it("plausible_risk stays a risk and is capped below high priority", () => {
    const { run, input } = case1();
    const r = accept(evaluateFinding({ ...input, class: "plausible_risk", priority: "high" }, run.ledger));
    expect(r).toMatchObject({ finalClass: "plausible_risk", category: "risk", priority: "medium" });
  });

  it("product_idea stays an idea: always low priority, never a bug category", () => {
    const l = new EvidenceLedger({ commit: PIN });
    const idea = { class: "product_idea", title: "Show a rankings countdown", claim: "Tell players how many matches until they are ranked.", impact: "Motivation", proposed_change: "Add a progress chip", priority: "high" };
    const r = accept(evaluateFinding(idea, l));
    expect(r).toMatchObject({ finalClass: "product_idea", priority: "low", category: "idea" });
    for (const c of ["bug", "Security", "regression", "defect", "risk"]) expect(accept(evaluateFinding({ ...idea, category: c }, l)).category).toBe("idea");
    expect(accept(evaluateFinding({ ...idea, category: "video-idea" }, l)).category).toBe("video-idea");
  });

  it("a product idea cannot become a high-priority bug, whatever it is given", () => {
    const { run, input } = case1();
    // Full verified-bug evidence, but submitted as an idea: stays an idea, low priority.
    const r = accept(evaluateFinding({ ...input, class: "product_idea", priority: "high", category: "bug" }, run.ledger));
    expect(r).toMatchObject({ finalClass: "product_idea", priority: "low", category: "idea" });
  });

  it("a claim that something is missing needs an absence proof", () => {
    const { ledger, refs } = ledgerWith([["read_repo_file", { path: CITIES }, OUT.cities()], ["search_code", { query: "trackCityMiss", path: "lib" }, `search_code "trackCityMiss" in lib\nrepo: Chrysostomos77Antoniou/footrank @ ${PIN} (pinned for this run; uncommitted local work is not searched)\n\nNo matches.`]]);
    const base = { class: "plausible_risk", title: "Unknown cities are not logged", location: { file: CITIES, symbol: "canonicalCity" }, claim: "canonicalCity does not log unknown city strings.", failure_scenario: "A stale city silently maps to null.", impact: "No diagnostics.", evidence: [{ ref: refs[0], excerpt: "return null;" }], proposed_change: "Log misses.", priority: "low" };
    expect(reject(evaluateFinding(base, ledger)).code).toBe("unsupported_absence");
    const r = accept(evaluateFinding({ ...base, assertion: { kind: "absence", ref: refs[1] } }, ledger));
    expect(r.finalClass).toBe("plausible_risk");
  });

  it("helpers: independence, token-bounded values, hedge and absence vocabularies", () => {
    expect(independentSources([
      { index: 1, ref: "a", tool: "read_repo_file", code: true, file: "x", startLine: 1, endLine: 3, excerpt: "" },
      { index: 2, ref: "b", tool: "search_code", code: true, file: "x", startLine: 2, endLine: 2, excerpt: "" },
      { index: 3, ref: "c", tool: "read_repo_file", code: true, file: "y", startLine: 2, endLine: 2, excerpt: "" },
    ])).toBe(2);
    expect(containsValue("static const int minMatches = 2;", "2")).toBe(true);
    expect(containsValue("static const int minMatches = 12;", "2")).toBe(false);
    expect(containsValue("json['match_requests']", "match_request")).toBe(false);
    expect(HEDGE.test("this could crash")).toBe(true);
    expect(HEDGE.test("this crashes")).toBe(false);
    expect(ABSENCE_LANGUAGE.test("Teams can propose matches with fewer than 5 players")).toBe(true);
    expect(parseFindingInput({ class: "bogus" }).ok).toBe(false);
  });
});
