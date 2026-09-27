// Run-bound evidence ledger (7b).
//
// Every successful read-only tool result in an investigation run is recorded
// here by the LOOP (never by the model): the tool name, the exact input the
// loop dispatched, the exact output text and, for code tools, the run's pinned
// FootRank commit. Each record gets an unguessable reference ("ev3-1a2b3c")
// derived from a per-run secret, and an HMAC seal over
// [runId, ref, tool, commit, sha256(output)].
//
// The model only ever cites refs. The finding gate (lib/finding-gate.ts)
// looks a ref up in THIS run's ledger object, re-verifies the seal, and
// matches the cited excerpt and line numbers against the recorded output. A
// ref from another run does not exist here (and could not be forged without
// this run's secret, which never leaves the process), so evidence can only
// come from tool results of the current run.
//
// Pure apart from crypto randomness: no I/O, no network, no writes.

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

// Tools whose results may be cited as evidence. list_repo is deliberately
// excluded: it is not pinned to the run's commit.
export const EVIDENCE_TOOLS: ReadonlySet<string> = new Set(["read_repo_file", "search_code", "db_read", "read_footrank_stats", "web_search"]);
export const CODE_EVIDENCE_TOOLS: ReadonlySet<string> = new Set(["read_repo_file", "search_code"]);

export interface ReadWindow {
  path: string;
  commit: string;
  start: number;
  end: number;
  total: number;
  lines: Map<number, string>; // line number (from the tool output) -> text
}

export interface SearchHit {
  file: string;
  line: number;
  text: string;
}

export interface SearchResult {
  query: string;
  scope: string; // "" = whole repository
  commit: string;
  hits: SearchHit[];
  noMatches: boolean;
  complete: boolean; // false when some matches were not shown
}

export interface EvidenceRecord {
  ref: string;
  seq: number;
  tool: string;
  input: Record<string, unknown>;
  output: string;
  outputSha256: string;
  commit?: string;
  read?: ReadWindow;
  search?: SearchResult;
  seal: string;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

// Tool results that are refusals or errors are never evidence.
const ERROR_OUTPUT = /^(Rejected|Not found|No valid pinned|No pinned|GitHub \d|GITHUB_|Could not|DB read error|Query rejected|SUPABASE_|Unknown tool|Tool error|Not executed|start_line|end_line|"[^"]*" is (a directory|not a regular file|too large|a binary file))/;

const READ_ROW = /^\s*(\d+)\| ?(.*)$/;
const SEARCH_ROW = /^([A-Za-z0-9._@+ /-]+):(\d+): ?(.*)$/;

// Parses read_repo_file's numbered window (tools/github-read.ts formatNumberedWindow).
export function parseReadWindow(output: string): ReadWindow | null {
  const rows = output.replace(/\r\n/g, "\n").split("\n");
  if (rows.length < 5) return null;
  const path = rows[0].trim();
  const c = /^commit: ([0-9a-f]{40})$/.exec(rows[1] ?? "");
  const r = /^lines (\d+)-(\d+) of (\d+)/.exec(rows[2] ?? "");
  if (!path || !c || !r || rows[3] !== "") return null;
  const lines = new Map<number, string>();
  for (const row of rows.slice(4)) {
    const m = READ_ROW.exec(row);
    if (!m) return null;
    lines.set(Number(m[1]), m[2]);
  }
  const start = Number(r[1]);
  const end = Number(r[2]);
  if (!lines.size || !lines.has(start) || !lines.has(end)) return null;
  return { path, commit: c[1], start, end, total: Number(r[3]), lines };
}

// Parses search_code's output (tools/code-search.ts searchCode).
export function parseSearchResult(output: string): SearchResult | null {
  const rows = output.replace(/\r\n/g, "\n").split("\n");
  const h = /^search_code ("(?:[^"\\]|\\.)*")(?: in (.+))?$/.exec(rows[0] ?? "");
  const repo = /^repo: \S+ @ ([0-9a-f]{40}) /.exec(rows[1] ?? "");
  if (!h || !repo) return null;
  let query: string;
  try {
    query = JSON.parse(h[1]) as string;
  } catch {
    return null;
  }
  const base = { query, scope: h[2] ?? "", commit: repo[1] };
  if (/\n\nNo matches\.$/.test(output.replace(/\r\n/g, "\n"))) return { ...base, hits: [], noMatches: true, complete: true };
  if (!/^\d+ match\(es\) in \d+ file\(s\)/.test(rows[2] ?? "")) return null; // e.g. "Search failed"
  const hits: SearchHit[] = [];
  for (const row of rows.slice(3)) {
    const m = SEARCH_ROW.exec(row);
    if (m) hits.push({ file: m[1], line: Number(m[2]), text: m[3] });
  }
  if (!hits.length) return null;
  return { ...base, hits, noMatches: false, complete: !/ more match\(es\) not shown/.test(output) };
}

export class EvidenceLedger {
  readonly runId: string;
  readonly commit: string | undefined;
  private readonly secret: Buffer;
  private readonly records = new Map<string, EvidenceRecord>();
  private seq = 0;

  constructor(opts: { commit?: string } = {}) {
    this.runId = randomUUID();
    this.secret = randomBytes(32);
    this.commit = opts.commit && /^[0-9a-f]{40}$/.test(opts.commit) ? opts.commit : undefined;
  }

  private mac(parts: unknown[]): string {
    return createHmac("sha256", this.secret).update(JSON.stringify(parts)).digest("hex");
  }

  // Records one successful tool result; returns its ref, or null when the
  // result cannot serve as evidence (error, unparseable, wrong/missing pin).
  record(tool: string, input: Record<string, unknown>, output: string): string | null {
    if (!EVIDENCE_TOOLS.has(tool) || typeof output !== "string" || !output.trim() || ERROR_OUTPUT.test(output.trim())) return null;
    let read: ReadWindow | undefined;
    let search: SearchResult | undefined;
    let commit: string | undefined;
    if (tool === "read_repo_file") {
      const w = parseReadWindow(output);
      if (!w || !this.commit || w.commit !== this.commit) return null;
      read = w;
      commit = w.commit;
    } else if (tool === "search_code") {
      const s = parseSearchResult(output);
      if (!s || !this.commit || s.commit !== this.commit) return null;
      search = s;
      commit = s.commit;
    }
    const seq = ++this.seq;
    const outputSha256 = sha256(output);
    const ref = `ev${seq}-${this.mac([this.runId, "ref", seq, outputSha256]).slice(0, 6)}`;
    const seal = this.mac([this.runId, ref, tool, commit ?? "", outputSha256]);
    this.records.set(ref, { ref, seq, tool, input: { ...input }, output, outputSha256, ...(commit ? { commit } : {}), ...(read ? { read } : {}), ...(search ? { search } : {}), seal });
    return ref;
  }

  // Returns the record only if it exists in THIS run and its seal still
  // verifies (output, tool, commit unchanged since it was recorded).
  get(ref: unknown): EvidenceRecord | undefined {
    if (typeof ref !== "string") return undefined;
    const rec = this.records.get(ref.trim());
    if (!rec) return undefined;
    const expect = Buffer.from(this.mac([this.runId, rec.ref, rec.tool, rec.commit ?? "", sha256(rec.output)]), "hex");
    const got = Buffer.from(rec.seal, "hex");
    return expect.length === got.length && timingSafeEqual(expect, got) ? rec : undefined;
  }

  all(): EvidenceRecord[] {
    return [...this.records.values()].filter((r) => this.get(r.ref));
  }
}

// Appended to a recorded tool result so the model can cite it.
export function evidenceRefNote(ref: string): string {
  return `[evidence ref: ${ref} — cite this ref with an excerpt copied exactly from the text above; line numbers come only from this output]`;
}
