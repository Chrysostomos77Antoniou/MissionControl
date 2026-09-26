// Deterministic numeric-claim guard (reliability, pre-commit-6).
//
// Stops unsupported quantitative claims from silently becoming trusted-looking
// suggestions or agent memory. Pure string/number logic — no LLM, no network,
// no I/O.
//
// A numeric claim in model text is VERIFIED when its value
//   1. appears in this cycle's factual material (tool results, the agent's
//      input message, its system prompt), or
//   2. for percentages / non-integer ratios only: equals a/b (a ≤ b for
//      percentages) where a and b both come from this cycle's TOOL RESULTS,
//      within the rounding precision the claim is written with.
// Integers, currency amounts and dates are never "derived" — they must appear
// literally, because sums/differences over many numbers would "verify" almost
// anything.
//
// Deliberately NOT treated as claims (to avoid false positives):
//   identifiers & versions (qwen3.5:4b, gemini-3.8-flash, v2, 1.2.3, file.ts:42),
//   anything inside `code spans`, full timestamps, bare years, list markers,
//   and numbers in clearly hypothetical clauses (if / e.g. / target / expected /
//   would / could / threshold …) or after <, >, ≤, ≥, ~.
//
// Anything already marked "[unverified]" never counts as support, so an
// invented figure can't launder itself through memory or earlier titles.

export const UNVERIFIED_MARK = "[unverified]";

export type ClaimKind = "number" | "percent" | "currency" | "date";

export interface NumericClaim {
  raw: string; // the text as written, e.g. "6%", "€1,200", "2026-09-01"
  value: number; // numeric value (dates: yyyymmdd)
  decimals: number;
  kind: ClaimKind;
  unit: string; // "" for bare numbers; e.g. "ms", "minutes", "%"
  index: number; // position in the input text
}

export interface ClaimMaterial {
  data: string[]; // this cycle's tool results (may be used for derivations)
  context: string[]; // input message + system prompt (exact matches only)
}

export interface ClaimCheck {
  claims: NumericClaim[];
  unverified: NumericClaim[];
}

const UNIT = String.raw`(?:%|\s?percent\b|\s?pp\b|k\b|m\b|bn\b|\s?ms\b|\s?s\b|\s?secs?\b|\s?seconds?\b|\s?mins?\b|\s?minutes?\b|\s?h\b|\s?hrs?\b|\s?hours?\b|\s?days?\b|d\b|\s?weeks?\b|\s?months?\b|\s?MB\b|\s?GB\b|\s?KB\b|x\b|×|\s?EUR\b|\s?USD\b|\s?euros?\b|\s?dollars?\b|€)`;
const NUM_RE = new RegExp(String.raw`([€$£]\s?)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(${UNIT})?`, "gi");
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})((?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(?:Z|[+-]\d{2}:?\d{2})?)?(?![\d-])/g;
const HYPOTHETICAL = /\b(if|e\.g\.|eg|for example|for instance|example|such as|target(?:ing|s|ed)?|goal|aim(?:ing)?|threshold|benchmark|hypothes\w*|expect\w*|project(?:ed|ion)s?|estimat\w*|forecast\w*|predict\w*|would|could|might|may|assum\w*|suppose|scenario|potential(?:ly)?|up to|at least|at most|aspire|ideally|should reach|lift of)\b/i;

function mask(text: string): string {
  // Same length as input, so indices stay valid.
  return text
    .replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length)) // code spans
    .replace(/\b(e\.g\.|i\.e\.|vs\.|etc\.|approx\.|no\.)/gi, (m) => m.replace(/\./g, "_"));
}

function clauseAround(masked: string, index: number): string {
  const isBoundary = (i: number) => {
    const c = masked[i];
    if (c === "\n" || c === ";" || c === "!" || c === "?") return true;
    if (c === ".") return !/\d/.test(masked[i - 1] ?? "") || !/\d/.test(masked[i + 1] ?? "");
    return false;
  };
  let s = index;
  while (s > 0 && !isBoundary(s - 1)) s--;
  let e = index;
  while (e < masked.length && !isBoundary(e)) e++;
  return masked.slice(s, e).replace(/_/g, ".");
}

function kindOf(prefix: string | undefined, unit: string | undefined): ClaimKind {
  const u = (unit ?? "").trim().toLowerCase();
  if (prefix || ["€", "eur", "usd", "euro", "euros", "dollar", "dollars"].includes(u)) return "currency";
  if (u === "%" || u === "percent") return "percent";
  return "number";
}

function scale(unit: string | undefined): number {
  const u = (unit ?? "").trim().toLowerCase();
  return u === "k" ? 1e3 : u === "m" ? 1e6 : u === "bn" ? 1e9 : 1;
}

export function extractClaims(text: string): NumericClaim[] {
  const src = String(text ?? "");
  let masked = mask(src);
  const claims: NumericClaim[] = [];

  // Dates first; full timestamps are metadata (skipped). Blank them either way.
  masked = masked.replace(ISO_DATE_RE, (m, y, mo, d, time, offset: number) => {
    if (!time && !isHypothetical(masked, offset, "")) claims.push({ raw: m, value: Number(`${y}${mo}${d}`), decimals: 0, kind: "date", unit: "", index: offset });
    return " ".repeat(m.length);
  });

  for (const m of masked.matchAll(NUM_RE)) {
    const idx = m.index!;
    const [raw, cur, intPart, frac, unit] = m;
    const start = cur ? idx : idx + (raw.length - raw.trimStart().length);
    const before = masked[start - 1] ?? "";
    const before2 = masked[start - 2] ?? "";
    const end = idx + raw.length;
    const after = masked[end] ?? "";
    const after2 = masked[end + 1] ?? "";

    // Part of an identifier / version / path / id?
    if (/[A-Za-z_]/.test(before)) continue;
    if (/[.\-:/#@]/.test(before) && /[A-Za-z0-9_]/.test(before2)) continue;
    if (/[A-Za-z_]/.test(after) && !unit) continue;
    if (/[.:\-/]/.test(after) && /[A-Za-z0-9]/.test(after2)) continue;
    if (/[A-Za-z0-9_]/.test(after)) continue;
    // List markers ("1. ", "2) ") at line start.
    const lineStart = masked.lastIndexOf("\n", start - 1) + 1;
    if (/^\s*$/.test(masked.slice(lineStart, start)) && /^[.)]\s/.test(masked.slice(end, end + 2)) && !unit) continue;
    const value = Number(intPart.replace(/,/g, "") + (frac ?? "")) * scale(unit);
    // Bare years.
    if (!unit && !cur && !frac && /^(19|20)\d{2}$/.test(intPart)) continue;
    // Labels, not quantities: "Phase 1", "Step 2", "Task 5", "commit 6", "#3".
    if (!unit && !cur && LABEL_BEFORE.test(masked.slice(Math.max(0, start - 16), start))) continue;
    if (isHypothetical(masked, start, masked.slice(Math.max(0, start - 3), start))) continue;
    claims.push({ raw: src.slice(start, end).trim(), value, decimals: frac ? frac.length - 1 : 0, kind: kindOf(cur, unit), unit: (unit ?? "").trim().toLowerCase(), index: start });
  }
  // Already-marked figures are known-unverified, not new claims.
  return claims
    .filter((c) => !src.slice(c.index + c.raw.length, c.index + c.raw.length + UNVERIFIED_MARK.length + 1).includes(UNVERIFIED_MARK))
    .sort((a, b) => a.index - b.index);
}

const LABEL_BEFORE = /\b(phase|step|task|commit|version|tier|level|stage|part|section|chapter|round|option|item|line|row|column|page|test|case|point|priority|no\.?|number)\s*$|#\s*$/i;

function isHypothetical(masked: string, index: number, justBefore: string): boolean {
  if (/[<>≤≥~]\s*[€$£]?$/.test(justBefore)) return true;
  return HYPOTHETICAL.test(clauseAround(masked, index));
}

interface MaterialNumber {
  value: number;
  percent: boolean; // written as a percentage in the material
}

// Every number in the material, except ones already marked [unverified].
function materialNumbers(texts: string[]): MaterialNumber[] {
  const out: MaterialNumber[] = [];
  for (const t of texts) {
    const s = String(t ?? "");
    for (const m of s.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\s?%)?/g)) {
      const tail = s.slice(m.index! + m[0].length, m.index! + m[0].length + 20);
      if (/^\s*%?\s*\[unverified\]/.test(tail)) continue;
      out.push({ value: Number(m[1].replace(/,/g, "") + (m[2] ?? "")), percent: !!m[3] });
    }
    for (const d of s.matchAll(/\b(\d{4})-(\d{2})-(\d{2})/g)) out.push({ value: Number(`${d[1]}${d[2]}${d[3]}`), percent: false });
  }
  return out;
}

const tolerance = (c: NumericClaim) => Math.max(0.5 * 10 ** -c.decimals, 1e-9);

export function checkClaims(text: string, material: ClaimMaterial): ClaimCheck {
  const claims = extractClaims(text);
  if (!claims.length) return { claims, unverified: [] };
  const all = materialNumbers([...material.data, ...material.context]);
  const data = [...new Set(materialNumbers(material.data).filter((n) => !n.percent).map((n) => n.value))].filter((n) => Number.isFinite(n) && n >= 0).slice(0, 400);

  const exact = (c: NumericClaim) => {
    const tol = c.kind === "date" || c.kind === "currency" ? 1e-9 : tolerance(c);
    for (const n of all) {
      if (c.kind === "percent") {
        // A percentage is supported by a written percentage or a 0..1 fraction —
        // never by a plain count that happens to share the digits ("6 teams" ≠ "6%").
        if (n.percent && Math.abs(n.value - c.value) <= tol) return true;
        if (!n.percent && n.value > 0 && n.value < 1 && Math.abs(n.value * 100 - c.value) <= tol) return true;
      } else if (Math.abs(n.value - c.value) <= tol) return true;
    }
    return false;
  };
  const derived = (c: NumericClaim) => {
    if (c.kind === "percent") {
      for (const b of data) if (b > 0) for (const a of data) if (a <= b && Math.abs((100 * a) / b - c.value) <= tolerance(c)) return true;
    } else if (c.kind === "number" && c.decimals > 0 && !c.unit) {
      // Plain ratios only (e.g. "3.17 users per team" = 19/6); measurements
      // with units ("3.5 minutes") must appear literally.
      for (const b of data) if (b > 0) for (const a of data) if (Math.abs(a / b - c.value) <= tolerance(c)) return true;
    }
    return false;
  };
  const unverified = claims.filter((c) => !exact(c) && !derived(c));
  return { claims, unverified };
}

function uniqueRaw(claims: NumericClaim[]): string[] {
  return [...new Set(claims.map((c) => c.raw))].slice(0, 10);
}

export function unverifiedNote(unverified: NumericClaim[]): string {
  return unverified.length ? `⚠ Unverified figures (not found in or derivable from this cycle's data): ${uniqueRaw(unverified).join(", ")}` : "";
}

// Inserts "[unverified]" right after each unverified figure.
export function markInline(text: string, unverified: NumericClaim[]): string {
  let out = String(text ?? "");
  for (const c of [...unverified].sort((a, b) => b.index - a.index)) {
    const end = c.index + c.raw.length;
    out = `${out.slice(0, end)} ${UNVERIFIED_MARK}${out.slice(end)}`;
  }
  return out;
}

export interface GuardedSuggestion {
  title: string;
  body: string;
  evidence: string;
  footer: string; // appended to the saved body: unverified note (if any) + provenance
  unverified: string[];
}

// For save_suggestion: marks unverified figures inline in title/body/evidence
// and builds the footer. `generatedBy` is "<provider>/<model>" from the LLM result.
export function guardSuggestion(
  s: { title: string; body: string; evidence: string },
  material: ClaimMaterial,
  generatedBy: string,
): GuardedSuggestion {
  const t = checkClaims(s.title, material);
  const b = checkClaims(s.body, material);
  const e = checkClaims(s.evidence, material);
  const unverified = [...t.unverified, ...b.unverified, ...e.unverified];
  const footer = [unverifiedNote(unverified), `Generated by ${generatedBy}`].filter(Boolean).join("\n");
  return {
    title: markInline(s.title, t.unverified),
    body: markInline(s.body, b.unverified),
    evidence: markInline(s.evidence, e.unverified),
    footer,
    unverified: uniqueRaw(unverified),
  };
}

// For agent memory: returns the summary unchanged when every figure is
// verified; otherwise marks each unverified figure inline and prefixes a short
// warning so the next cycle can't treat them as established facts.
export function guardSummary(summary: string, material: ClaimMaterial): { text: string; unverified: string[] } {
  const { unverified } = checkClaims(summary, material);
  if (!unverified.length) return { text: summary, unverified: [] };
  return { text: `[⚠ figures marked ${UNVERIFIED_MARK} were not in this cycle's data] ${markInline(summary, unverified)}`, unverified: uniqueRaw(unverified) };
}
