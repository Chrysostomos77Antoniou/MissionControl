import { describe, it, expect, vi, beforeEach } from "vitest";

const { saveSuggestion, logActivity } = vi.hoisted(() => ({ saveSuggestion: vi.fn(), logActivity: vi.fn() }));
vi.mock("../suggestions", () => ({ saveSuggestion: (...a: unknown[]) => saveSuggestion(...a) }));
vi.mock("../memory", () => ({ logActivity: (...a: unknown[]) => logActivity(...a) }));
vi.mock("../supabase", () => ({ supabaseAdmin: {} }));

import { submitFinding, type FindingRun } from "../finding-submit";
import { fingerprintFinding, fingerprintStored, compareFindings, keyTerms, renderFingerprintFooter, parseFingerprintFooter } from "../finding-fingerprint";
import { rejectedDetail, parseRejectedDetail, historyDigest, type HistoryEntry } from "../finding-history";
import { evaluateFinding } from "../finding-gate";
import { case1, OUT, LEADERBOARD, RANKINGS_PAGE, RANKING_REPO, MATCH_REPO } from "./finding-fixtures";
import type { AgentId } from "../types";

beforeEach(() => {
  saveSuggestion.mockReset();
  logActivity.mockReset();
});

const ctx = (run: FindingRun, title: string) => ({ run, title, body: "prose" });
const submit = (run: FindingRun, input: Record<string, unknown>, agent: AgentId = "uxdesign") => submitFinding(agent, input, ctx(run, String(input.title)));
const logged = (action: string) => logActivity.mock.calls.filter((c) => c[1] === action).map((c) => JSON.parse(String(c[2])) as Record<string, unknown>);

// The duplicate UX finding from the real replay (same uxdesign run, 3 s later):
// "Unify Match Threshold Messaging Across Rankings Screen".
function case5Input(run: FindingRun) {
  const refs = [
    run.ledger.record("read_repo_file", { path: RANKINGS_PAGE, start_line: 40, end_line: 55 }, OUT.rankingsPage())!,
    run.ledger.record("read_repo_file", { path: LEADERBOARD, start_line: 160, end_line: 175 }, OUT.leaderboard())!,
  ];
  return {
    class: "plausible_risk",
    title: "Unify match threshold messaging across Rankings screen",
    location: { file: LEADERBOARD, symbol: "EmptyView.hint" },
    claim: "The Rankings header shows Min. RankingRepository.minMatches matches played, but the leaderboard empty state hardcodes 5+ matches.",
    failure_scenario: "Header and empty state disagree.",
    impact: "Inconsistent product messaging.",
    evidence: [
      { ref: refs[0], excerpt: "'Min. ${RankingRepository.minMatches} matches played to be ranked'," },
      { ref: refs[1], excerpt: "? 'Players appear here after playing 5+ matches.'" },
    ],
    what_checked_to_disprove: "Read both screens.",
    proposed_change: "Use RankingRepository.minMatches in the empty state.",
    priority: "low",
  };
}

function storedCase1Body(): { title: string; body: string } {
  const { run, input } = case1();
  const g = evaluateFinding(input, run.ledger);
  if (g.decision !== "accept") throw new Error("fixture");
  return { title: `[Verified bug] ${String(input.title)}`, body: `**Class:** Verified bug\n\nprose\n\n${renderFingerprintFooter(fingerprintFinding(g.finding, g.evidence))}` };
}

const entry = (over: Partial<HistoryEntry> & Pick<HistoryEntry, "print">): HistoryEntry => ({ id: "s1", source: "open", agent: "uxdesign", title: "existing", createdAt: "2026-09-26T21:49:41Z", ...over });

describe("fingerprints", () => {
  it("are built from files, symbol, class family, evidence anchors and key terms — not the title alone", () => {
    const { run, input } = case1();
    const g = evaluateFinding(input, run.ledger);
    if (g.decision !== "accept") throw new Error("x");
    const p = fingerprintFinding(g.finding, g.evidence);
    expect(p).toMatchObject({ family: "defect", cls: "verified_bug", symbol: "hint", files: ["player_leaderboard.dart", "ranking_repository.dart"] });
    expect(p.anchors).toEqual(["player_leaderboard.dart:169", "ranking_repository.dart:7"]);
    expect(p.fp).toMatch(/^[0-9a-f]{16}$/);
    expect(p.terms).toEqual(expect.arrayContaining(["leaderboard", "minmatch", "rankingrepository", "hint"]));
    // Same title, different location/claim => different fingerprint.
    const q = fingerprintFinding({ ...g.finding, location: { file: MATCH_REPO, symbol: "fetchSentProposals" }, claim: "proposals load slowly" }, []);
    expect(q.fp).not.toBe(p.fp);
    expect(compareFindings(p, q).duplicate).toBe(false);
  });

  it("key terms drop numbers, stop words and path noise", () => {
    expect(keyTerms("Only 2 of 19 teams in lib/a/b.dart:12 use RankingRepository.minMatches")).toEqual(["min", "minmatch", "ranking", "rankingrepository"]);
  });

  it("round-trip through the stored footer, and older rows are fingerprinted from their text", () => {
    const { body } = storedCase1Body();
    const parsed = parseFingerprintFooter(body)!;
    expect(parsed.anchors).toEqual(["player_leaderboard.dart:169", "ranking_repository.dart:7"]);
    const legacy = fingerprintStored({ title: "Fix Mismatched Match Count in Leaderboard Empty State Hint (5+ vs 2)", body: "In `lib/rankings/presentation/widgets/player_leaderboard.dart`, the empty-state hint copy says ... — Evidence: read_repo_file:lib/rankings/presentation/widgets/player_leaderboard.dart:187-190 shows ... lib/rankings/data/ranking_repository.dart:6 defines `minMatches = 2`.", category: "bug" });
    expect(legacy.files).toEqual(["player_leaderboard.dart", "ranking_repository.dart"]);
    expect(legacy.anchors).toContain("player_leaderboard.dart:187");
  });

  it("rejected-finding memory is compact, bounded and validated on read", () => {
    const { run, input } = case1();
    const g = evaluateFinding(input, run.ledger);
    if (g.decision !== "accept") throw new Error("x");
    const d = rejectedDetail({ code: "contradicted", cls: "verified_bug", title: "t".repeat(300), print: fingerprintFinding(g.finding, g.evidence) });
    expect(d.length).toBeLessThan(1200);
    expect(parseRejectedDetail(d)).toMatchObject({ code: "contradicted", title: "t".repeat(120) });
    expect(parseRejectedDetail("{\"v\":1,\"code\":\"drop table\"}")).toBeNull();
    expect(parseRejectedDetail("not json")).toBeNull();
  });
});

describe("duplicate detection (deterministic)", () => {
  it("an exact duplicate in the same run is blocked and logged", async () => {
    const { run, input } = case1();
    expect((await submit(run, input)).saved?.finalClass).toBe("verified_bug");
    const again = await submit(run, input);
    expect(again.saved).toBeUndefined();
    expect(again.message).toMatch(/^Not saved — duplicate of "\[Verified bug\] Leaderboard empty-state hint/);
    expect(saveSuggestion).toHaveBeenCalledTimes(1);
    expect(logged("finding:duplicate")).toHaveLength(1);
  });

  it("the same underlying finding with a different title is detected (replay case 5)", async () => {
    const { run, input } = case1();
    await submit(run, input);
    const dup = await submit(run, case5Input(run));
    expect(dup.saved).toBeUndefined();
    expect(dup.message).toMatch(/^Not saved — duplicate of "\[Verified bug\] Leaderboard empty-state hint says 5\+ matches/);
    expect(saveSuggestion).toHaveBeenCalledTimes(1);
  });

  it("stronger/new evidence is linked to the existing finding instead of creating a second one", async () => {
    const { run, input } = case1();
    await submit(run, input);
    const dup = await submit(run, case5Input(run)); // adds rankings_page.dart:49
    expect(dup.message).toMatch(/additional evidence \(rankings_page\.dart:49\) was linked/);
    const rel = logged("finding:evidence-added");
    expect(rel).toHaveLength(1);
    expect(rel[0]).toMatchObject({ newAnchors: ["rankings_page.dart:49"], existing: { source: "this-run", cls: "verified_bug" } });
    expect(saveSuggestion).toHaveBeenCalledTimes(1);
  });

  it("a duplicate of a currently open suggestion is detected (footer fingerprint)", async () => {
    const stored = storedCase1Body();
    const { run } = case1();
    run.history = { entries: [entry({ id: "open-1", source: "open", title: stored.title, print: fingerprintStored(stored) })] };
    const out = await submit(run, case5Input(run));
    expect(out.message).toMatch(/is already open in the owner's inbox/);
    expect(saveSuggestion).not.toHaveBeenCalled();
    expect(logged("finding:evidence-added")[0]).toMatchObject({ existing: { id: "open-1", source: "open" } });
  });

  it("a duplicate of an older open suggestion without a footer is detected from its text (real 2026-09-26 row)", async () => {
    const legacy = {
      title: "Fix Mismatched Match Count in Leaderboard Empty State Hint (5+ vs 2)",
      body: "In `lib/rankings/presentation/widgets/player_leaderboard.dart`, the empty-state hint copy says \"Players appear here after playing 5+ matches.\" However, `RankingRepository.minMatches` is set to `2`. This mismatch causes confusion for new players who might think they need 5 matches when 2 are sufficient. Update the hint copy to match `RankingRepository.minMatches` (or dynamic text) so users have accurate expectations.\n\n— Evidence: read_repo_file:lib/rankings/presentation/widgets/player_leaderboard.dart:187-190 shows `hint: q.isEmpty ? 'Players appear here after playing 5+ matches.' : null,` while lib/rankings/data/ranking_repository.dart:6 defines `minMatches = 2`.",
      category: "bug",
    };
    const { run, input } = case1();
    run.history = { entries: [entry({ id: "153b5842", source: "done", title: legacy.title, print: fingerprintStored(legacy) })] };
    const out = await submit(run, input);
    expect(out.message).toMatch(/was already handled \(done\)/);
    expect(saveSuggestion).not.toHaveBeenCalled();
  });

  it("a duplicate of a dismissed finding is blocked; so is one the gate rejected as contradicted", async () => {
    const stored = storedCase1Body();
    const { run, input } = case1();
    run.history = { entries: [entry({ source: "dismissed", title: stored.title, print: fingerprintStored(stored) })] };
    expect((await submit(run, input)).message).toMatch(/was dismissed by the owner/);

    const r2 = case1();
    r2.run.history = { entries: [entry({ source: "rejected", rejectCode: "contradicted", title: "same", print: fingerprintStored(stored) })] };
    expect((await submit(r2.run, r2.input)).message).toMatch(/already rejected this finding \(contradicted\)/);
    expect(saveSuggestion).not.toHaveBeenCalled();
  });

  it("a finding rejected earlier only for thin evidence may return once it passes the gate (relationship logged)", async () => {
    const stored = storedCase1Body();
    const { run, input } = case1();
    run.history = { entries: [entry({ id: "rej-1", source: "rejected", rejectCode: "invalid_evidence", title: "same", print: { ...fingerprintStored(stored), anchors: [] } })] };
    const out = await submit(run, input);
    expect(out.saved?.finalClass).toBe("verified_bug");
    expect(logged("finding:resubmitted")[0]).toMatchObject({ previous: { id: "rej-1", code: "invalid_evidence" } });
  });

  it("a genuinely different finding in the same file area is not merged", async () => {
    const { run, input } = case1();
    await submit(run, input);
    const ref = run.ledger.record("read_repo_file", { path: RANKING_REPO }, OUT.rankingRepo())!;
    const other = {
      class: "plausible_risk",
      title: "Position filter uses exact string equality",
      location: { file: RANKING_REPO, symbol: "fetchPlayers" },
      claim: "fetchPlayers filters with query.eq('position', position), so a differently-cased position value returns an empty leaderboard.",
      failure_scenario: "A stored position of 'Goalkeeper' vs a filter of 'goalkeeper'.",
      impact: "Empty filtered leaderboard.",
      evidence: [{ ref, excerpt: "query = query.eq('position', position);" }],
      proposed_change: "Normalise positions.",
      priority: "low",
    };
    const out = await submit(run, other);
    expect(out.saved?.finalClass).toBe("plausible_risk");
    expect(saveSuggestion).toHaveBeenCalledTimes(2);
  });

  it("each duplicate rule is needed on its own (A: location+symbol, B: shared evidence line, C: shared file + claim)", () => {
    const base = { family: "defect" as const, fp: null, symbol: "", files: [] as string[], anchors: [] as string[], terms: ["leaderboard", "hint", "threshold", "empty", "state", "copy", "banner", "ranked", "wording", "screen2"] };
    const other = { ...base, terms: ["leaderboard", "hint", "threshold", "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"] }; // overlap 0.3
    expect(compareFindings({ ...base, fp: "aaaaaaaaaaaaaaaa" }, { ...other, fp: "aaaaaaaaaaaaaaaa" })).toMatchObject({ duplicate: true, rule: "A" });
    expect(compareFindings({ ...base, anchors: ["x.dart:9"] }, { ...other, anchors: ["x.dart:9"] })).toMatchObject({ duplicate: true, rule: "B" });
    expect(compareFindings({ ...base, files: ["x.dart"] }, { ...other, files: ["x.dart"] }).duplicate).toBe(false); // 0.3 < 0.45
    expect(compareFindings({ ...base, files: ["x.dart"] }, { ...base, terms: base.terms.slice(0, 5).concat(["q1", "q2", "q3", "q4", "q5"]), files: ["x.dart"] })).toMatchObject({ duplicate: true, rule: "C" });
    expect(compareFindings({ ...base, anchors: ["x.dart:9"] }, { ...other, anchors: ["x.dart:10"] }).duplicate).toBe(false);
  });

  it("ideas and defects never deduplicate against each other", () => {
    const a = { family: "idea" as const, fp: null, symbol: "", files: ["x.dart"], anchors: ["x.dart:1"], terms: ["a", "b", "c", "d"] };
    expect(compareFindings(a, { ...a, family: "defect" }).duplicate).toBe(false);
    expect(compareFindings(a, a).duplicate).toBe(true);
  });

  it("history unavailable => nothing is saved (fail-closed)", async () => {
    const { run, input } = case1();
    run.history = null; // not loaded yet: the submission must load it
    const out = await submitFinding("uxdesign", input, { run, title: "t", body: "b" }, async () => {
      throw new Error("db down");
    });
    expect(out.saved).toBeUndefined();
    expect(saveSuggestion).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledWith("uxdesign", "finding:history-unavailable", "db down");
  });

  it("the agent-facing digest lists dismissed/done/rejected findings compactly, never open ones", () => {
    const p = { family: "defect" as const, fp: null, symbol: "_propose", files: ["matches_page.dart"], anchors: [], terms: [] };
    const d = historyDigest({ entries: [
      entry({ source: "open", title: "OPEN ONE", print: p }),
      entry({ source: "dismissed", title: "Robust City Fallback for Match Filters", print: p, createdAt: "2026-09-26T21:47:33Z" }),
      entry({ source: "rejected", rejectCode: "contradicted", title: "Teams can propose with fewer than 5 players", print: p, createdAt: "2026-09-27T10:00:00Z" }),
    ] });
    expect(d.split("\n")).toEqual([
      "- [rejected by the evidence gate: contradicted] Teams can propose with fewer than 5 players (matches_page.dart › _propose)",
      "- [dismissed by the owner] Robust City Fallback for Match Filters (matches_page.dart › _propose)",
    ]);
  });
});
