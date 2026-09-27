// 7c regression benchmark: the five real findings from the 7a audit, run end
// to end through gate -> duplicate check -> independent verifier -> save.
// Verifier model replies are scripted; the deterministic probes are real.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { saveSuggestion, logActivity, notify } = vi.hoisted(() => ({ saveSuggestion: vi.fn(), logActivity: vi.fn(), notify: vi.fn() }));
vi.mock("../suggestions", () => ({ saveSuggestion: (...a: unknown[]) => saveSuggestion(...a) }));
vi.mock("../memory", () => ({ logActivity: (...a: unknown[]) => logActivity(...a) }));
vi.mock("../supabase", () => ({ supabaseAdmin: {} }));
vi.mock("../notify", () => ({ notify: (...a: unknown[]) => notify(...a) }));

import { submitFinding, type FindingRun } from "../finding-submit";
import { parseRejectedDetail } from "../finding-history";
import { fingerprintStored } from "../finding-fingerprint";
import { dispatchTool } from "../../tools/registry";
import { case1, runWith, fakeModel, fakeRepoTools, fakeVerifier, SURVIVES_JSON, OUT, PIN, LEADERBOARD, RANKINGS_PAGE, CITIES, MATCHES_PAGE, MATCH_REPO, PROPOSAL_MODEL } from "./finding-fixtures";

beforeEach(() => {
  saveSuggestion.mockReset();
  logActivity.mockReset();
  notify.mockReset();
});

const J = (o: Record<string, unknown>) => JSON.stringify(o);
const submit = (run: FindingRun, input: Record<string, unknown>, agent: "uxdesign" | "developer" | "qa" = "uxdesign") => submitFinding(agent, input, { run, title: String(input.title), body: "b" });
const verified = () => logActivity.mock.calls.filter((c) => c[1] === "finding:verified").map((c) => JSON.parse(String(c[2])) as Record<string, unknown>);
const withVerifier = (run: FindingRun, ...replies: string[]) => {
  const model = fakeModel(...replies);
  run.verifier = fakeVerifier({ model });
  return model;
};

describe("7c replay 1 — 5+ matches vs minMatches = 2", () => {
  it("survives independent verification and is saved as the only verified bug; it may alert", async () => {
    const { input } = case1();
    const c = case1();
    const model = withVerifier(c.run, J({ verdict: "SURVIVES", reason_code: "supported", supporting: ["E1", "E2", "P1", "P2"], contradicting: [] }));
    const out = await dispatchTool("uxdesign", "save_suggestion", { ...c.input, priority: "high" }, { guardPassed: true, finding: { run: c.run, title: String(input.title), body: "b" } });
    expect(out).toMatch(/^Saved to the owner's suggestions inbox as a VERIFIED BUG \(independent verification: SURVIVES\)/);
    const saved = saveSuggestion.mock.calls[0][0];
    expect(saved).toMatchObject({ category: "bug", priority: "high", title: "[Verified bug] Leaderboard empty-state hint says 5+ matches but ranking needs only 2" });
    expect(saved.body).toContain("**Independent verification:** SURVIVES (supported) · verifier test/fake-verifier");
    expect(saved.body).toContain("Relied on: E1, E2, P1, P2.");
    expect(model.requests).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(verified()[0]).toMatchObject({ verdict: "SURVIVES", reason: "supported", from: "verified_bug", to: "verified_bug", downgraded: false, failed: false, usage: { modelCalls: 1, toolCalls: 4, runModelCalls: "1/3", runToolCalls: "4/18" } });
  });
});

describe("7c replay 2 — city fallback to kCities.first", () => {
  const setup = () => runWith([
    ["read_repo_file", { path: MATCHES_PAGE, start_line: 118, end_line: 128 }, OUT.matchesCity()],
    ["read_repo_file", { path: CITIES }, OUT.cities()],
  ]);
  const claim = (refs: string[]) => ({
    class: "verified_bug",
    title: "Silent city fallback to Nicosia in MatchesPage",
    location: { file: MATCHES_PAGE, symbol: "canonicalCity" },
    claim: "When a team's stored city is outside kCities, MatchesPage switches the match filter to kCities.first (Nicosia).",
    failure_scenario: "A Limassol team whose stored city string is 'Limassol FC' sees Nicosia requests.",
    impact: "Teams may be shown the wrong city.",
    evidence: [{ ref: refs[0], excerpt: "_filterCity = canonicalCity(sel.city) ?? kCities.first;" }, { ref: refs[1], excerpt: "if (c.toLowerCase() == v) return c;" }],
    assertion: { kind: "presence" },
    what_checked_to_disprove: "Read canonicalCity: it trims and lowercases, and tests cover case differences.",
    proposed_change: "Show a banner when the team's city does not map.",
    priority: "high",
  });

  it("never becomes a verified bug: the gate already made it a risk, and a SURVIVES verifier keeps it a risk (no alert)", async () => {
    const { run, refs } = setup();
    withVerifier(run, SURVIVES_JSON);
    await dispatchTool("developer", "save_suggestion", claim(refs), { guardPassed: true, finding: { run, title: "Silent city fallback", body: "b" } });
    expect(saveSuggestion.mock.calls[0][0]).toMatchObject({ category: "risk", priority: "medium", title: "[Risk] Silent city fallback" });
    expect(notify).not.toHaveBeenCalled();
  });

  it("when the verifier finds the impact unproven (no database evidence), it is downgraded to an idea", async () => {
    const { run, refs } = setup();
    withVerifier(run, J({ verdict: "DOWNGRADE", reason_code: "impact_unproven", downgrade_to: "product_idea", supporting: ["E1", "P3"], contradicting: [] }));
    const out = await submit(run, claim(refs), "developer");
    expect(out.saved).toMatchObject({ finalClass: "product_idea", priority: "low", verified: false });
    expect(saveSuggestion.mock.calls[0][0].body).toContain("**Independent verification:** DOWNGRADE (impact_unproven) — Risk → Idea");
    expect(verified()[0]).toMatchObject({ verdict: "DOWNGRADE", from: "plausible_risk", to: "product_idea", downgraded: true });
  });

  it("the verifier looked at the tests that cover canonicalCity (safeguards), not just the cited line", async () => {
    const { run, refs } = setup();
    const tools = fakeRepoTools();
    run.verifier = fakeVerifier({ tools, model: fakeModel(SURVIVES_JSON) });
    await submit(run, claim(refs), "developer");
    expect(tools.calls).toEqual([`read ${MATCHES_PAGE} 98-148`, `read ${CITIES} 1-42`, 'search "canonicalCity"', 'search "canonicalCity" in test']);
  });
});

describe("7c replay 3 — 'Teams can propose matches with fewer than 5 players'", () => {
  const setup = () => runWith([
    ["read_repo_file", { path: MATCHES_PAGE, start_line: 271, end_line: 310 }, OUT.propose()],
    ["search_code", { query: "members.length < 5" }, OUT.searchMembers()],
  ]);
  const base = {
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

  it("the original finding stays rejected (the run's own search found home_page.dart:108 and matches_page.dart:298); no verifier call is spent", async () => {
    const { run, refs } = setup();
    const model = withVerifier(run, SURVIVES_JSON); // even a verifier that would say SURVIVES is never asked
    const out = await submit(run, { ...base, evidence: [{ ref: refs[0], excerpt: "await _matchRepo.proposeMatch(requestId: opponent.id, teamId: team.id);" }, { ref: refs[1], excerpt: "if (members.length < 5) {" }], assertion: { kind: "absence", ref: refs[1] } }, "developer");
    expect(out.message).toMatch(/rejected by the evidence gate \(contradicted\).*home_page\.dart:108.*matches_page\.dart:298/);
    expect(model.requests).toHaveLength(0);
    expect(saveSuggestion).not.toHaveBeenCalled();
  });

  it("a cherry-picked absence proof that slips past the gate is rejected by the verifier (guard at matches_page.dart:298), remembered, and blocked on resubmission", async () => {
    const { run, refs } = setup();
    const model = withVerifier(run, SURVIVES_JSON);
    const none = run.ledger.record("search_code", { query: "memberCount < 5", path: MATCHES_PAGE }, `search_code "memberCount < 5" in ${MATCHES_PAGE}\nrepo: Chrysostomos77Antoniou/footrank @ ${PIN} (pinned for this run; uncommitted local work is not searched)\n\nNo matches.`)!;
    const input = { ...base, evidence: [{ ref: refs[0], excerpt: "await _matchRepo.proposeMatch(requestId: opponent.id, teamId: team.id);" }], assertion: { kind: "absence", ref: none } };
    const out = await submit(run, input, "developer");
    expect(out.message).toBe("Not saved — rejected by independent verification (contradicted).");
    expect(model.requests).toHaveLength(0);
    expect(verified()[0]).toMatchObject({ verdict: "REJECT", reason: "contradicted", hard: true, failed: false, contradicting: ["P1:298"] });
    const rec = logActivity.mock.calls.find((c) => c[1] === "finding:rejected")!;
    expect(parseRejectedDetail(String(rec[2]))).toMatchObject({ code: "verifier_contradicted", print: { symbol: "_propose" } });
    const again = await submit(run, { ...input, title: "Proposals are not limited to full teams" }, "developer");
    expect(again.message).toMatch(/same finding independent verification rejected earlier in this run \(verifier_contradicted\)/);
    expect(saveSuggestion).not.toHaveBeenCalled();
  });
});

describe("7c replay 4 — PostgREST join alias", () => {
  const setup = () => runWith([
    ["read_repo_file", { path: MATCH_REPO, start_line: 278, end_line: 292 }, OUT.sentProposals()],
    ["read_repo_file", { path: PROPOSAL_MODEL, start_line: 50, end_line: 83 }, OUT.proposalModel()],
  ]);
  const evidence = (refs: string[]) => [
    { ref: refs[0], excerpt: "'*, match_requests(city, scheduled_at, match_type, format, teams(name, rating, logo_url))')" },
    { ref: refs[1], excerpt: "final request = json['match_requests'] as Map<String, dynamic>?;" },
  ];

  it("the mismatch claim stays rejected: query and parser both use match_requests (no verifier call)", async () => {
    const { run, refs } = setup();
    const model = withVerifier(run, SURVIVES_JSON);
    const out = await submit(run, { class: "verified_bug", title: "PostgREST join alias mismatch in fetchSentProposals()", location: { file: MATCH_REPO, symbol: "fetchSentProposals" }, claim: "fetchSentProposals embeds match_requests under one key and MatchProposalModel.fromJson reads a different key.", failure_scenario: "f", impact: "i", evidence: evidence(refs), assertion: { kind: "mismatch", a_evidence: 1, a_value: "match_requests", b_evidence: 2, b_value: "match_requests" }, what_checked_to_disprove: "Read the select and the parser.", proposed_change: "Alias the embed.", priority: "medium" }, "qa");
    expect(out.message).toMatch(/rejected by the evidence gate \(contradicted\)/);
    expect(model.requests).toHaveLength(0);
  });

  it("a vaguer risk version that passes the gate is rejected by the verifier when it finds query and parser agree", async () => {
    const { run, refs } = setup();
    const model = withVerifier(run, J({ verdict: "REJECT", reason_code: "contradicted", supporting: [], contradicting: ["E1", "E2", "P2"] }));
    const out = await submit(run, { class: "plausible_risk", title: "PostgREST embed key for sent proposals", location: { file: MATCH_REPO, symbol: "fetchSentProposals" }, claim: "The PostgREST embed key used by fetchSentProposals must match the key MatchProposalModel.fromJson parses.", failure_scenario: "Sent proposals render without city or date.", impact: "Captains cannot see what they proposed.", evidence: evidence(refs), proposed_change: "Alias the embed.", priority: "medium" }, "qa");
    expect(out.message).toBe("Not saved — rejected by independent verification (contradicted).");
    expect(model.requests).toHaveLength(1);
    expect(String(model.requests[0].messages[0].content)).toContain("json['match_requests']");
    const rec = logActivity.mock.calls.find((c) => c[1] === "finding:rejected")!;
    expect(parseRejectedDetail(String(rec[2]))).toMatchObject({ code: "verifier_rejected" }); // a model REJECT is recorded, not permanently blocking
    expect(saveSuggestion).not.toHaveBeenCalled();
  });
});

describe("7c replay 5 — duplicate UX finding about the same threshold", () => {
  it("stays a duplicate: one suggestion, and the verifier is never spent on the duplicate", async () => {
    const { run, input } = case1();
    const model = withVerifier(run, SURVIVES_JSON);
    await submit(run, input);
    const rp = run.ledger.record("read_repo_file", { path: RANKINGS_PAGE, start_line: 40, end_line: 55 }, OUT.rankingsPage())!;
    const second = await submit(run, {
      class: "verified_bug",
      title: "Unify Match Threshold Messaging Across Rankings Screen",
      location: { file: LEADERBOARD, symbol: "EmptyView.hint" },
      claim: "The Rankings header shows Min. RankingRepository.minMatches matches played, but the leaderboard empty state hardcodes 5+ matches.",
      failure_scenario: "Header and empty state disagree.",
      impact: "Inconsistent product messaging.",
      evidence: [{ ref: rp, excerpt: "'Min. ${RankingRepository.minMatches} matches played to be ranked'," }, { ref: (input.evidence as { ref: string }[])[1].ref, excerpt: "? 'Players appear here after playing 5+ matches.'" }],
      what_checked_to_disprove: "Read both screens.",
      proposed_change: "Use RankingRepository.minMatches in the empty state.",
      priority: "low",
    });
    expect(second.message).toMatch(/^Not saved — duplicate of "\[Verified bug\] Leaderboard empty-state hint/);
    expect(saveSuggestion).toHaveBeenCalledTimes(1);
    expect(model.requests).toHaveLength(1);
    expect(verified()).toHaveLength(1);
  });

  it("a verifier downgrade into another family (risk -> idea) is checked against that family's history too", async () => {
    const { run, input } = case1();
    withVerifier(run, J({ verdict: "DOWNGRADE", reason_code: "overstated", downgrade_to: "product_idea", supporting: ["E1"], contradicting: [] }));
    const idea = { title: "Leaderboard empty-state hint wording", body: "Finding-Fingerprint: v1 fp=- family=idea class=product_idea symbol=- files=player_leaderboard.dart anchors=- terms=appear,empty,hint,leaderboard,min,minmatch,ranking,rankingrepository,state" };
    run.history = { entries: [{ id: "idea-1", source: "open", agent: "uxdesign", title: idea.title, createdAt: "2026-09-27T00:00:00Z", print: fingerprintStored(idea) }] };
    const out = await submit(run, input);
    expect(out.message).toMatch(/duplicate: "Leaderboard empty-state hint wording" is already open/);
    expect(saveSuggestion).not.toHaveBeenCalled();
  });
});
