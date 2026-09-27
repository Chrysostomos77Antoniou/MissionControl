// Deterministic investigation scope (source follow-through).
//
// Derives what an agent run ACTUALLY investigated from the run's evidence
// ledger (lib/evidence-ledger.ts: tool-printed read windows and search hits at
// the pinned commit) plus the loop's discovery counters. The model's wording
// never defines the scope.
//
//   - Database inspection: successful db_read and read_footrank_stats results.
//   - Discovery: list_repo and search_code calls. Never source inspection.
//   - Source inspection: ONLY the file/line ranges read_repo_file returned
//     (including truncation).
//   - Unread leads: code the run's own specific searches pointed at, in
//     clusters that no read covered. Dart import/export-only hits are not
//     leads by themselves.
//
// Also detects, with fixed regexes, conclusions that claim a wider scope than
// the tool history supports. Nothing here creates, blocks or rewrites a
// finding: findings go only through save_suggestion -> 7b gate -> duplicate
// check -> 7c verifier.
//
// Pure: no I/O.

import type { EvidenceRecord } from "./evidence-ledger";

// A search is "specific" (points at concrete code) only if its results are
// complete and it has at most this many hits. Broad or capped searches are
// discovery noise and create no leads.
export const SPECIFIC_SEARCH_MAX_HITS = 20;
// Hits within this many lines of each other form one code area (cluster).
export const CLUSTER_GAP_LINES = 40;
// How many unread leads are named in a follow-up / scope line.
export const MAX_LEADS_SHOWN = 3;

export type ScopeLevel = "none" | "discovery-only" | "partial" | "targeted";

export interface LineRange {
  start: number;
  end: number;
}

export interface Lead {
  file: string;
  start: number; // first hit line in the cluster
  end: number; // last hit line in the cluster
  hits: number; // distinct hit lines
  queries: string[];
}

export interface InvestigationScope {
  dbQueries: number; // successful db_read results
  statsReads: number; // successful read_footrank_stats results
  listRepoCalls: number; // discovery only
  searchCalls: number; // discovery only
  sourceReads: { file: string; ranges: LineRange[] }[]; // merged, tool-returned ranges
  sourceLinesRead: number;
  unreadLeads: Lead[]; // ranked: lib/ first, then other code, then test/; then by hit count
  inspectedClusters: number;
  level: ScopeLevel;
}

export interface DiscoveryCounters {
  listRepoCalls: number;
  searchCalls: number;
}

const CODE_FILE = /\.(dart|ts|tsx|js|jsx|mjs|cjs|sql|kt|kts|java|swift|m|mm|gradle|py|go|rs|c|cc|cpp|h|hpp|cs|rb|php|sh)$/i;
const NON_CODE_DIR = /^(docs?|documentation)\//i;

export function isCodeFile(path: string): boolean {
  return CODE_FILE.test(path) && !NON_CODE_DIR.test(path);
}

function mergeRanges(ranges: LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: LineRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

// A Dart line whose only code is an import or export directive (optionally
// with conditional URIs, `deferred as`, `show`/`hide` and a trailing // comment).
// Such a hit only says a file depends on another; it is not an implementation
// area, so it creates no lead by itself. Generic: no query or file is special.
// Anything else (a truncated row, a multi-line directive, code that merely
// contains the word "import") stays a normal hit.
const ID = String.raw`[A-Za-z_$][\w$]*`;
const DART_IMPORT_EXPORT = new RegExp(
  String.raw`^(?:import|export)\s+(['"])[^'"\n]*\1` +
    String.raw`(?:\s*if\s*\([^)\n]*\)\s*(['"])[^'"\n]*\2)*` +
    String.raw`(?:\s+deferred)?(?:\s+as\s+${ID})?` +
    String.raw`(?:\s+(?:show|hide)\s+${ID}(?:\s*,\s*${ID})*)*` +
    String.raw`\s*;\s*(?:\/\/.*)?$`,
);

export function isImportExportOnlyHit(file: string, text: string): boolean {
  return /\.dart$/i.test(file) && DART_IMPORT_EXPORT.test(String(text ?? "").trim());
}

const covered = (ranges: LineRange[] | undefined, line: number) => !!ranges?.some((r) => r.start <= line && line <= r.end);
const leadRank = (file: string) => (file.startsWith("lib/") ? 0 : file.startsWith("test/") || file.includes("/test/") ? 2 : 1);

export function buildScope(records: EvidenceRecord[], counters: DiscoveryCounters): InvestigationScope {
  // Source inspection: read_repo_file windows exactly as the tool returned them.
  const readsByFile = new Map<string, LineRange[]>();
  for (const r of records) {
    if (r.tool !== "read_repo_file" || !r.read) continue;
    readsByFile.set(r.read.path, [...(readsByFile.get(r.read.path) ?? []), { start: r.read.start, end: r.read.end }]);
  }
  const sourceReads = [...readsByFile.entries()]
    .map(([file, ranges]) => ({ file, ranges: mergeRanges(ranges) }))
    .sort((a, b) => a.file.localeCompare(b.file));
  const merged = new Map(sourceReads.map((s) => [s.file, s.ranges]));

  // Leads: hits of specific searches, per code file, clustered.
  const hitsByFile = new Map<string, Map<number, Set<string>>>();
  for (const r of records) {
    const s = r.search;
    if (r.tool !== "search_code" || !s || s.noMatches || !s.complete || s.hits.length > SPECIFIC_SEARCH_MAX_HITS) continue;
    for (const h of s.hits) {
      if (!isCodeFile(h.file) || isImportExportOnlyHit(h.file, h.text)) continue;
      const lines = hitsByFile.get(h.file) ?? new Map<number, Set<string>>();
      lines.set(h.line, (lines.get(h.line) ?? new Set<string>()).add(s.query));
      hitsByFile.set(h.file, lines);
    }
  }
  const unread: Lead[] = [];
  let inspectedClusters = 0;
  for (const [file, lines] of hitsByFile) {
    const sorted = [...lines.keys()].sort((a, b) => a - b);
    let cluster: number[] = [];
    const flush = () => {
      if (!cluster.length) return;
      if (cluster.some((n) => covered(merged.get(file), n))) inspectedClusters++;
      else unread.push({ file, start: cluster[0], end: cluster[cluster.length - 1], hits: cluster.length, queries: [...new Set(cluster.flatMap((n) => [...lines.get(n)!]))].sort() });
      cluster = [];
    };
    for (const n of sorted) {
      if (cluster.length && n - cluster[cluster.length - 1] > CLUSTER_GAP_LINES) flush();
      cluster.push(n);
    }
    flush();
  }
  unread.sort((a, b) => leadRank(a.file) - leadRank(b.file) || b.hits - a.hits || a.file.localeCompare(b.file) || a.start - b.start);

  const discovery = counters.listRepoCalls + counters.searchCalls;
  const level: ScopeLevel = sourceReads.length === 0 ? (discovery > 0 ? "discovery-only" : "none") : unread.length ? "partial" : "targeted";
  return {
    dbQueries: records.filter((r) => r.tool === "db_read").length,
    statsReads: records.filter((r) => r.tool === "read_footrank_stats").length,
    listRepoCalls: counters.listRepoCalls,
    searchCalls: counters.searchCalls,
    sourceReads,
    sourceLinesRead: sourceReads.reduce((n, s) => n + s.ranges.reduce((m, r) => m + r.end - r.start + 1, 0), 0),
    unreadLeads: unread,
    inspectedClusters,
    level,
  };
}

// ---- overclaim detection (fixed regexes, sentence by sentence) ----
// Broad-scope wording: only supported when the run's scope is "targeted".
const BROAD_SCOPE =
  /\b(thorough(?:ly)?|comprehensive(?:ly)?|exhaustive(?:ly)?|end-to-end|entire|whole (?:codebase|code base|repo(?:sitory)?|system|app)|all systems|every (?:file|table|module|screen)|all (?:files|code|tables|modules|screens)|full (?:review|inspection|audit|investigation|analysis|scan)|complete (?:review|inspection|audit|investigation|analysis|scan)|codebase|code base|repository architecture)\b/i;
// Claims of having inspected code: only supported when a source file was read.
const CODE_INSPECTION_CLAIM =
  /\b(inspect(?:ed|ion)?|review(?:ed)?|check(?:ed)?|audit(?:ed)?|examin(?:ed|ation)|analy[sz](?:ed|is)|read|verified)\b[^.\n]{0,60}\b(codebase|code base|source code|source|repository|repo|architecture|implementation)\b/i;
// Sentences that explicitly deny or limit the inspection are honest, never
// overclaims ("I did not inspect the rest of the codebase", "only read …").
// A plain "no" is NOT a limitation: "no issues in the entire codebase" is
// still a whole-codebase claim.
const NEGATED =
  /\b(?:not|never|didn'?t|did not|haven'?t|have not|hasn'?t|has not|wasn'?t|was not|weren'?t|were not)\s+(?:yet\s+|been\s+|fully\s+)*(?:inspect|read|review|check|audit|examin|look|cover|verif|open)\w*|\b(?:uninspected|unread|unreviewed|unchecked)\b|\bonly\s+(?:read|inspected|reviewed|checked|looked|covered|opened)\b|\bwithout\s+(?:reading|inspecting|reviewing|opening)\b/i;

export interface Overclaim {
  kind: "broad-scope" | "code-inspection-without-reading";
  phrase: string;
}

export function detectOverclaim(text: string, scope: InvestigationScope): Overclaim | null {
  const sentences = String(text ?? "").split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  for (const s of sentences) {
    if (NEGATED.test(s)) continue;
    const broad = BROAD_SCOPE.exec(s);
    if (broad && scope.level !== "targeted") return { kind: "broad-scope", phrase: broad[0] };
    const code = CODE_INSPECTION_CLAIM.exec(s);
    if (code && scope.sourceReads.length === 0) return { kind: "code-inspection-without-reading", phrase: code[0].slice(0, 60) };
  }
  return null;
}

// ---- rendering (facts only) ----
const base = (p: string) => p.split("/").pop() ?? p;
const ranges = (rs: LineRange[]) => rs.map((r) => (r.start === r.end ? `${r.start}` : `${r.start}–${r.end}`)).join(", ");

export function describeLead(l: Lead): string {
  return `${l.file} lines ${l.start === l.end ? l.start : `${l.start}–${l.end}`} (${l.hits} hit${l.hits === 1 ? "" : "s"} for ${l.queries.map((q) => JSON.stringify(q)).join(", ")})`;
}

// One-line runtime record of the scope (used in memory and grader input).
export function scopeLine(scope: InvestigationScope, overclaim: Overclaim | null): string {
  const reads = scope.sourceReads.length
    ? scope.sourceReads.slice(0, 3).map((s) => `${base(s.file)} ${ranges(s.ranges)}`).join("; ") + (scope.sourceReads.length > 3 ? ` (+${scope.sourceReads.length - 3} files)` : "")
    : "none";
  const leads = scope.unreadLeads.length
    ? scope.unreadLeads.slice(0, 2).map((l) => `${base(l.file)} ${l.start === l.end ? l.start : `${l.start}–${l.end}`}`).join("; ") + (scope.unreadLeads.length > 2 ? ` (+${scope.unreadLeads.length - 2} more)` : "")
    : "none";
  const warn = overclaim ? " · ⚠ scope claim not supported by tool history" : "";
  return `[Scope recorded by Mission Control: level ${scope.level} · DB queries ${scope.dbQueries}, stats ${scope.statsReads} · discovery: list_repo ${scope.listRepoCalls}, search_code ${scope.searchCalls} · source read: ${reads} · unread leads: ${leads}${warn}]`;
}

// Compact audit record (activity_log detail).
export function scopeDetail(scope: InvestigationScope, overclaim: Overclaim | null, followUps: number): string {
  return JSON.stringify({
    v: 1,
    level: scope.level,
    db: scope.dbQueries,
    stats: scope.statsReads,
    listRepo: scope.listRepoCalls,
    search: scope.searchCalls,
    read: scope.sourceReads.slice(0, 8).map((s) => ({ file: s.file, ranges: s.ranges.slice(0, 6) })),
    linesRead: scope.sourceLinesRead,
    unreadLeads: scope.unreadLeads.slice(0, 6).map((l) => ({ file: l.file, start: l.start, end: l.end, hits: l.hits })),
    inspectedClusters: scope.inspectedClusters,
    overclaim: overclaim ? overclaim.kind : null,
    followUps,
  });
}

// Deterministic follow-up shown when a conclusion is premature or overclaims.
// Built only from recorded tool facts; never asks for a finding.
export function followUpMessage(scope: InvestigationScope, leadsUnread: boolean, overclaim: Overclaim | null): string {
  const parts: string[] = [`[Mission Control] Before you conclude — recorded investigation scope: ${scopeLine(scope, null)}`];
  parts.push("search_code and list_repo are discovery only; they are not source-code inspection. Only read_repo_file counts, and only for the lines it returned.");
  if (leadsUnread && scope.unreadLeads.length) {
    const shown = scope.unreadLeads.slice(0, MAX_LEADS_SHOWN).map(describeLead).join("; ");
    const more = scope.unreadLeads.length > MAX_LEADS_SHOWN ? ` (+${scope.unreadLeads.length - MAX_LEADS_SHOWN} more)` : "";
    parts.push(`Your searches found code you have not read: ${shown}${more}. Read the relevant implementation with read_repo_file, or conclude and state plainly that it was not inspected.`);
  }
  if (overclaim) {
    parts.push(`Your conclusion describes a wider scope than the tool history supports ("${overclaim.phrase}"). Restate it so it covers only the recorded scope.`);
  }
  parts.push('You are not required to submit a finding. "Nothing new in <the scope you actually covered>" is a valid conclusion.');
  return parts.join("\n");
}
