// Deterministic finding gate (7b).
//
// Agents no longer save free-form suggestions: save_suggestion takes a
// structured finding (class, location, claim, failure scenario, impact,
// run-bound evidence, disproof attempt, proposed change). This module decides,
// with NO model judgment, whether a finding is accepted, downgraded or
// rejected:
//
//   1. Every evidence item must cite a ref recorded by THIS run's ledger
//      (lib/evidence-ledger.ts) and its excerpt must match the recorded tool
//      output exactly (whitespace-normalised). Line numbers are accepted only
//      when they are the line numbers the tool printed; when omitted they are
//      taken from the tool output, never from the model.
//   2. The location's file must have been read or searched in this run.
//   3. Machine-checkable assertions are checked against the run's tool
//      output: a "mismatch" needs two different values that literally occur
//      in the two cited excerpts; an "absence" needs a search (or db_read)
//      from this run that really returned nothing, and is contradicted by any
//      recorded read or search of the location file that shows the text.
//   4. Claims that assert something is missing / not checked ("no", "not",
//      "without", "missing", "fewer than", ...) must carry a passing absence
//      assertion, or they are rejected as unsupported.
//   5. Class policy: verified_bug needs a machine-checkable assertion, >= 2
//      independent sources, a read of the location file showing the symbol,
//      a real disproof attempt and an unhedged claim; otherwise it is
//      downgraded to plausible_risk (evidence-backed) or rejected. Risks are
//      capped at medium priority; product ideas are always low priority and
//      never labelled as bugs.
//
// Pure: no I/O.

import type { EvidenceLedger, EvidenceRecord } from "./evidence-ledger";
import { normalizeCategory } from "./suggestion-category";

export type FindingClass = "verified_bug" | "plausible_risk" | "product_idea";
export const FINDING_CLASSES: readonly FindingClass[] = ["verified_bug", "plausible_risk", "product_idea"];
export type Priority = "low" | "medium" | "high";

export interface EvidenceClaim {
  ref: string;
  file?: string;
  start_line?: number;
  end_line?: number;
  excerpt: string;
  commit?: string;
}

export interface Assertion {
  kind: "mismatch" | "absence" | "presence";
  a_evidence?: number; // 1-based index into evidence
  a_value?: string;
  b_evidence?: number;
  b_value?: string;
  ref?: string; // absence: the search_code / db_read ref that found nothing
}

export interface FindingInput {
  class: FindingClass;
  title: string;
  location?: { file?: string; symbol?: string; line?: number };
  claim: string;
  failure_scenario: string;
  impact: string;
  evidence: EvidenceClaim[];
  assertion?: Assertion;
  what_checked_to_disprove: string;
  proposed_change: string;
  priority: Priority;
  category?: string;
}

export interface ValidatedEvidence {
  index: number; // 1-based position in the submitted evidence list
  ref: string;
  tool: string;
  code: boolean;
  file?: string;
  startLine?: number; // from the tool output, never from the model
  endLine?: number;
  excerpt: string; // normalised
  commit?: string;
}

export type GateCode = "invalid_input" | "invalid_evidence" | "contradicted" | "unsupported_absence" | "insufficient";

export type GateResult =
  | {
      decision: "accept";
      requestedClass: FindingClass;
      finalClass: FindingClass;
      priority: Priority;
      category: string;
      evidence: ValidatedEvidence[];
      downgraded: string[]; // why a verified_bug became a plausible_risk (empty otherwise)
      finding: FindingInput;
    }
  | {
      decision: "reject";
      code: GateCode;
      requestedClass?: FindingClass;
      reasons: string[];
      evidence: ValidatedEvidence[];
      finding?: FindingInput;
    };

export const MAX_EVIDENCE_ITEMS = 12;
const MIN_EXCERPT_ALNUM = 6;
const MIN_DISPROOF_CHARS = 20;

// Hedging is fine in a risk; it is not allowed in a verified claim.
export const HEDGE = /\b(might|could|possibly|possible|likely|maybe|perhaps|probably|potential|potentially|may|seems?|appears? to|suspect(?:ed)?|unclear)\b/i;
// A claim that something is missing / not checked needs an absence proof.
export const ABSENCE_LANGUAGE = /\b(no|not|never|without|missing|lacks?|lacking|absent|bypass(?:es|ed)?|skips?|skipped|unchecked|unvalidated|unguarded|unhandled|doesn'?t|don'?t|isn'?t|aren'?t|fails? to|fewer than|less than)\b/i;
const EMPTY_DISPROOF = /^(n\/?a|none|nothing|no|-+|tbd|unknown)\.?$/i;
const RESERVED_IDEA_CATEGORIES = new Set(["bug", "bugs", "defect", "risk", "security", "vulnerability", "crash", "regression", "fix", "hotfix", "critical", "incident"]);

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const optInt = (v: unknown): number | undefined | null => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) && n >= 1 ? n : null;
};
const cleanPath = (p: string) => p.replace(/^\.\//, "").trim();

// ---- normalisation (exact tokens, whitespace-insensitive) ----
const ROW_PREFIX = /^\s*\d+\|\s?/;
const collapse = (s: string) => s.trim().replace(/\s+/g, " ");
export function excerptLines(s: string): string[] {
  return s.replace(/\r\n?/g, "\n").split("\n").map((l) => collapse(l.replace(ROW_PREFIX, ""))).filter(Boolean);
}
const alnumCount = (s: string) => (s.match(/[A-Za-z0-9]/g) ?? []).length;

// ---- input parsing ----
export function parseFindingInput(raw: unknown): { ok: true; finding: FindingInput } | { ok: false; reasons: string[] } {
  if (!raw || typeof raw !== "object") return { ok: false, reasons: ["the finding must be an object"] };
  const r = raw as Record<string, unknown>;
  const reasons: string[] = [];
  const cls = str(r.class) as FindingClass;
  if (!FINDING_CLASSES.includes(cls)) reasons.push(`class must be one of ${FINDING_CLASSES.join(", ")}`);
  const title = str(r.title);
  if (!title) reasons.push("title is required");
  const claim = str(r.claim);
  if (!claim) reasons.push("claim is required");
  const impact = str(r.impact);
  if (!impact) reasons.push("impact is required");
  const proposed = str(r.proposed_change);
  if (!proposed) reasons.push("proposed_change is required");
  const failure = str(r.failure_scenario);
  if (cls !== "product_idea" && !failure) reasons.push("failure_scenario is required for bugs and risks");
  const priority: Priority = (["low", "medium", "high"] as const).includes(str(r.priority) as Priority) ? (str(r.priority) as Priority) : "medium";

  let location: FindingInput["location"];
  if (r.location !== undefined && r.location !== null) {
    if (typeof r.location !== "object") reasons.push("location must be an object");
    else {
      const l = r.location as Record<string, unknown>;
      const line = optInt(l.line);
      if (line === null) reasons.push("location.line must be a whole number >= 1");
      location = { ...(str(l.file) ? { file: cleanPath(str(l.file)) } : {}), ...(str(l.symbol) ? { symbol: str(l.symbol) } : {}), ...(line ? { line } : {}) };
    }
  }
  if (cls === "verified_bug" && (!location?.file || !location.symbol)) reasons.push("verified_bug needs location.file and location.symbol");
  if (location?.line && !location.file) reasons.push("location.line needs location.file");

  const evidence: EvidenceClaim[] = [];
  const rawEv = r.evidence;
  if (rawEv !== undefined && rawEv !== null && rawEv !== "") {
    if (!Array.isArray(rawEv)) reasons.push("evidence must be a list of {ref, excerpt, file?, start_line?, end_line?}");
    else if (rawEv.length > MAX_EVIDENCE_ITEMS) reasons.push(`at most ${MAX_EVIDENCE_ITEMS} evidence items`);
    else {
      rawEv.forEach((e, i) => {
        if (!e || typeof e !== "object") return void reasons.push(`evidence ${i + 1} must be an object`);
        const o = e as Record<string, unknown>;
        const start = optInt(o.start_line ?? o.line);
        const end = optInt(o.end_line);
        if (start === null || end === null) return void reasons.push(`evidence ${i + 1}: line numbers must be whole numbers >= 1`);
        if (end !== undefined && start === undefined) return void reasons.push(`evidence ${i + 1}: end_line needs start_line`);
        evidence.push({
          ref: str(o.ref),
          excerpt: typeof o.excerpt === "string" ? o.excerpt : "",
          ...(str(o.file) ? { file: cleanPath(str(o.file)) } : {}),
          ...(start ? { start_line: start } : {}),
          ...(end ? { end_line: end } : {}),
          ...(str(o.commit) ? { commit: str(o.commit) } : {}),
        });
      });
    }
  }
  if (cls !== "product_idea" && FINDING_CLASSES.includes(cls) && evidence.length === 0 && !reasons.length) reasons.push("bugs and risks need at least one evidence item from this run");

  let assertion: Assertion | undefined;
  if (r.assertion !== undefined && r.assertion !== null) {
    const a = (typeof r.assertion === "object" ? r.assertion : {}) as Record<string, unknown>;
    const kind = str(a.kind) as Assertion["kind"];
    if (!["mismatch", "absence", "presence"].includes(kind)) reasons.push("assertion.kind must be mismatch, absence or presence");
    else {
      const ai = optInt(a.a_evidence);
      const bi = optInt(a.b_evidence);
      assertion = {
        kind,
        ...(ai ? { a_evidence: ai } : {}),
        ...(bi ? { b_evidence: bi } : {}),
        ...(typeof a.a_value === "string" ? { a_value: a.a_value } : {}),
        ...(typeof a.b_value === "string" ? { b_value: a.b_value } : {}),
        ...(str(a.ref) ? { ref: str(a.ref) } : {}),
      };
    }
  }

  if (reasons.length) return { ok: false, reasons };
  return {
    ok: true,
    finding: {
      class: cls,
      title,
      ...(location && Object.keys(location).length ? { location } : {}),
      claim,
      failure_scenario: failure,
      impact,
      evidence,
      ...(assertion ? { assertion } : {}),
      what_checked_to_disprove: str(r.what_checked_to_disprove),
      proposed_change: proposed,
      priority,
      ...(str(r.category) ? { category: str(r.category) } : {}),
    },
  };
}

// ---- evidence validation ----
function matchRead(rec: EvidenceRecord, ex: string[]): [number, number][] {
  const w = rec.read!;
  const entries = [...w.lines.entries()].sort((a, b) => a[0] - b[0]).map(([n, t]) => ({ n, t: collapse(t) })).filter((e) => e.t);
  const k = ex.length;
  const out: [number, number][] = [];
  for (let j = 0; j + k - 1 < entries.length; j++) {
    if (k === 1) {
      if (entries[j].t.includes(ex[0])) out.push([entries[j].n, entries[j].n]);
      continue;
    }
    if (!entries[j].t.endsWith(ex[0])) continue;
    let ok = true;
    for (let m = 1; m < k - 1 && ok; m++) ok = entries[j + m].t === ex[m];
    if (ok && entries[j + k - 1].t.startsWith(ex[k - 1])) out.push([entries[j].n, entries[j + k - 1].n]);
  }
  return out;
}

export function validateEvidenceItem(item: EvidenceClaim, index: number, ledger: EvidenceLedger): { ok: true; ev: ValidatedEvidence } | { ok: false; reason: string } {
  const at = `evidence ${index}`;
  if (!item.ref) return { ok: false, reason: `${at}: missing ref — cite the evidence ref printed under a tool result from this run` };
  const rec = ledger.get(item.ref);
  // Model-supplied strings are never echoed back in reasons (they could carry
  // unverified figures into logs or into later claim-guard material).
  if (!rec) return { ok: false, reason: `${at}: its ref was not returned by any tool in this run` };
  if (item.commit && item.commit !== ledger.commit) return { ok: false, reason: `${at}: cites a different commit than the one this run is pinned to (${ledger.commit ?? "no commit"})` };
  const ex = excerptLines(item.excerpt);
  if (!ex.length || alnumCount(ex.join(" ")) < MIN_EXCERPT_ALNUM) return { ok: false, reason: `${at}: excerpt is missing or too short to identify the source` };
  const base = { index, ref: rec.ref, tool: rec.tool, excerpt: ex.join("\n") };

  if (rec.tool === "read_repo_file") {
    const w = rec.read!;
    if (item.file && item.file !== w.path) return { ok: false, reason: `${at}: ref ${rec.ref} is a read of ${w.path}, not of the file cited` };
    const cands = matchRead(rec, ex);
    if (!cands.length) return { ok: false, reason: `${at}: the excerpt does not appear in the read of ${w.path} lines ${w.start}-${w.end}` };
    let pick = cands[0];
    if (item.start_line !== undefined) {
      const hit = cands.find(([s, e]) => s === item.start_line && (item.end_line === undefined || e === item.end_line));
      if (!hit) {
        const where = cands.map(([s, e]) => (s === e ? `${s}` : `${s}-${e}`)).join(", ");
        return { ok: false, reason: `${at}: the cited line number is not where the tool showed this excerpt (${w.path} line ${where})` };
      }
      pick = hit;
    }
    return { ok: true, ev: { ...base, code: true, file: w.path, startLine: pick[0], endLine: pick[1], commit: w.commit } };
  }

  if (rec.tool === "search_code") {
    const s = rec.search!;
    if (ex.length !== 1) return { ok: false, reason: `${at}: a search_code excerpt must be a single matched line` };
    const cands = s.hits.filter((h) => collapse(h.text).includes(ex[0]) && (!item.file || h.file === item.file));
    if (!cands.length) return { ok: false, reason: `${at}: the excerpt does not appear in the search results for ${JSON.stringify(s.query)}${item.file ? " in the file cited" : ""}` };
    let pick = cands[0];
    if (item.start_line !== undefined) {
      const hit = cands.find((h) => h.line === item.start_line && (item.end_line === undefined || item.end_line === h.line));
      if (!hit) return { ok: false, reason: `${at}: the cited line number is not where the search showed this excerpt (${cands.map((h) => `${h.file}:${h.line}`).join(", ")})` };
      pick = hit;
    }
    return { ok: true, ev: { ...base, code: true, file: pick.file, startLine: pick.line, endLine: pick.line, commit: s.commit } };
  }

  // Data evidence (db_read, read_footrank_stats, web_search): no files or lines.
  if (item.file || item.start_line !== undefined) return { ok: false, reason: `${at}: ${rec.tool} output has no files or line numbers — cite only the excerpt` };
  const text = excerptLines(rec.output).join("\n");
  if (!text.includes(ex.join("\n"))) return { ok: false, reason: `${at}: the excerpt does not appear in the ${rec.tool} output` };
  return { ok: true, ev: { ...base, code: false } };
}

// ---- helpers for policy ----
const overlaps = (a: ValidatedEvidence, b: ValidatedEvidence) =>
  a.file !== undefined && a.file === b.file && a.startLine !== undefined && b.startLine !== undefined && a.startLine <= (b.endLine ?? b.startLine) && b.startLine <= (a.endLine ?? a.startLine);

// Independent = different tool results AND different (non-overlapping) locations.
export function independentSources(evs: ValidatedEvidence[]): number {
  const picked: ValidatedEvidence[] = [];
  for (const e of evs) if (!picked.some((p) => p.ref === e.ref || overlaps(p, e))) picked.push(e);
  return picked.length;
}

export const bareSymbol = (s: string) => {
  const parts = s.replace(/\(\s*\)/g, "").split(/[.#:\s]+/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
};

const scopeCovers = (scope: string, file: string) => !scope || file === scope || file.startsWith(`${scope.replace(/\/$/, "")}/`);
const readText = (r: EvidenceRecord) => excerptLines([...r.read!.lines.values()].join("\n")).join("\n");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function containsValue(excerpt: string, value: string): boolean {
  const v = collapse(value);
  if (!v) return false;
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRe(v)}(?![A-Za-z0-9_])`).test(excerpt.replace(/\n/g, " "));
}

function symbolSeen(ledger: EvidenceLedger, file: string, symbol: string): boolean {
  const s = bareSymbol(symbol);
  if (!s) return false;
  return ledger.all().some((r) =>
    (r.read !== undefined && r.read.path === file && [...r.read.lines.values()].some((l) => l.includes(s))) ||
    (r.search !== undefined && r.search.hits.some((h) => h.file === file && h.text.includes(s))),
  );
}

type AssertionCheck = { status: "ok" | "none" | "weak" } | { status: "invalid" | "contradicted"; reason: string };

// Checks a submitted assertion against this run's tool output.
// "contradicted" = the run's own evidence shows the opposite.
function checkAssertion(f: FindingInput, evs: ValidatedEvidence[], ledger: EvidenceLedger): AssertionCheck {
  const a = f.assertion;
  if (!a) return { status: "none" };
  if (a.kind === "presence") return { status: "weak" };
  if (a.kind === "mismatch") {
    const A = evs.find((e) => e.index === a.a_evidence);
    const B = evs.find((e) => e.index === a.b_evidence);
    if (!A || !B || A.index === B.index) return { status: "invalid", reason: "mismatch assertion must point at two different evidence items (a_evidence, b_evidence: 1-based)" };
    if (!a.a_value?.trim() || !a.b_value?.trim()) return { status: "invalid", reason: "mismatch assertion needs a_value and b_value" };
    if (!containsValue(A.excerpt, a.a_value)) return { status: "invalid", reason: `mismatch a_value does not occur in evidence ${A.index}` };
    if (!containsValue(B.excerpt, a.b_value)) return { status: "invalid", reason: `mismatch b_value does not occur in evidence ${B.index}` };
    if (collapse(a.a_value).toLowerCase() === collapse(a.b_value).toLowerCase()) {
      const at = (e: ValidatedEvidence) => `${e.file ?? e.tool}${e.startLine ? `:${e.startLine}` : ""}`;
      return { status: "contradicted", reason: `the cited evidence shows the same value "${collapse(a.a_value).slice(0, 60)}" on both sides (${at(A)} and ${at(B)}) — there is no mismatch` };
    }
    return { status: "ok" };
  }
  // absence
  const rec = ledger.get(a.ref);
  if (!rec || (rec.tool !== "search_code" && rec.tool !== "db_read")) return { status: "invalid", reason: "absence assertion needs the ref of a search_code or db_read result from this run" };
  if (rec.tool === "db_read") {
    return rec.output.trim() === "[]" ? { status: "ok" } : { status: "contradicted", reason: `the absence query (${rec.ref}) returned rows` };
  }
  const s = rec.search!;
  const file = f.location?.file;
  if (s.query.replace(/\s/g, "").length < 3) return { status: "invalid", reason: "absence search query is too short to prove anything" };
  if (file && !scopeCovers(s.scope, file)) return { status: "invalid", reason: `absence search ${JSON.stringify(s.query)} was limited to ${s.scope}, which does not include ${file}` };
  if (!s.noMatches) {
    const where = s.hits.slice(0, 3).map((h) => `${h.file}:${h.line}`).join(", ");
    return { status: "contradicted", reason: `search ${JSON.stringify(s.query)} in this run found it (${where})` };
  }
  if (file) {
    const q = collapse(s.query);
    for (const r of ledger.all()) {
      if (r.read && r.read.path === file && readText(r).includes(q)) return { status: "contradicted", reason: `${file} as read in this run (${r.ref}) contains ${JSON.stringify(s.query)}` };
      if (r.search && collapse(r.search.query) === q && !r.search.noMatches && r.search.hits.some((h) => h.file === file)) {
        return { status: "contradicted", reason: `another search for ${JSON.stringify(s.query)} in this run found it in ${file}` };
      }
    }
  }
  return { status: "ok" };
}

export function ideaCategory(raw: string | undefined): string {
  const c = normalizeCategory(raw ?? "");
  return c.valid && !RESERVED_IDEA_CATEGORIES.has(c.category) ? c.category : "idea";
}

// ---- the gate ----
export function evaluateFinding(raw: unknown, ledger: EvidenceLedger): GateResult {
  const parsed = parseFindingInput(raw);
  if (!parsed.ok) {
    const cls = str((raw as Record<string, unknown> | null)?.class) as FindingClass;
    return { decision: "reject", code: "invalid_input", ...(FINDING_CLASSES.includes(cls) ? { requestedClass: cls } : {}), reasons: parsed.reasons, evidence: [] };
  }
  const f = parsed.finding;
  const reject = (code: GateCode, reasons: string[], evs: ValidatedEvidence[] = []): GateResult => ({ decision: "reject", code, requestedClass: f.class, reasons, evidence: evs, finding: f });

  // 1. evidence — every item must be real; one fabricated item sinks the finding.
  const evs: ValidatedEvidence[] = [];
  const bad: string[] = [];
  f.evidence.forEach((item, i) => {
    const v = validateEvidenceItem(item, i + 1, ledger);
    if (v.ok) evs.push(v.ev);
    else bad.push(v.reason);
  });
  if (bad.length) return reject("invalid_evidence", bad, evs);

  // 2. the location must be something this run actually looked at.
  const loc = f.location;
  if (loc?.file) {
    if (loc.file.startsWith("db:")) {
      if (!evs.some((e) => e.tool === "db_read")) return reject("invalid_evidence", [`location ${loc.file} needs db_read evidence from this run`], evs);
    } else {
      const inFile = evs.filter((e) => e.code && e.file === loc.file);
      if (!inFile.length) return reject("invalid_evidence", [`location ${loc.file} was not read or found by search_code in the cited evidence of this run`], evs);
      const line = loc.line;
      if (line && !inFile.some((e) => (e.startLine ?? 0) <= line && line <= (e.endLine ?? 0))) {
        return reject("invalid_evidence", [`location.line is not covered by any cited evidence for ${loc.file} (cited lines: ${inFile.map((e) => `${e.startLine}-${e.endLine}`).join(", ")})`], evs);
      }
    }
  }

  // 3. machine-checkable assertion.
  const as = checkAssertion(f, evs, ledger);
  if (as.status === "contradicted") return reject("contradicted", [as.reason], evs);
  if (as.status === "invalid") return reject("invalid_evidence", [as.reason], evs);

  // 4. a claim that something is missing needs proof that it is missing.
  if (f.class !== "product_idea" && ABSENCE_LANGUAGE.test(f.claim) && !(f.assertion?.kind === "absence" && as.status === "ok")) {
    return reject("unsupported_absence", ["the claim says something is missing or not checked, but no search_code/db_read from this run proved the absence (add an absence assertion with the ref of a search that returned no matches)"], evs);
  }

  // 5. class policy.
  if (f.class === "product_idea") {
    return { decision: "accept", requestedClass: f.class, finalClass: "product_idea", priority: "low", category: ideaCategory(f.category), evidence: evs, downgraded: [], finding: f };
  }
  if (!evs.length) return reject("insufficient", ["bugs and risks need at least one evidence item from this run"], evs);
  const riskPriority: Priority = f.priority === "high" ? "medium" : f.priority;

  if (f.class === "verified_bug") {
    const short: string[] = [];
    if (as.status !== "ok") short.push("no machine-checkable assertion (mismatch or absence) — a verified bug must be checkable against the tool output");
    if (independentSources(evs) < 2) short.push("fewer than 2 independent sources (different tool results at different locations)");
    if (!evs.some((e) => e.tool === "read_repo_file" && e.file === loc?.file)) short.push(`no read_repo_file evidence of the location file ${loc?.file}`);
    if (loc?.file && loc.symbol && !symbolSeen(ledger, loc.file, loc.symbol)) short.push(`symbol ${bareSymbol(loc.symbol)} was not seen in ${loc.file} in this run`);
    if (f.what_checked_to_disprove.length < MIN_DISPROOF_CHARS || EMPTY_DISPROOF.test(f.what_checked_to_disprove)) short.push("what_checked_to_disprove is empty or not a real disproof attempt");
    const hedge = HEDGE.exec(f.claim) ?? HEDGE.exec(f.title);
    if (hedge) short.push(`the claim is hedged ("${hedge[0]}") — hedged claims are risks, not verified bugs`);
    if (!short.length) {
      return { decision: "accept", requestedClass: f.class, finalClass: "verified_bug", priority: f.priority, category: "bug", evidence: evs, downgraded: [], finding: f };
    }
    // Downgrade only because the evidence (validated above) supports a risk.
    return { decision: "accept", requestedClass: f.class, finalClass: "plausible_risk", priority: riskPriority, category: "risk", evidence: evs, downgraded: short, finding: f };
  }

  return { decision: "accept", requestedClass: f.class, finalClass: "plausible_risk", priority: riskPriority, category: "risk", evidence: evs, downgraded: [], finding: f };
}

// ---- rendering (model prose only; evidence is rendered from the ledger) ----
export function renderFindingProse(raw: Record<string, unknown>): { title: string; body: string } {
  const loc = (raw.location && typeof raw.location === "object" ? raw.location : {}) as Record<string, unknown>;
  const line = optInt(loc.line);
  const where = str(loc.file) ? `${str(loc.file)}${str(loc.symbol) ? ` › ${str(loc.symbol)}` : ""}${line ? ` (line ${line})` : ""}` : "";
  const parts: [string, string][] = [
    ["Claim", str(raw.claim)],
    ["Where", where],
    ["Failure scenario", str(raw.failure_scenario)],
    ["Impact", str(raw.impact)],
    ["Checked to disprove", str(raw.what_checked_to_disprove)],
    ["Proposed change", str(raw.proposed_change)],
  ];
  return { title: str(raw.title), body: parts.filter(([, v]) => v).map(([k, v]) => `**${k}:** ${v}`).join("\n\n") };
}

export const CLASS_LABEL: Record<FindingClass, string> = {
  verified_bug: "Verified bug",
  plausible_risk: "Risk",
  product_idea: "Idea",
};
