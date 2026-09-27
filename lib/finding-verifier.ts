// Independent finding verification (7c).
//
// Runs AFTER the deterministic evidence gate (lib/finding-gate.ts) and the
// duplicate check. The gate proved that the cited evidence is authentic (this
// run, pinned commit, exact excerpts and lines). This module answers a
// different question: does the finding actually hold up when checked
// independently?
//
//   1. Deterministic probes, run by the verifier itself with the read-only
//      code tools at the run's pinned commit (never the agent's own reads):
//        - re-read every cited location with surrounding context and confirm
//          the cited excerpt is really there (else REJECT: not reproducible);
//        - search the location's symbol repo-wide (definition, callers,
//          alternate paths) and in test/ (tests, safeguards);
//        - for absence claims ("no", "not", "missing", "fewer than", ...):
//          widen the search to the identifiers of the claimed-missing check
//          and look for guards. A guard inside the re-read function REJECTS
//          the finding (contradicted); a guard elsewhere in a cited file means
//          the absence is not established (bug -> risk, risk -> REJECT). One
//          narrow no-match search is never treated as proof.
//   2. ONE bounded model call (free router, VERIFIER_TIER) that judges the
//      finding against the authenticated evidence and the probe outputs and
//      returns strict JSON: SURVIVES / DOWNGRADE / REJECT. The model can only
//      keep or WEAKEN a finding, never strengthen it, and must cite the probe
//      or evidence ids it relied on. Its verdict is also capped by the
//      deterministic probes.
//
// Fail closed: a timeout, provider failure, malformed output, missing code
// access or an exhausted budget means the finding is NOT verified (the caller
// saves nothing).
//
// Authority: this module can only call the two read-only code tools it is
// given and the free LLM router. It never writes, saves, alerts or logs.

import { freeLlm, type TaskTier } from "./free-llm";
import type { JsonSchema, LlmRequest } from "./llm";
import { readRepoFileLines } from "../tools/github-read";
import { searchCode } from "../tools/code-search";
import { parseReadWindow, parseSearchResult, type EvidenceLedger, type ReadWindow, type SearchResult } from "./evidence-ledger";
import { ABSENCE_LANGUAGE, bareSymbol, excerptLines, type FindingClass, type FindingInput, type ValidatedEvidence } from "./finding-gate";

export type Verdict = "SURVIVES" | "DOWNGRADE" | "REJECT";

// ---- budget (deterministic, per investigation run) ----
// "medium" = Gemini Flash-Lite first, local Qwen as fallback. Never the
// high tier (Gemini 3.8 Flash) that cybersecurity uses.
export const VERIFIER_TIER: TaskTier = "medium";
export const MAX_VERIFIER_MODEL_CALLS_PER_RUN = 3;
export const MAX_VERIFIER_TOOL_CALLS_PER_RUN = 18;
export const MAX_VERIFIER_TOOL_CALLS_PER_FINDING = 6;
export const VERIFIER_TOOL_TIMEOUT_MS = 20_000;
export const VERIFIER_MODEL_TIMEOUT_MS = 120_000;
export const VERIFIER_MAX_OUTPUT_TOKENS = 600;
export const CONTEXT_LINES = 25;
const MAX_REREAD_FILES = 2;
const MAX_ABSENCE_SEARCHES = 2;
const PROBE_PROMPT_CHARS = 2_400;
const PROMPT_CHARS = 12_000;

// The ONLY capabilities the verifier has: two read-only code tools, bound to
// the run's pinned commit, and one free-router text generation.
export interface VerifierTools {
  readFile(path: string, start: number, end: number): Promise<string>;
  searchCode(query: string, path?: string): Promise<string>;
}
export interface VerifierModel {
  generate(req: LlmRequest): Promise<{ text: string; provider: string; model: string }>;
}
export interface VerifierBudget {
  modelCalls: number;
  toolCalls: number;
  readonly maxModelCalls: number;
  readonly maxToolCalls: number;
}
export interface VerifierRuntime {
  commit?: string;
  tools?: VerifierTools; // undefined when the run has no pinned commit
  model: VerifierModel;
  budget: VerifierBudget;
}

export function createVerifierRuntime(opts: { commit?: string; tools?: VerifierTools; model?: VerifierModel } = {}): VerifierRuntime {
  const commit = opts.commit && /^[0-9a-f]{40}$/.test(opts.commit) ? opts.commit : undefined;
  const tools: VerifierTools | undefined =
    opts.tools ??
    (commit
      ? {
          readFile: (path, start, end) => readRepoFileLines(path, start, end, commit),
          searchCode: (query, path) => searchCode(query, path, commit),
        }
      : undefined);
  const model: VerifierModel = opts.model ?? { generate: (req) => freeLlm.generate(VERIFIER_TIER, req) };
  return { ...(commit ? { commit } : {}), ...(tools ? { tools } : {}), model, budget: { modelCalls: 0, toolCalls: 0, maxModelCalls: MAX_VERIFIER_MODEL_CALLS_PER_RUN, maxToolCalls: MAX_VERIFIER_TOOL_CALLS_PER_RUN } };
}

// ---- result ----
export type VerifyReason =
  // SURVIVES
  | "supported"
  | "idea_not_verified_as_defect"
  // DOWNGRADE
  | "overstated"
  | "impact_unproven"
  | "partially_supported"
  | "absence_not_established"
  // REJECT
  | "contradicted"
  | "unsupported"
  | "speculative"
  | "not_reproducible"
  // verification failed (REJECT, nothing saved)
  | "budget_exhausted"
  | "no_code_access"
  | "tool_failed"
  | "model_failed"
  | "malformed_output"
  | "timeout";

export interface ProbeSummary {
  id: string;
  what: string;
}

export interface VerificationResult {
  verdict: Verdict;
  reason: VerifyReason;
  from: FindingClass;
  to: FindingClass | null; // null = rejected
  failed: boolean; // verification could not be completed (fail closed)
  hard: boolean; // rejected by a deterministic contradiction (remembered as such)
  stage: "skipped" | "deterministic" | "model";
  probes: ProbeSummary[];
  supporting: string[];
  contradicting: string[];
  modelCalls: number; // used by THIS finding
  toolCalls: number; // used by THIS finding
  provider?: string; // provider/model of the verifier call
}

const RANK: Record<FindingClass, number> = { product_idea: 0, plausible_risk: 1, verified_bug: 2 };
const BY_RANK: FindingClass[] = ["product_idea", "plausible_risk", "verified_bug"];
const weaker = (c: FindingClass): FindingClass | null => (RANK[c] === 0 ? null : BY_RANK[RANK[c] - 1]);
const minClass = (a: FindingClass, b: FindingClass): FindingClass => (RANK[a] <= RANK[b] ? a : b);

class VerifyFail extends Error {
  constructor(readonly reason: VerifyReason, detail: string) {
    super(detail);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, reason: VerifyReason): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new VerifyFail(reason, `timed out after ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

// ---- probes ----
interface Probe {
  id: string;
  what: string;
  tool: "read_repo_file" | "search_code";
  output: string;
  read?: ReadWindow;
  search?: SearchResult;
}

class ProbeRunner {
  readonly probes: Probe[] = [];
  toolCalls = 0;
  constructor(private readonly rt: VerifierRuntime, private readonly tools: VerifierTools, private readonly commit: string) {}

  private async spend(): Promise<void> {
    if (this.toolCalls >= MAX_VERIFIER_TOOL_CALLS_PER_FINDING || this.rt.budget.toolCalls >= this.rt.budget.maxToolCalls) {
      throw new VerifyFail("budget_exhausted", "verifier tool budget exhausted");
    }
    this.toolCalls++;
    this.rt.budget.toolCalls++;
  }

  async read(path: string, start: number, end: number): Promise<Probe> {
    await this.spend();
    const out = await withTimeout(this.tools.readFile(path, start, end), VERIFIER_TOOL_TIMEOUT_MS, "timeout").catch((e) => {
      throw e instanceof VerifyFail ? e : new VerifyFail("tool_failed", "read failed");
    });
    const w = parseReadWindow(out);
    if (!w || w.commit !== this.commit || w.path !== path) throw new VerifyFail("tool_failed", `could not re-read ${path}`);
    const p: Probe = { id: `P${this.probes.length + 1}`, what: `read ${path} lines ${w.start}-${w.end}`, tool: "read_repo_file", output: out, read: w };
    this.probes.push(p);
    return p;
  }

  async search(query: string, path?: string): Promise<Probe> {
    await this.spend();
    const out = await withTimeout(this.tools.searchCode(query, path), VERIFIER_TOOL_TIMEOUT_MS, "timeout").catch((e) => {
      throw e instanceof VerifyFail ? e : new VerifyFail("tool_failed", "search failed");
    });
    const s = parseSearchResult(out);
    if (!s || s.commit !== this.commit) throw new VerifyFail("tool_failed", `search for ${JSON.stringify(query)} failed`);
    const n = s.noMatches ? "no matches" : `${s.hits.length}${s.complete ? "" : "+"} match(es)`;
    const p: Probe = { id: `P${this.probes.length + 1}`, what: `searched ${JSON.stringify(query)}${path ? ` in ${path}` : ""} (${n})`, tool: "search_code", output: out, search: s };
    this.probes.push(p);
    return p;
  }
}

const collapse = (s: string) => s.trim().replace(/\s+/g, " ");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Numbers a "missing check" claim is about ("fewer than 5 players", "at least 5").
export function guardNumbers(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(?:fewer than|less than|more than|at least|at most|under|below|above|minimum of|maximum of|min(?:imum)?\.?|max(?:imum)?\.?)\s+(\d{1,6})\b/gi)) out.add(m[1]);
  return [...out];
}

// Identifiers worth widening an absence search on (e.g. "memberCount" from
// "memberCount < 5", "members.length" from "members.length < 5"): code-like
// tokens only (camelCase, snake_case or dotted), never plain English words.
export function absenceIdentifiers(query: string): string[] {
  const ids = (query.match(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g) ?? []).filter((t) => t.length >= 4 && (/[a-z][A-Z]/.test(t) || t.includes("_") || t.includes(".")));
  return [...new Set(ids)];
}

// A line that implements the check the claim says is missing: a comparison
// against the same number, or the literal claimed-missing expression.
export function isGuardLine(line: string, numbers: string[], literal?: string): boolean {
  const l = collapse(line);
  if (literal && collapse(literal).length >= 3 && l.includes(collapse(literal))) return true;
  return numbers.some((n) => new RegExp(`(?:<=?|>=?)\\s*${escapeRe(n)}(?![0-9])`).test(l));
}

export interface VerifyInput {
  finding: FindingInput;
  cls: FindingClass; // class after the gate (verified_bug / plausible_risk / product_idea)
  evidence: ValidatedEvidence[];
}

// Is the cited excerpt really at the cited lines of a FRESH read?
function excerptAt(w: ReadWindow, e: ValidatedEvidence): boolean {
  const raw: string[] = [];
  for (let n = e.startLine!; n <= e.endLine!; n++) {
    if (!w.lines.has(n)) return false;
    raw.push(w.lines.get(n)!);
  }
  const lines = excerptLines(raw.join("\n"));
  return e.excerpt.includes("\n") ? lines.join("\n").includes(e.excerpt) : lines.some((l) => l.includes(e.excerpt));
}

// ---- deterministic stage ----
interface Deterministic {
  runner?: ProbeRunner;
  cap: FindingClass | null; // highest class the probes allow (null = reject)
  reason?: VerifyReason;
  hard: boolean;
  contradicting: string[];
}

async function deterministicStage(v: VerifyInput, ledger: EvidenceLedger, runner: ProbeRunner | undefined): Promise<Deterministic> {
  const f = v.finding;
  const code = v.evidence.filter((e) => e.code && e.file && e.startLine !== undefined);
  const isAbsence = f.assertion?.kind === "absence" || ABSENCE_LANGUAGE.test(f.claim);
  if (!code.length && !f.location?.file) return { cap: v.cls, hard: false, contradicting: [] }; // data-only finding: model judges it
  if (!runner) throw new VerifyFail("no_code_access", "no pinned code access for the verifier");

  // 1. Re-read each cited location (with context) and confirm the excerpt.
  const files = [...new Set([...(f.location?.file && !f.location.file.startsWith("db:") ? [f.location.file] : []), ...code.map((e) => e.file!)])].slice(0, MAX_REREAD_FILES);
  const windows = new Map<string, Probe>();
  for (const file of files) {
    const inFile = code.filter((e) => e.file === file);
    const lines = [...inFile.flatMap((e) => [e.startLine!, e.endLine!]), ...(f.location?.file === file && f.location.line ? [f.location.line] : [])];
    const lo = lines.length ? Math.max(1, Math.min(...lines) - CONTEXT_LINES) : 1;
    const hi = lines.length ? Math.max(...lines) + CONTEXT_LINES : 2 * CONTEXT_LINES;
    const p = await runner.read(file, lo, hi);
    windows.set(file, p);
    for (const e of inFile) {
      if (!excerptAt(p.read!, e)) return { runner, cap: null, reason: "not_reproducible", hard: true, contradicting: [p.id] };
    }
  }

  // 2. Definition / callers / alternate paths, and tests or safeguards.
  const sym = f.location?.symbol ? bareSymbol(f.location.symbol) : "";
  if (sym.length >= 3) {
    await runner.search(sym);
    await runner.search(sym, "test");
  }

  // 3. Absence claims: widen the investigation; one no-match search is never proof.
  if (!isAbsence) return { runner, cap: v.cls, hard: false, contradicting: [] };
  const absenceRec = f.assertion?.kind === "absence" ? ledger.get(f.assertion.ref) : undefined;
  const literal = absenceRec?.search?.query;
  const numbers = [...new Set([...guardNumbers(`${f.claim} ${f.title} ${f.failure_scenario}`), ...(literal ? (literal.match(/\b\d{1,6}\b/g) ?? []) : [])])];
  const idents = literal ? absenceIdentifiers(literal) : [];
  for (const id of idents.slice(0, MAX_ABSENCE_SEARCHES)) await runner.search(id);

  const locFile = f.location?.file;
  const contradicting: string[] = [];
  // a. A guard inside the re-read code around the cited location: contradicted.
  const locWin = locFile ? windows.get(locFile) : undefined;
  if (locWin) {
    for (const [n, text] of locWin.read!.lines) {
      if (isGuardLine(text, numbers, literal)) return { runner, cap: null, reason: "contradicted", hard: true, contradicting: [`${locWin.id}:${n}`] };
    }
  }
  // b. A guard elsewhere in a cited file (from any widened search): absence not established.
  const relevant = new Set(files);
  for (const p of runner.probes) {
    for (const h of p.search?.hits ?? []) {
      const idHit = idents.some((id) => h.text.includes(id)) && numbers.some((n) => new RegExp(`(?<![0-9])${escapeRe(n)}(?![0-9])`).test(h.text));
      if (relevant.has(h.file) && (isGuardLine(h.text, numbers, literal) || idHit)) contradicting.push(`${p.id}:${h.file}:${h.line}`);
    }
  }
  if (contradicting.length) {
    const cap = weaker(v.cls);
    // bug -> risk; a risk whose absence is not established does not survive.
    return { runner, cap: cap === "product_idea" ? null : cap, reason: "absence_not_established", hard: false, contradicting };
  }
  return { runner, cap: v.cls, hard: false, contradicting: [] };
}

// ---- model stage ----
const SYSTEM = `You are an independent verifier for software findings about the FootRank app. You did NOT write the finding; its author may be wrong. Your job is to decide whether the finding actually holds up given ONLY the authenticated evidence (E ids) and the verifier's own fresh tool output (P ids) below. Be skeptical: a claim that something is missing needs evidence that it is missing everywhere relevant, not one narrow search. Never invent code, lines or data. You may keep or weaken the finding, never strengthen it.

Reply with ONE JSON object and nothing else:
{"verdict":"SURVIVES"|"DOWNGRADE"|"REJECT","reason_code":"...","downgrade_to":"plausible_risk"|"product_idea"|null,"supporting":["E1","P2"],"contradicting":["P3"]}
reason_code for SURVIVES: "supported". For DOWNGRADE: "overstated" | "impact_unproven" | "partially_supported" | "absence_not_established". For REJECT: "contradicted" | "unsupported" | "speculative".
SURVIVES must cite at least one supporting id and no contradicting ids. Use only ids that appear below.`;

const SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["SURVIVES", "DOWNGRADE", "REJECT"] },
    reason_code: { type: "string" },
    downgrade_to: { type: "string", enum: ["plausible_risk", "product_idea"], nullable: true },
    supporting: { type: "array", items: { type: "string" } },
    contradicting: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "reason_code", "supporting", "contradicting"],
};

const REASONS: Record<Verdict, VerifyReason[]> = {
  SURVIVES: ["supported"],
  DOWNGRADE: ["overstated", "impact_unproven", "partially_supported", "absence_not_established"],
  REJECT: ["contradicted", "unsupported", "speculative"],
};

export interface ModelVerdict {
  verdict: Verdict;
  reason: VerifyReason;
  downgradeTo: FindingClass | null;
  supporting: string[];
  contradicting: string[];
}

// Strict parser: anything unexpected is malformed (fail closed).
export function parseVerifierOutput(text: string, ids: ReadonlySet<string>, cls: FindingClass): ModelVerdict | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const verdict = o.verdict as Verdict;
  if (!["SURVIVES", "DOWNGRADE", "REJECT"].includes(verdict)) return null;
  const reason = o.reason_code as VerifyReason;
  if (!REASONS[verdict].includes(reason)) return null;
  const list = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);
  const supporting = list(o.supporting ?? []);
  const contradicting = list(o.contradicting ?? []);
  if (!supporting || !contradicting) return null;
  if ([...supporting, ...contradicting].some((id) => !ids.has(id))) return null; // cited something that does not exist
  if (verdict === "SURVIVES" && (supporting.length === 0 || contradicting.length > 0)) return null;
  let downgradeTo: FindingClass | null = null;
  if (verdict === "DOWNGRADE") {
    const d = o.downgrade_to;
    if (d === undefined || d === null) downgradeTo = weaker(cls);
    else if ((d === "plausible_risk" || d === "product_idea") && RANK[d] < RANK[cls]) downgradeTo = d;
    else return null; // "downgrade" to an equal or stronger class
    if (!downgradeTo) return null;
  }
  return { verdict, reason, downgradeTo, supporting: [...new Set(supporting)], contradicting: [...new Set(contradicting)] };
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…(truncated)` : s);

function buildPrompt(v: VerifyInput, probes: Probe[]): string {
  const f = v.finding;
  const ev = v.evidence.map((e) => `E${e.index} [${e.tool}${e.file ? ` ${e.file}:${e.startLine === e.endLine ? e.startLine : `${e.startLine}-${e.endLine}`}` : ""}]\n${e.excerpt}`).join("\n\n");
  const pr = probes.map((p) => `${p.id} — ${p.what}\n${cut(p.output, PROBE_PROMPT_CHARS)}`).join("\n\n");
  const text = [
    `FINDING (class as submitted and gated: ${v.cls})`,
    `Title: ${f.title}`,
    f.location?.file ? `Location: ${f.location.file}${f.location.symbol ? ` › ${f.location.symbol}` : ""}${f.location.line ? ` line ${f.location.line}` : ""}` : "",
    `Claim: ${f.claim}`,
    f.failure_scenario ? `Failure scenario: ${f.failure_scenario}` : "",
    `Impact: ${f.impact}`,
    `Author says they checked: ${f.what_checked_to_disprove || "(nothing stated)"}`,
    `Proposed change: ${f.proposed_change}`,
    "",
    "AUTHENTICATED EVIDENCE (from the author's run; proven genuine, but the author's conclusion is not):",
    ev || "(none)",
    "",
    "VERIFIER'S OWN FRESH TOOL OUTPUT (same pinned commit):",
    pr || "(no code probes: data-only finding)",
  ].filter((l) => l !== "").join("\n");
  return cut(text, PROMPT_CHARS);
}

// ---- entry point ----
export async function verifyFinding(v: VerifyInput, ledger: EvidenceLedger, rt: VerifierRuntime): Promise<VerificationResult> {
  const base = { from: v.cls, probes: [] as ProbeSummary[], supporting: [] as string[], contradicting: [] as string[], modelCalls: 0, toolCalls: 0 };
  if (v.cls === "product_idea") {
    // Ideas make no defect claim; they are never verified into anything, only kept as ideas.
    return { ...base, verdict: "SURVIVES", reason: "idea_not_verified_as_defect", to: "product_idea", failed: false, hard: false, stage: "skipped" };
  }
  let det: Deterministic | undefined;
  // Code probes only at the run's pinned commit, and only the one the evidence came from.
  const runner = rt.tools && rt.commit && rt.commit === ledger.commit ? new ProbeRunner(rt, rt.tools, rt.commit) : undefined;
  const summary = () => ({ probes: runner?.probes.map((p) => ({ id: p.id, what: p.what })) ?? [], toolCalls: runner?.toolCalls ?? 0 });
  const fail = (reason: VerifyReason, modelCalls = 0, provider?: string): VerificationResult => ({ ...base, ...summary(), verdict: "REJECT", reason, to: null, failed: true, hard: false, stage: det ? "model" : "deterministic", modelCalls, ...(provider ? { provider } : {}) });

  try {
    det = await deterministicStage(v, ledger, runner);
  } catch (e) {
    if (e instanceof VerifyFail) return { ...fail(e.reason), stage: "deterministic" };
    return { ...fail("tool_failed"), stage: "deterministic" };
  }
  if (det.cap === null) {
    return { ...base, ...summary(), verdict: "REJECT", reason: det.reason ?? "contradicted", to: null, failed: false, hard: det.hard, stage: "deterministic", contradicting: det.contradicting };
  }

  // One bounded model call.
  if (rt.budget.modelCalls >= rt.budget.maxModelCalls) return fail("budget_exhausted");
  rt.budget.modelCalls++;
  const probes = runner?.probes ?? [];
  const ids = new Set([...v.evidence.map((e) => `E${e.index}`), ...probes.map((p) => p.id)]);
  let res: { text: string; provider: string; model: string };
  try {
    res = await withTimeout(
      rt.model.generate({ system: SYSTEM, messages: [{ role: "user", content: buildPrompt(v, probes) }], json: { schema: SCHEMA }, maxOutputTokens: VERIFIER_MAX_OUTPUT_TOKENS, temperature: 0 }),
      VERIFIER_MODEL_TIMEOUT_MS,
      "timeout",
    );
  } catch (e) {
    return fail(e instanceof VerifyFail ? e.reason : "model_failed", 1);
  }
  const provider = `${res.provider}/${res.model}`;
  const m = parseVerifierOutput(res.text ?? "", ids, v.cls);
  if (!m) return fail("malformed_output", 1, provider);

  const common = { ...base, ...summary(), stage: "model" as const, modelCalls: 1, provider, supporting: m.supporting, contradicting: [...det.contradicting, ...m.contradicting] };
  if (m.verdict === "REJECT") return { ...common, verdict: "REJECT", reason: m.reason, to: null, failed: false, hard: false };
  // Keep or weaken only, then apply the deterministic cap.
  const modelClass = m.verdict === "DOWNGRADE" ? m.downgradeTo! : v.cls;
  const to = minClass(modelClass, det.cap);
  if (to === v.cls) return { ...common, verdict: "SURVIVES", reason: "supported", to, failed: false, hard: false };
  const reason: VerifyReason = m.verdict === "DOWNGRADE" ? m.reason : det.reason ?? "overstated";
  return { ...common, verdict: "DOWNGRADE", reason, to, failed: false, hard: false };
}
