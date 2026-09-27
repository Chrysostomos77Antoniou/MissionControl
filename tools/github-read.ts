// Read the FootRank GitHub repo so technical agents can give file-level advice.
//
// listRepo / readRepoFile are unchanged and still used by the fix agent
// (agents/fix-agent.ts), which submits WHOLE files and must keep seeing raw,
// un-numbered content. Suggestion agents use readRepoFileLines (below):
// numbered lines, an explicit range, the total line count and the exact
// commit read — so evidence can be quoted with correct line numbers.
import { redactSecrets } from "../lib/redact";
const API = "https://api.github.com";

function repoEnv() {
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  return { repo, token };
}

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "footrank-mission-control",
  };
}

export async function listRepo(path: string): Promise<string> {
  const { repo, token } = repoEnv();
  if (!repo || !token) return "GITHUB_REPO / GITHUB_TOKEN not set — cannot read the codebase.";
  const clean = path.replace(/^\/+/, "");
  const res = await fetch(`${API}/repos/${repo}/contents/${clean}`, { headers: headers(token) });
  if (!res.ok) return `GitHub ${res.status}: ${(await res.text()).slice(0, 150)}`;
  const data = (await res.json()) as { name: string; type: string; path: string }[] | { type: string };
  if (!Array.isArray(data)) return `"${clean}" is a file, not a directory. Use read_repo_file.`;
  return data.map((e) => `${e.type === "dir" ? "[dir] " : "      "}${e.path}`).join("\n") || "(empty)";
}

export async function readRepoFile(path: string): Promise<string> {
  const { repo, token } = repoEnv();
  if (!repo || !token) return "GITHUB_REPO / GITHUB_TOKEN not set — cannot read the codebase.";
  const clean = path.replace(/^\/+/, "");
  const res = await fetch(`${API}/repos/${repo}/contents/${clean}`, { headers: headers(token) });
  if (!res.ok) return `GitHub ${res.status}: ${(await res.text()).slice(0, 150)}`;
  const data = (await res.json()) as { content?: string; encoding?: string; type?: string };
  if (data.type !== "file" || !data.content) return `"${clean}" is not a readable file.`;
  const decoded = Buffer.from(data.content, "base64").toString("utf-8");
  // Cap to keep token usage sane on large files.
  return decoded.length > 12000 ? decoded.slice(0, 12000) + "\n…(truncated)" : decoded;
}

// ---- numbered, ranged reads (suggestion agents) ----------------------------

export const READ_DEFAULT_LINES = 250; // when no end_line is given
export const READ_MAX_LINES = 400; // hard cap per call
export const READ_MAX_CHARS = 16_000; // hard cap per call (long lines)
const MAX_LINE_CHARS = 1_000;

// Files that never hold code worth quoting and may hold credentials.
const DENIED_FILE = [
  /(^|\/)\.env(\.[^/]*)?$/i,
  /\.(jks|keystore|p12|pfx|pem|key)$/i,
  /(^|\/)key\.properties$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/i,
];

// A repository-relative path: no traversal, no absolute paths, no URL or
// git-pathspec syntax. Shared with tools/code-search.ts.
export function validateRepoPath(p: unknown, opts: { allowEmpty?: boolean } = {}): { ok: true; path: string } | { ok: false; reason: string } {
  if (typeof p !== "string") return { ok: false, reason: "path must be a string" };
  const path = p.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!path) return opts.allowEmpty ? { ok: true, path: "" } : { ok: false, reason: "path is required" };
  if (path.length > 300) return { ok: false, reason: "path is too long" };
  if (/[\u0000-\u001f\u007f]/.test(path)) return { ok: false, reason: "path contains control characters" };
  if (path.includes("\\")) return { ok: false, reason: "use forward slashes" };
  if (/^[A-Za-z]:/.test(path)) return { ok: false, reason: "absolute paths are not allowed" };
  for (const seg of path.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return { ok: false, reason: "path traversal is not allowed" };
    if (!/^[A-Za-z0-9._@+ -]+$/.test(seg)) return { ok: false, reason: `unsupported character in "${seg.slice(0, 40)}"` };
  }
  if (DENIED_FILE.some((r) => r.test(path))) return { ok: false, reason: "this file may contain credentials and is not readable by agents" };
  return { ok: true, path };
}

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop(); // trailing newline ends the last line
  return lines;
}

const asInt = (v: unknown): number | undefined | null => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) ? n : null; // null = present but invalid
};

// Pure: renders an exact, numbered window of a file. Line numbers always come
// from the file itself, never from the caller.
export function formatNumberedWindow(path: string, commit: string, text: string, startLine?: unknown, endLine?: unknown): string {
  const lines = splitLines(text);
  const total = lines.length;
  const s0 = asInt(startLine);
  const e0 = asInt(endLine);
  if (s0 === null || (s0 !== undefined && s0 < 1)) return `start_line must be a whole number >= 1. ${path} has ${total} lines.`;
  if (e0 === null || (e0 !== undefined && e0 < 1)) return `end_line must be a whole number >= 1. ${path} has ${total} lines.`;
  const start = s0 ?? 1;
  const requestedEnd = e0 ?? start + READ_DEFAULT_LINES - 1;
  if (requestedEnd < start) return `end_line (${requestedEnd}) is before start_line (${start}). ${path} has ${total} lines.`;
  const header = `${path}\ncommit: ${commit}`;
  if (total === 0) return `${header}\n(empty file: 0 lines)`;
  if (start > total) return `${header}\nrequested lines ${start}-${requestedEnd}, but the file has only ${total} lines — nothing to show.`;

  const cappedEnd = Math.min(requestedEnd, start + READ_MAX_LINES - 1, total);
  const width = String(cappedEnd).length;
  const out: string[] = [];
  let chars = 0;
  let last = start - 1;
  for (let n = start; n <= cappedEnd; n++) {
    let body = redactSecrets(lines[n - 1]);
    if (body.length > MAX_LINE_CHARS) body = `${body.slice(0, MAX_LINE_CHARS)} …(line truncated)`;
    const row = `${String(n).padStart(width, " ")}| ${body}`;
    if (out.length > 0 && chars + row.length + 1 > READ_MAX_CHARS) break;
    out.push(row);
    chars += row.length + 1;
    last = n;
  }

  const notes: string[] = [];
  if (requestedEnd > total && e0 !== undefined) notes.push(`requested up to line ${requestedEnd}; the file ends at line ${total}`);
  if (last < Math.min(requestedEnd, total)) notes.push(`output capped at line ${last}`);
  if (last < total) notes.push(`more below — call again with start_line=${last + 1}`);
  return `${header}\nlines ${start}-${last} of ${total}${notes.length ? ` (${notes.join("; ")})` : ""}\n\n${out.join("\n")}`;
}

export const isCommitSha = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{40}$/.test(s);

// Resolves the FootRank default branch's current commit on GitHub. Called ONCE
// per agent run (agents/run-agent.ts); both code tools then use that pinned
// commit for the whole run, so every piece of code evidence in one run comes
// from the same source version.
export async function resolveFootRankCommit(): Promise<{ ok: true; sha: string } | { ok: false; reason: string }> {
  const { repo, token } = repoEnv();
  if (!repo || !token) return { ok: false, reason: "GITHUB_REPO / GITHUB_TOKEN not set" };
  try {
    const head = await fetch(`${API}/repos/${repo}/commits/HEAD`, { headers: { ...headers(token), Accept: "application/vnd.github.sha" } });
    if (!head.ok) return { ok: false, reason: `GitHub ${head.status} while resolving the current commit` };
    const sha = (await head.text()).trim();
    if (!isCommitSha(sha)) return { ok: false, reason: "GitHub returned an unexpected commit id" };
    return { ok: true, sha };
  } catch {
    return { ok: false, reason: "network error while resolving the current commit" };
  }
}

// Numbered read of one file AT the run's pinned commit. Never resolves HEAD
// itself: without a valid pinned commit it reads nothing.
export async function readRepoFileLines(path: unknown, startLine: unknown, endLine: unknown, commit: unknown): Promise<string> {
  const { repo, token } = repoEnv();
  if (!repo || !token) return "GITHUB_REPO / GITHUB_TOKEN not set — cannot read the codebase.";
  if (!isCommitSha(commit)) return "No valid pinned FootRank commit for this run — nothing was read.";
  const v = validateRepoPath(path);
  if (!v.ok) return `Rejected: ${v.reason}. Nothing was read.`;
  const encoded = v.path.split("/").map(encodeURIComponent).join("/");
  try {
    const res = await fetch(`${API}/repos/${repo}/contents/${encoded}?ref=${commit}`, { headers: headers(token) });
    if (res.status === 404) return `Not found: ${v.path} does not exist at commit ${commit}. Use search_code or list_repo to locate it.`;
    if (!res.ok) return `GitHub ${res.status}: could not read ${v.path}.`;
    const data = (await res.json()) as { type?: string; content?: string; encoding?: string; size?: number } | unknown[];
    if (Array.isArray(data)) return `"${v.path}" is a directory, not a file. Use list_repo.`;
    if (data.type !== "file") return `"${v.path}" is not a regular file.`;
    if (data.encoding !== "base64" || typeof data.content !== "string") {
      return `"${v.path}" is too large to read through the GitHub API (${data.size ?? "?"} bytes). Use search_code to find the relevant lines.`;
    }
    const text = Buffer.from(data.content, "base64").toString("utf-8");
    if (text.includes("\u0000")) return `"${v.path}" is a binary file.`;
    return formatNumberedWindow(v.path, commit, text, startLine, endLine);
  } catch {
    return `Could not read ${v.path} (network error). Nothing was read.`;
  }
}
