// Deterministic finding fingerprints and duplicate detection (7b).
//
// A fingerprint is built from stable facts, never from the title alone:
//   - family: "defect" (verified_bug / plausible_risk) or "idea"
//   - files: basenames of the location file and every code-evidence file
//   - symbol: the location's function/class (bare name)
//   - anchors: "file:line" pairs whose line numbers came from tool output
//   - terms: normalised key terms from the title and claim
//   - fp: sha256(family | location file | symbol), the exact location key
//
// Duplicate rules (no LLM, fixed thresholds):
//   A. same fp (location + symbol)          and term overlap >= 0.25
//   B. at least one shared evidence anchor  and term overlap >= 0.20
//   C. at least one shared file             and term overlap >= 0.45
//   D. no files on one side                 and term overlap >= 0.60 (>= 4 terms each)
// "term overlap" is |A ∩ B| / min(|A|, |B|). Families never match each other.
//
// Stored suggestions carry their fingerprint in a one-line footer so later
// runs compare exact anchors; older suggestions without one are fingerprinted
// from their title/body text (files, file:line mentions, terms).
//
// Pure: no I/O.

import { createHash } from "node:crypto";
import type { FindingClass, FindingInput, ValidatedEvidence } from "./finding-gate";
import { bareSymbol } from "./finding-gate";

export type Family = "defect" | "idea";

export interface FindingPrint {
  family: Family;
  cls?: FindingClass;
  fp: string | null; // null when there is no location + symbol
  symbol: string;
  files: string[];
  anchors: string[];
  terms: string[];
}

export const familyOf = (c: FindingClass): Family => (c === "product_idea" ? "idea" : "defect");
const basename = (p: string) => p.split("/").pop() ?? p;
const uniqSorted = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort();

const STOP = new Set(
  (
    "the and for with that this from are was were will when then than into onto has have had not but all any can could should would may might its their they them there here which what who how why also only just more most less very each every after before over under about because while does did doing done been being use used using make makes made new add added adds fix fixed fixes update updated updates instead currently current user app page screen code file line show shown display value issue problem bug risk idea finding change dart lib presentation data widget model repository string null true false final const return static int async await future list verified plausible product " +
    "match team player via per our your you one two get set see seen still yet already such like need needs needed say says tell tells"
  ).split(/\s+/),
);

function stem(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 4 && /(ch|sh|ss|x)es$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

// Normalised key terms: identifiers kept whole and split at camelCase/_,
// stop words and numbers dropped (figures never enter the stored footer, so
// the claim guard's marking can't be bypassed through it).
export function keyTerms(text: string): string[] {
  const out = new Set<string>();
  const cleaned = text.replace(/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[a-z]+(?::\d+(?:-\d+)?)?/g, " ");
  for (const tok of cleaned.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    const whole = stem(tok.toLowerCase());
    const add = (t: string) => {
      if (t.length >= 3 && !STOP.has(t) && !/\d/.test(t)) out.add(t);
    };
    add(whole);
    const parts = tok.split(/_|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
    if (parts.length > 1) for (const p of parts) add(stem(p.toLowerCase()));
  }
  return [...out].sort();
}

const hash = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

export function fingerprintFinding(f: Pick<FindingInput, "class" | "title" | "claim" | "location">, evidence: ValidatedEvidence[]): FindingPrint {
  const family = familyOf(f.class);
  const symbol = f.location?.symbol ? bareSymbol(f.location.symbol) : "";
  const file = f.location?.file ?? "";
  const anchors: string[] = [];
  for (const e of evidence) {
    if (!e.code || !e.file || e.startLine === undefined) continue;
    for (let n = e.startLine; n <= (e.endLine ?? e.startLine) && n < e.startLine + 5; n++) anchors.push(`${basename(e.file)}:${n}`);
  }
  return {
    family,
    cls: f.class,
    fp: file && symbol ? hash(`${family}|${file}|${symbol}`) : null,
    symbol,
    files: uniqSorted([file ? basename(file) : "", ...evidence.filter((e) => e.code && e.file).map((e) => basename(e.file!))]),
    anchors: uniqSorted(anchors),
    terms: keyTerms(`${f.title} ${f.claim}`),
  };
}

export interface DuplicateVerdict {
  duplicate: boolean;
  rule?: "A" | "B" | "C" | "D";
  reason?: string;
  overlap: number;
}

export function termOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const B = new Set(b);
  const shared = a.filter((t) => B.has(t)).length;
  return shared / Math.min(a.length, b.length);
}

export function compareFindings(a: FindingPrint, b: FindingPrint): DuplicateVerdict {
  const overlap = termOverlap(a.terms, b.terms);
  if (a.family !== b.family) return { duplicate: false, overlap };
  if (a.fp && a.fp === b.fp && overlap >= 0.25) return { duplicate: true, rule: "A", reason: `same location and symbol (${a.symbol})`, overlap };
  const anchors = a.anchors.filter((x) => b.anchors.includes(x));
  if (anchors.length && overlap >= 0.2) return { duplicate: true, rule: "B", reason: `same evidence line(s) ${anchors.slice(0, 3).join(", ")}`, overlap };
  const files = a.files.filter((x) => b.files.includes(x));
  if (files.length && overlap >= 0.45) return { duplicate: true, rule: "C", reason: `same file(s) ${files.slice(0, 3).join(", ")} and overlapping claim`, overlap };
  if ((!a.files.length || !b.files.length) && overlap >= 0.6 && Math.min(a.terms.length, b.terms.length) >= 4) return { duplicate: true, rule: "D", reason: "near-identical claim", overlap };
  return { duplicate: false, overlap };
}

// ---- storage format ----
const FOOTER = "Finding-Fingerprint:";

export function renderFingerprintFooter(p: FindingPrint): string {
  const f = (xs: string[], n: number) => xs.slice(0, n).join(",") || "-";
  return `${FOOTER} v1 fp=${p.fp ?? "-"} family=${p.family} class=${p.cls ?? "-"} symbol=${p.symbol || "-"} files=${f(p.files, 8)} anchors=${f(p.anchors, 12)} terms=${f(p.terms, 30)}`;
}

const TOKEN = /^[A-Za-z0-9_.:+-]+$/;
export function parseFingerprintFooter(body: string): FindingPrint | null {
  const line = body.split("\n").find((l) => l.startsWith(`${FOOTER} v1 `));
  if (!line) return null;
  const kv = new Map<string, string>();
  for (const part of line.slice(FOOTER.length).trim().split(/\s+/).slice(1)) {
    const i = part.indexOf("=");
    if (i > 0) kv.set(part.slice(0, i), part.slice(i + 1));
  }
  const list = (k: string) => (kv.get(k) && kv.get(k) !== "-" ? kv.get(k)!.split(",").filter((x) => TOKEN.test(x)) : []);
  const family = kv.get("family");
  if (family !== "defect" && family !== "idea") return null;
  const cls = kv.get("class") as FindingClass | undefined;
  const fp = kv.get("fp");
  return {
    family,
    ...(cls && cls !== ("-" as string) ? { cls } : {}),
    fp: fp && /^[0-9a-f]{16}$/.test(fp) ? fp : null,
    symbol: kv.get("symbol") && kv.get("symbol") !== "-" ? kv.get("symbol")! : "",
    files: list("files"),
    anchors: list("anchors"),
    terms: list("terms"),
  };
}

const CODE_PATH = /((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_-]+\.(?:dart|sql|ts|tsx|yaml|yml|json|gradle|kt|swift))(?:(?::|\s+lines?\s+)(\d+)(?:\s*-\s*(\d+))?)?/g;

// Fingerprint for a stored suggestion: its footer when present, otherwise a
// best-effort text fingerprint (older rows written before 7b).
export function fingerprintStored(row: { title: string; body: string; category?: string | null }): FindingPrint {
  const parsed = parseFingerprintFooter(row.body ?? "");
  if (parsed) return parsed;
  const text = `${row.title}\n${row.body ?? ""}`;
  const files: string[] = [];
  const anchors: string[] = [];
  for (const m of text.matchAll(CODE_PATH)) {
    const b = basename(m[1]);
    files.push(b);
    if (m[2]) {
      const s = Number(m[2]);
      const e = m[3] ? Number(m[3]) : s;
      for (let n = s; n <= e && n < s + 5; n++) anchors.push(`${b}:${n}`);
    }
  }
  const lead = (row.body ?? "").split(/\n\s*—\s*Evidence:|\n\s*Evidence:/)[0].slice(0, 600);
  const cat = (row.category ?? "").toLowerCase();
  const family: Family = /idea|growth|marketing|copy|feature|activation|content/.test(cat) ? "idea" : "defect";
  return { family, fp: null, symbol: "", files: uniqSorted(files), anchors: uniqSorted(anchors), terms: keyTerms(`${row.title} ${lead}`) };
}

// Anchors in `next` that `prev` did not have: genuinely new evidence lines.
export const newAnchors = (prev: FindingPrint, next: FindingPrint) => next.anchors.filter((a) => !prev.anchors.includes(a));
