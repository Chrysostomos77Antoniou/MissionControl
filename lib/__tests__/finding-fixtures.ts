// Test fixtures for the 7b finding gate: tool outputs from the REAL 7a audit
// of FootRank commit 27e1e5a (read-only verification, 2026-09-27), rendered
// in the exact formats the tools produce. Read windows go through the real
// formatNumberedWindow; search results use search_code's exact layout (the
// ledger tests check that layout against a real searchCode run).

import { formatNumberedWindow } from "../../tools/github-read";
import { EvidenceLedger } from "../evidence-ledger";
import { createFindingRun, type FindingRun } from "../finding-submit";
import { createVerifierRuntime, type VerifierRuntime, type VerifierTools, type VerifierModel } from "../finding-verifier";
import type { LlmRequest } from "../llm";

export const PIN = "27e1e5ac5a89cb9d5f5cb7ca6a1368afa0582a46";
export const OTHER_PIN = "1111111111111111111111111111111111111111";
export const REPO = "Chrysostomos77Antoniou/footrank";

// A numbered read of `path` exactly as read_repo_file prints it. Lines not in
// `lines` are filler (never cited by the fixtures).
export function readOut(path: string, total: number, lines: Record<number, string>, start: number, end: number, commit = PIN): string {
  const text = Array.from({ length: total }, (_, i) => lines[i + 1] ?? `// (not shown in the audit) ${path}`).join("\n") + "\n";
  return formatNumberedWindow(path, commit, text, start, end);
}

export function searchOut(query: string, hits: [string, number, string][], scope?: string, commit = PIN): string {
  const header = `search_code ${JSON.stringify(query)}${scope ? ` in ${scope}` : ""}\nrepo: ${REPO} @ ${commit} (pinned for this run; uncommitted local work is not searched)`;
  if (!hits.length) return `${header}\n\nNo matches.`;
  const files = new Set(hits.map((h) => h[0])).size;
  return `${header}\n${hits.length} match(es) in ${files} file(s):\n\n${hits.map(([f, l, t]) => `${f}:${l}: ${t}`).join("\n")}\n\nOpen a location with read_repo_file(path, start_line, end_line).`;
}

// ---- real FootRank source (commit 27e1e5a) ----
export const RANKING_REPO = "lib/rankings/data/ranking_repository.dart";
export const RANKINGS_PAGE = "lib/rankings/presentation/pages/rankings_page.dart";
export const LEADERBOARD = "lib/rankings/presentation/widgets/player_leaderboard.dart";
export const CITIES = "lib/core/constants/cities.dart";
export const MATCHES_PAGE = "lib/match/presentation/pages/matches_page.dart";
export const HOME_PAGE = "lib/home/presentation/pages/home_page.dart";
export const MATCH_REPO = "lib/match/data/match_repository.dart";
export const PROPOSAL_MODEL = "lib/models/match_proposal_model.dart";

const RANKING_REPO_LINES: Record<number, string> = {
  1: "import 'package:footrank/models/team_model.dart';",
  2: "import 'package:footrank/models/user_model.dart';",
  3: "import 'package:footrank/services/supabase_service.dart';",
  4: "",
  5: "class RankingRepository {",
  6: "  /// Players must have played at least this many matches to be ranked.",
  7: "  static const int minMatches = 2;",
  8: "",
  9: "  /// Ranked players (>= [minMatches] matches), ordered by ELO (desc),",
  10: "  /// optionally filtered by position.",
  11: "  Future<List<UserModel>> fetchPlayers({String? position}) async {",
  12: "    var query = SupabaseService.client",
  13: "        .from('users')",
  14: "        .select()",
  15: "        .gte('matches_played', minMatches);",
  16: "    if (position != null) {",
  17: "      query = query.eq('position', position);",
  18: "    }",
  19: "    final data = await query.order('elo', ascending: false);",
  20: "    return (data as List)",
};
const RANKINGS_PAGE_LINES: Record<number, string> = {
  44: "                    if (_tab == 0)",
  45: "                      Expanded(",
  48: "                          child: Text(",
  49: "                            'Min. ${RankingRepository.minMatches} matches played to be ranked',",
  50: "                            style: TextStyle(",
};
const LEADERBOARD_LINES: Record<number, string> = {
  160: "                  child: ListView(",
  161: "                    children: [",
  162: "                      const SizedBox(height: 80),",
  163: "                      EmptyView(",
  164: "                        icon: Icons.emoji_events_outlined,",
  165: "                        title: q.isEmpty",
  166: "                            ? 'No ranked players yet'",
  167: "                            : 'No players match \"$q\"',",
  168: "                        hint: q.isEmpty",
  169: "                            ? 'Players appear here after playing 5+ matches.'",
  170: "                            : null,",
  171: "                      ),",
  172: "                    ],",
  173: "                  ),",
  174: "                );",
  175: "              }",
};
const CITIES_LINES: Record<number, string> = {
  1: "/// The fixed set of cities FootRank operates in. Used for profiles, teams,",
  2: "/// and match requests so matchmaking can reliably match on city.",
  3: "const List<String> kCities = [",
  4: "  'Nicosia',",
  5: "  'Limassol',",
  6: "  'Famagusta',",
  7: "  'Larnaca',",
  8: "  'Paphos',",
  9: "];",
  10: "",
  11: "/// Maps any stored city string to the canonical list entry (case-insensitive),",
  12: "/// or null if it doesn't match — so dropdowns never crash on a stale value.",
  13: "String? canonicalCity(String? value) {",
  14: "  if (value == null) return null;",
  15: "  final v = value.trim().toLowerCase();",
  16: "  for (final c in kCities) {",
  17: "    if (c.toLowerCase() == v) return c;",
  18: "  }",
  19: "  return null;",
  20: "}",
};
const MATCHES_CITY_LINES: Record<number, string> = {
  118: "    setState(() {",
  119: "      _teams = teams;",
  120: "      _team = sel;",
  121: "      _loadingTeam = false;",
  122: "      if (sel != null && sel.id != previousTeamId) {",
  123: "        _filterCity = canonicalCity(sel.city) ?? kCities.first;",
  124: "        _filterCourtId = null;",
  125: "        _filterDate = null;",
  126: "        _filterTime = null;",
  127: "        _filterMatchType = null;",
  128: "        _filterCourts = [];",
};
const PROPOSE_LINES: Record<number, string> = {
  271: "  Future<void> _propose(MatchRequestModel opponent) async {",
  272: "    final team = _team;",
  273: "    if (team == null) return;",
  292: "    if (confirm != true) return;",
  293: "",
  294: "    // Matches are 5-a-side -- fail fast with a clear message instead of",
  295: "    // letting the request hit the server's \"at least 5 players\" check.",
  296: "    final members = await _teamRepo.fetchMembers(team.id);",
  297: "    if (!mounted) return;",
  298: "    if (members.length < 5) {",
  299: "      showError(context, '${team.name} needs at least 5 players before you can propose a '",
  300: "            'match (currently ${members.length}).',);",
  301: "      return;",
  302: "    }",
  303: "",
  304: "    try {",
  305: "      await _matchRepo.proposeMatch(requestId: opponent.id, teamId: team.id);",
  306: "      if (!mounted) return;",
};
const SENT_PROPOSALS_LINES: Record<number, string> = {
  278: "  /// anyone can see what the team has already proposed (these are exactly",
  279: "  /// the requests hidden from [fetchCityRequests] while pending).",
  280: "  Future<List<MatchProposalModel>> fetchSentProposals(String teamId) async {",
  281: "    final data = await SupabaseService.client",
  282: "        .from(_requestProposals)",
  283: "        .select(",
  284: "            '*, match_requests(city, scheduled_at, match_type, format, teams(name, rating, logo_url))')",
  285: "        .eq('proposing_team_id', teamId)",
  286: "        .eq('status', 'pending')",
  287: "        .order('created_at', ascending: false);",
  288: "",
  289: "    return (data as List)",
  290: "        .map((e) => MatchProposalModel.fromJson(e as Map<String, dynamic>))",
  291: "        .toList();",
  292: "  }",
};
const PROPOSAL_MODEL_LINES: Record<number, string> = {
  54: "  factory MatchProposalModel.fromJson(Map<String, dynamic> json) {",
  55: "    final team = json['teams'] as Map<String, dynamic>?;",
  56: "    final request = json['match_requests'] as Map<String, dynamic>?;",
  57: "    final targetTeam = request?['teams'] as Map<String, dynamic>?;",
  71: "      requestCity: request?['city'] as String?,",
  77: "      targetTeamName: targetTeam?['name'] as String?,",
};
const HOME_LINES: Record<number, string> = {
  100: "      title: 'Create a match for…',",
  101: "    );",
  102: "    if (!mounted || team == null) return;",
  104: "    // Matches are 5-a-side -- fail fast with a clear message instead of",
  105: "    // letting the request hit the server's \"at least 5 players\" check.",
  106: "    final members = await _teamRepo.fetchMembers(team.id);",
  107: "    if (!mounted) return;",
  108: "    if (members.length < 5) {",
  109: "      showError(",
  110: "        context,",
  111: "        '${team.name} needs at least 5 players before you can create a '",
  112: "        'match (currently ${members.length}).',",
  113: "      );",
  114: "      return;",
  115: "    }",
};

export const OUT = {
  home: () => readOut(HOME_PAGE, 689, HOME_LINES, 100, 115),
  rankingRepo: () => readOut(RANKING_REPO, 37, RANKING_REPO_LINES, 1, 20),
  rankingsPage: () => readOut(RANKINGS_PAGE, 265, RANKINGS_PAGE_LINES, 40, 55),
  leaderboard: () => readOut(LEADERBOARD, 262, LEADERBOARD_LINES, 160, 175),
  search5plus: () =>
    searchOut("5+ matches", [
      ["docs/CYPRUS_CUP_RULES.md", 15, 'plus [optional] "Top Player" award for the highest-PWR player with 5+ matches.'],
      [LEADERBOARD, 169, "? 'Players appear here after playing 5+ matches.'"],
    ]),
  searchMinMatches: () =>
    searchOut("RankingRepository.minMatches", [
      ["docs/ARCHITECTURE.md", 291, "(`RankingRepository.minMatches`) to appear, ordered by ELO desc, optional"],
      [RANKINGS_PAGE, 49, "'Min. ${RankingRepository.minMatches} matches played to be ranked',"],
    ]),
  cities: () => readOut(CITIES, 20, CITIES_LINES, 1, 20),
  matchesCity: () => readOut(MATCHES_PAGE, 2113, MATCHES_CITY_LINES, 118, 128),
  searchCanonicalCity: () =>
    searchOut("canonicalCity(", [
      [CITIES, 13, "String? canonicalCity(String? value) {"],
      ["lib/match/presentation/pages/create_match_request_page.dart", 70, "setState(() => _city = canonicalCity(team.city));"],
      [MATCHES_PAGE, 123, "_filterCity = canonicalCity(sel.city) ?? kCities.first;"],
      [MATCHES_PAGE, 155, "_filterCity = canonicalCity(team.city) ?? kCities.first;"],
      ["lib/profile/presentation/pages/edit_profile_page.dart", 32, "late String? _city = canonicalCity(widget.user.city);"],
      ["lib/team/presentation/pages/edit_team_page.dart", 28, "late String? _city = canonicalCity(widget.team.city);"],
      ["test/models_test.dart", 8, "expect(canonicalCity('nicosia'), 'Nicosia');"],
      ["test/models_test.dart", 9, "expect(canonicalCity('  LIMASSOL '), 'Limassol');"],
    ]),
  propose: () => readOut(MATCHES_PAGE, 2113, PROPOSE_LINES, 271, 310),
  searchMembers: () =>
    searchOut("members.length < 5", [
      [HOME_PAGE, 108, "if (members.length < 5) {"],
      [MATCHES_PAGE, 298, "if (members.length < 5) {"],
    ]),
  sentProposals: () => readOut(MATCH_REPO, 497, SENT_PROPOSALS_LINES, 278, 292),
  proposalModel: () => readOut(PROPOSAL_MODEL, 82, PROPOSAL_MODEL_LINES, 50, 82),
};

// Register every real line the fixtures know about (reads + search hits).
function registerRealLines(): void {
  const reg = (path: string, total: number, lines: Record<number, string>) => addLines(path, total, Object.fromEntries(Object.entries(lines).filter(([, t]) => t !== "")));
  reg(RANKING_REPO, 37, RANKING_REPO_LINES);
  reg(RANKINGS_PAGE, 265, RANKINGS_PAGE_LINES);
  reg(LEADERBOARD, 262, LEADERBOARD_LINES);
  reg(CITIES, 20, CITIES_LINES);
  reg(MATCHES_PAGE, 2113, { ...MATCHES_CITY_LINES, ...PROPOSE_LINES, 155: "        _filterCity = canonicalCity(team.city) ?? kCities.first;", ...UNDERSTAFFED_LINES });
  reg(HOME_PAGE, 689, HOME_LINES);
  reg(MATCH_REPO, 497, { 10: "  static const _requests = 'match_requests';", 11: "  static const _requestProposals = 'match_request_proposals';", ...SENT_PROPOSALS_LINES });
  reg(PROPOSAL_MODEL, 82, PROPOSAL_MODEL_LINES);
  reg("test/models_test.dart", 40, { 8: "    expect(canonicalCity('nicosia'), 'Nicosia');", 9: "    expect(canonicalCity('  LIMASSOL '), 'Limassol');", 10: "    expect(canonicalCity('Paphos'), 'Paphos');", 14: "    expect(canonicalCity('Athens'), isNull);", 15: "    expect(canonicalCity(null), isNull);", 16: "    expect(canonicalCity(''), isNull);" });
  reg("docs/CYPRUS_CUP_RULES.md", 60, { 15: 'plus [optional] "Top Player" award for the highest-PWR player with 5+ matches.' });
  reg("docs/ARCHITECTURE.md", 400, { 291: "(`RankingRepository.minMatches`) to appear, ordered by ELO desc, optional" });
}

// ---- a fake FootRank at 27e1e5a for the verifier (7c) ----
// Only lines actually seen in the 7a audit are real; every other line is
// filler that never matches a search. Reads use the real formatNumberedWindow
// and searches produce search_code's exact layout.
const REAL_LINES: Record<string, { total: number; lines: Record<number, string> }> = {};
const addLines = (path: string, total: number, lines: Record<number, string>) => {
  REAL_LINES[path] = { total, lines: { ...(REAL_LINES[path]?.lines ?? {}), ...lines } };
};

export const UNDERSTAFFED_LINES: Record<number, string> = {
  612: "                      final opponents = snapshot.data ?? [];",
  613: "                      if (opponents.isEmpty) {",
  614: "                        final underStaffed = (_memberCount ?? 5) < 5;",
  619: "                            title: underStaffed",
  622: "                            hint: underStaffed",
  623: "                                ? 'Post a request and let them come to you '",
  624: "                                    '-- you only need 5 players at match '",
  625: "                                    'time, not right now.'",
};

export function fakeRepoTools(commit = PIN): VerifierTools & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async readFile(path, start, end) {
      calls.push(`read ${path} ${start}-${end}`);
      const f = REAL_LINES[path];
      if (!f) return `Not found: ${path} does not exist at commit ${commit}. Use search_code or list_repo to locate it.`;
      return readOut(path, f.total, f.lines, start, end, commit);
    },
    async searchCode(query, scope) {
      calls.push(`search ${JSON.stringify(query)}${scope ? ` in ${scope}` : ""}`);
      const hits: [string, number, string][] = [];
      for (const [path, f] of Object.entries(REAL_LINES).sort(([a], [b]) => a.localeCompare(b))) {
        if (scope && path !== scope && !path.startsWith(`${scope.replace(/\/$/, "")}/`)) continue;
        for (const [n, text] of Object.entries(f.lines).sort((a, b) => Number(a[0]) - Number(b[0]))) if (text.includes(query)) hits.push([path, Number(n), text.trim()]);
      }
      return searchOut(query, hits, scope, commit);
    },
  };
}

export const SURVIVES_JSON = JSON.stringify({ verdict: "SURVIVES", reason_code: "supported", downgrade_to: null, supporting: ["E1"], contradicting: [] });

// A scripted verifier model: returns the given replies in order (the last one repeats).
export function fakeModel(...replies: (string | Error)[]): VerifierModel & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    requests,
    async generate(req) {
      requests.push(req);
      const r = replies[Math.min(requests.length - 1, replies.length - 1)] ?? SURVIVES_JSON;
      if (r instanceof Error) throw r;
      return { text: r, provider: "test", model: "fake-verifier" };
    },
  };
}

export const fakeVerifier = (opts: { commit?: string; tools?: VerifierTools; model?: VerifierModel } = {}): VerifierRuntime =>
  createVerifierRuntime({ commit: opts.commit ?? PIN, tools: opts.tools ?? fakeRepoTools(opts.commit ?? PIN), model: opts.model ?? fakeModel(SURVIVES_JSON) });

// A run whose ledger holds the given tool results; returns their refs in order.
export function runWith(outputs: [tool: string, input: Record<string, unknown>, output: string][], commit = PIN, verifier?: VerifierRuntime): { run: FindingRun; refs: string[] } {
  const run = createFindingRun({ commit, history: { entries: [] }, verifier: verifier ?? fakeVerifier({ commit }) });
  const refs = outputs.map(([tool, input, output]) => {
    const ref = run.ledger.record(tool, input, output);
    if (!ref) throw new Error(`fixture output for ${tool} was not recordable`);
    return ref;
  });
  return { run, refs };
}

export const ledgerWith = (outputs: [string, Record<string, unknown>, string][], commit = PIN): { ledger: EvidenceLedger; refs: string[] } => {
  const { run, refs } = runWith(outputs, commit);
  return { ledger: run.ledger, refs };
};

// Case 1 (verified bug): leaderboard hint says 5+ matches, minMatches is 2.
export function case1(): { run: FindingRun; refs: string[]; input: Record<string, unknown> } {
  const { run, refs } = runWith([
    ["read_repo_file", { path: RANKING_REPO, start_line: 1, end_line: 20 }, OUT.rankingRepo()],
    ["read_repo_file", { path: LEADERBOARD, start_line: 160, end_line: 175 }, OUT.leaderboard()],
    ["search_code", { query: "5+ matches" }, OUT.search5plus()],
  ]);
  return {
    run,
    refs,
    input: {
      class: "verified_bug",
      title: "Leaderboard empty-state hint says 5+ matches but ranking needs only 2",
      location: { file: LEADERBOARD, symbol: "EmptyView.hint", line: 169 },
      claim: "The leaderboard empty-state hint tells players they appear after 5+ matches, but RankingRepository.minMatches is 2.",
      failure_scenario: "A player with 2-4 matches is already ranked, yet a new player reading the empty state believes 5 matches are required.",
      impact: "New players are told a higher bar than the real one and may give up before playing their second match.",
      evidence: [
        { ref: refs[0], file: RANKING_REPO, start_line: 7, excerpt: "static const int minMatches = 2;" },
        { ref: refs[1], file: LEADERBOARD, start_line: 169, excerpt: "? 'Players appear here after playing 5+ matches.'" },
        { ref: refs[2], file: LEADERBOARD, start_line: 169, excerpt: "Players appear here after playing 5+ matches." },
      ],
      assertion: { kind: "mismatch", a_evidence: 1, a_value: "2", b_evidence: 2, b_value: "5" },
      what_checked_to_disprove: "Searched '5+ matches' (only this hint and an unrelated docs line) and read RankingRepository: the query filters on minMatches, which is 2.",
      proposed_change: "Build the hint from RankingRepository.minMatches instead of hardcoding 5+.",
      priority: "medium",
    },
  };
}

registerRealLines();
