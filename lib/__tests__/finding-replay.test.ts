// Regression replay of the five real Mission Control findings audited in 7a
// (FootRank commit 27e1e5a). Tool outputs are the real ones; the submissions
// mirror what the agents actually claimed (including their wrong line numbers).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { saveSuggestion, logActivity } = vi.hoisted(() => ({ saveSuggestion: vi.fn(), logActivity: vi.fn() }));
vi.mock("../suggestions", () => ({ saveSuggestion: (...a: unknown[]) => saveSuggestion(...a) }));
vi.mock("../memory", () => ({ logActivity: (...a: unknown[]) => logActivity(...a) }));
vi.mock("../supabase", () => ({ supabaseAdmin: {} }));

import { evaluateFinding, type GateResult } from "../finding-gate";
import { submitFinding } from "../finding-submit";
import { parseRejectedDetail } from "../finding-history";
import { case1, runWith, OUT, LEADERBOARD, RANKINGS_PAGE, CITIES, MATCHES_PAGE, MATCH_REPO, PROPOSAL_MODEL } from "./finding-fixtures";

beforeEach(() => {
  saveSuggestion.mockReset();
  logActivity.mockReset();
});

const outcome = (r: GateResult) => (r.decision === "accept" ? { decision: "accept", cls: r.finalClass } : { decision: "reject", code: r.code });

describe("replay 1 — leaderboard hint says 5+ matches, RankingRepository.minMatches is 2", () => {
  it("is accepted as a verified bug", () => {
    const { run, input } = case1();
    expect(outcome(evaluateFinding(input, run.ledger))).toEqual({ decision: "accept", cls: "verified_bug" });
  });

  it("the agent's original citations (player_leaderboard.dart:187-190, ranking_repository.dart:6) are rejected as invented line numbers", () => {
    const { run, input, refs } = case1();
    const r = evaluateFinding({ ...input, evidence: [
      { ref: refs[0], file: "lib/rankings/data/ranking_repository.dart", start_line: 6, excerpt: "minMatches = 2" },
      { ref: refs[1], file: LEADERBOARD, start_line: 187, end_line: 190, excerpt: "? 'Players appear here after playing 5+ matches.'" },
    ] }, run.ledger);
    expect(outcome(r)).toEqual({ decision: "reject", code: "invalid_evidence" });
    if (r.decision === "reject") expect(r.reasons.join(" ")).toMatch(/line 7\).*line 169\)/);
  });
});

describe("replay 2 — city fallback to kCities.first", () => {
  const setup = () => runWith([
    ["read_repo_file", { path: MATCHES_PAGE, start_line: 118, end_line: 128 }, OUT.matchesCity()],
    ["read_repo_file", { path: CITIES }, OUT.cities()],
    ["search_code", { query: "canonicalCity(" }, OUT.searchCanonicalCity()],
  ]);
  const claim = {
    class: "verified_bug",
    title: "Silent city fallback to Nicosia in MatchesPage",
    location: { file: MATCHES_PAGE, symbol: "canonicalCity" },
    claim: "When a team's stored city is outside kCities, MatchesPage switches the match filter to kCities.first (Nicosia).",
    failure_scenario: "A Limassol team whose stored city string is 'Limassol FC' sees Nicosia requests.",
    impact: "Teams may be shown the wrong city.",
    what_checked_to_disprove: "Read canonicalCity: it trims and lowercases, and tests cover case differences.",
    proposed_change: "Show a banner when the team's city does not map.",
    priority: "medium",
  };

  it("is NOT a verified bug merely because the fallback exists: downgraded to a risk (impact unproven without database evidence)", () => {
    const { run, refs } = setup();
    const r = evaluateFinding({ ...claim, evidence: [
      { ref: refs[0], excerpt: "_filterCity = canonicalCity(sel.city) ?? kCities.first;" },
      { ref: refs[1], excerpt: "if (c.toLowerCase() == v) return c;" },
    ], assertion: { kind: "presence" } }, run.ledger);
    expect(outcome(r)).toEqual({ decision: "accept", cls: "plausible_risk" });
    if (r.decision === "accept") expect(r.downgraded.join(" ")).toMatch(/no machine-checkable assertion/);
  });

  it("the agent's original citation (matches_page.dart:104 and 160) is rejected as an invented line number", () => {
    const { run, refs } = setup();
    const r = evaluateFinding({ ...claim, evidence: [
      { ref: refs[0], file: MATCHES_PAGE, start_line: 104, excerpt: "_filterCity = canonicalCity(sel.city) ?? kCities.first;" },
      { ref: refs[2], file: MATCHES_PAGE, start_line: 160, excerpt: "_filterCity = canonicalCity(team.city) ?? kCities.first;" },
    ] }, run.ledger);
    expect(outcome(r)).toEqual({ decision: "reject", code: "invalid_evidence" });
  });

  it("the original wording ('doesn't match', 'silently falls back') without an absence proof is rejected as unsupported", () => {
    const { run, refs } = setup();
    const r = evaluateFinding({ ...claim, class: "plausible_risk", claim: "If the team city doesn't match canonical keys the app silently falls back to Nicosia.", evidence: [{ ref: refs[0], excerpt: "?? kCities.first;" }] }, run.ledger);
    expect(outcome(r)).toEqual({ decision: "reject", code: "unsupported_absence" });
  });
});

describe("replay 3 — 'Teams can propose matches with fewer than 5 players'", () => {
  const setup = () => runWith([
    ["read_repo_file", { path: MATCHES_PAGE, start_line: 271, end_line: 310 }, OUT.propose()],
    ["search_code", { query: "members.length < 5" }, OUT.searchMembers()],
  ]);
  const claim = {
    class: "verified_bug",
    title: "Teams can propose matches with fewer than 5 players",
    location: { file: MATCHES_PAGE, symbol: "_propose", line: 305 },
    claim: "Teams can propose matches with fewer than 5 players.",
    failure_scenario: "A 3-player team taps Send Proposal and the proposal is created.",
    impact: "Matches get scheduled that cannot be played.",
    what_checked_to_disprove: "Read _propose up to the proposeMatch call.",
    proposed_change: "Check the member count before proposing.",
    priority: "high",
  };

  it("is rejected when the real guard is in the evidence: the absence claim is contradicted by the run's own search", () => {
    const { run, refs } = setup();
    const r = evaluateFinding({ ...claim, evidence: [
      { ref: refs[0], excerpt: "await _matchRepo.proposeMatch(requestId: opponent.id, teamId: team.id);" },
      { ref: refs[1], excerpt: "if (members.length < 5) {", file: MATCHES_PAGE },
    ], assertion: { kind: "absence", ref: refs[1] } }, run.ledger);
    expect(outcome(r)).toEqual({ decision: "reject", code: "contradicted" });
    if (r.decision === "reject") expect(r.reasons[0]).toMatch(/found it \(lib\/home\/presentation\/pages\/home_page\.dart:108, lib\/match\/presentation\/pages\/matches_page\.dart:298\)/);
  });

  it("is rejected as unsupported when submitted without any absence proof", () => {
    const { run, refs } = setup();
    const r = evaluateFinding({ ...claim, evidence: [{ ref: refs[0], excerpt: "await _matchRepo.proposeMatch(requestId: opponent.id, teamId: team.id);" }] }, run.ledger);
    expect(outcome(r)).toEqual({ decision: "reject", code: "unsupported_absence" });
  });

  it("a narrower search that finds nothing is still contradicted by the read of the same file", () => {
    const { run, refs } = setup();
    const none = run.ledger.record("search_code", { query: "members.length < 5", path: MATCHES_PAGE }, `search_code "members.length < 5" in ${MATCHES_PAGE}\nrepo: Chrysostomos77Antoniou/footrank @ ${run.ledger.commit} (pinned for this run; uncommitted local work is not searched)\n\nNo matches.`)!;
    const r = evaluateFinding({ ...claim, evidence: [{ ref: refs[0], excerpt: "await _matchRepo.proposeMatch(requestId: opponent.id, teamId: team.id);" }], assertion: { kind: "absence", ref: none } }, run.ledger);
    expect(outcome(r)).toEqual({ decision: "reject", code: "contradicted" });
  });

  it("the real 2026-09-26 variant (product idea citing matches_page.dart:253-258) is rejected: the guard is at line 298", () => {
    const { run, refs } = setup();
    const r = evaluateFinding({ class: "product_idea", title: "Lower Barrier for Proposing Matches", claim: "Allow proposing before the roster is full.", impact: "More proposals.", proposed_change: "Warn instead of block.", priority: "medium",
      evidence: [{ ref: refs[0], file: MATCHES_PAGE, start_line: 253, end_line: 258, excerpt: "if (members.length < 5) {" }] }, run.ledger);
    expect(outcome(r)).toEqual({ decision: "reject", code: "invalid_evidence" });
  });

  it("a rejection is remembered in compact form so the same weak finding cannot return", async () => {
    const { run, refs } = setup();
    const out = await submitFinding("developer", { ...claim, evidence: [
      { ref: refs[0], excerpt: "await _matchRepo.proposeMatch(requestId: opponent.id, teamId: team.id);" },
      { ref: refs[1], excerpt: "if (members.length < 5) {" },
    ], assertion: { kind: "absence", ref: refs[1] } }, { run, title: claim.title, body: "b" });
    expect(out.message).toMatch(/^Not saved — rejected by the evidence gate \(contradicted\)/);
    expect(saveSuggestion).not.toHaveBeenCalled();
    const rec = logActivity.mock.calls.find((c) => c[1] === "finding:rejected")!;
    expect(parseRejectedDetail(String(rec[2]))).toMatchObject({ code: "contradicted", cls: "verified_bug", print: { family: "defect", symbol: "_propose", files: ["home_page.dart", "matches_page.dart"] } });
    // Resubmitting it in the same run is blocked even with an absence proof that now "passes".
    const none = run.ledger.record("search_code", { query: "memberCount < 5", path: MATCHES_PAGE }, `search_code "memberCount < 5" in ${MATCHES_PAGE}\nrepo: Chrysostomos77Antoniou/footrank @ ${run.ledger.commit} (pinned for this run; uncommitted local work is not searched)\n\nNo matches.`)!;
    const again = await submitFinding("developer", { ...claim, class: "plausible_risk", evidence: [{ ref: refs[0], excerpt: "await _matchRepo.proposeMatch(requestId: opponent.id, teamId: team.id);" }], assertion: { kind: "absence", ref: none } }, { run, title: claim.title, body: "b" });
    expect(again.message).toMatch(/same finding the evidence gate rejected earlier in this run \(contradicted\)/);
    expect(saveSuggestion).not.toHaveBeenCalled();
  });
});

describe("replay 4 — 'Potential PostgREST join alias mismatch in fetchSentProposals()'", () => {
  const setup = () => runWith([
    ["read_repo_file", { path: MATCH_REPO, start_line: 278, end_line: 292 }, OUT.sentProposals()],
    ["read_repo_file", { path: PROPOSAL_MODEL, start_line: 50, end_line: 83 }, OUT.proposalModel()],
  ]);
  const base = {
    class: "verified_bug",
    title: "PostgREST join alias mismatch in fetchSentProposals()",
    location: { file: MATCH_REPO, symbol: "fetchSentProposals" },
    claim: "fetchSentProposals embeds match_requests under one key and MatchProposalModel.fromJson reads a different key.",
    failure_scenario: "Sent proposals render without city or date.",
    impact: "Captains cannot see what they proposed.",
    what_checked_to_disprove: "Read the select in fetchSentProposals and the fromJson parser.",
    proposed_change: "Alias the embed.",
    priority: "medium",
  };

  it("is rejected when the query and parser evidence use the same key", () => {
    const { run, refs } = setup();
    const r = evaluateFinding({ ...base, evidence: [
      { ref: refs[0], excerpt: "'*, match_requests(city, scheduled_at, match_type, format, teams(name, rating, logo_url))')" },
      { ref: refs[1], excerpt: "final request = json['match_requests'] as Map<String, dynamic>?;" },
    ], assertion: { kind: "mismatch", a_evidence: 1, a_value: "match_requests", b_evidence: 2, b_value: "match_requests" } }, run.ledger);
    expect(outcome(r)).toEqual({ decision: "reject", code: "contradicted" });
  });

  it("a mismatch value that is not literally in the excerpt (e.g. 'match_request') is rejected", () => {
    const { run, refs } = setup();
    const r = evaluateFinding({ ...base, evidence: [
      { ref: refs[0], excerpt: "'*, match_requests(city, scheduled_at, match_type, format, teams(name, rating, logo_url))')" },
      { ref: refs[1], excerpt: "final request = json['match_requests'] as Map<String, dynamic>?;" },
    ], assertion: { kind: "mismatch", a_evidence: 1, a_value: "match_requests", b_evidence: 2, b_value: "match_request" } }, run.ledger);
    expect(outcome(r)).toEqual({ decision: "reject", code: "invalid_evidence" });
  });

  it("the agent's original submission (line 228, hedged 'doesn't match') is rejected", () => {
    const { run, refs } = setup();
    const original = { ...base, class: "plausible_risk", title: "Potential PostgREST Join Alias Mismatch in fetchSentProposals()", claim: "If the joined match_requests table doesn't match the model's expected JSON structure, unhandled parsing exceptions can occur." };
    const wrongLine = evaluateFinding({ ...original, evidence: [{ ref: refs[0], file: MATCH_REPO, start_line: 228, excerpt: ".select('*, match_requests(city, scheduled_at, match_type, format, teams(name, rating, logo_url))')" }] }, run.ledger);
    expect(outcome(wrongLine)).toEqual({ decision: "reject", code: "invalid_evidence" });
    const rightLine = evaluateFinding({ ...original, evidence: [{ ref: refs[0], excerpt: "'*, match_requests(city, scheduled_at, match_type, format, teams(name, rating, logo_url))')" }] }, run.ledger);
    expect(outcome(rightLine)).toEqual({ decision: "reject", code: "unsupported_absence" });
  });
});

describe("replay 5 — the duplicate UX finding about the same 5+ vs 2 threshold", () => {
  it("is detected as a duplicate of the underlying finding; only one suggestion is created", async () => {
    const { run, input } = case1();
    const first = await submitFinding("uxdesign", input, { run, title: String(input.title), body: "b" });
    expect(first.saved).toMatchObject({ finalClass: "verified_bug", title: "[Verified bug] Leaderboard empty-state hint says 5+ matches but ranking needs only 2" });
    const rp = run.ledger.record("read_repo_file", { path: RANKINGS_PAGE, start_line: 40, end_line: 55 }, OUT.rankingsPage())!;
    const second = await submitFinding("uxdesign", {
      class: "verified_bug",
      title: "Unify Match Threshold Messaging Across Rankings Screen",
      location: { file: LEADERBOARD, symbol: "EmptyView.hint" },
      claim: "The Rankings header shows Min. RankingRepository.minMatches matches played, but the leaderboard empty state hardcodes 5+ matches.",
      failure_scenario: "Header and empty state disagree.",
      impact: "Inconsistent product messaging.",
      evidence: [
        { ref: rp, excerpt: "'Min. ${RankingRepository.minMatches} matches played to be ranked'," },
        { ref: (input.evidence as { ref: string }[])[1].ref, excerpt: "? 'Players appear here after playing 5+ matches.'" },
      ],
      what_checked_to_disprove: "Read the rankings header and the leaderboard empty state.",
      proposed_change: "Use RankingRepository.minMatches in the empty state.",
      priority: "low",
    }, { run, title: "Unify Match Threshold Messaging Across Rankings Screen", body: "b" });
    expect(second.saved).toBeUndefined();
    expect(second.message).toMatch(/^Not saved — duplicate of "\[Verified bug\] Leaderboard empty-state hint/);
    expect(saveSuggestion).toHaveBeenCalledTimes(1);
    const rel = logActivity.mock.calls.find((c) => c[1] === "finding:evidence-added");
    expect(JSON.parse(String(rel![2]))).toMatchObject({ newAnchors: ["rankings_page.dart:49"] });
  });
});
