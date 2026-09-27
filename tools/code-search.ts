// search_code: read-only search of the PUSHED FootRank code (Phase 7a).
//
// Source of truth: the local clone at FOOTRANK_PATH (same convention as
// app/api/install-app/route.ts), searched AT THE RUN'S PINNED COMMIT — the
// GitHub default-branch commit resolved once at agent-run start
// (agents/run-agent.ts), the same commit read_repo_file reads. The local
// origin/master is never consulted. If the clone does not contain the pinned
// commit the search fails closed (no automatic fetch: no network). The working
// tree (uncommitted local work) is never searched.
//
// Safety:
//   - git is run with execFile (no shell) and a FIXED argument list built
//     here; only the subcommands in ALLOWED_SUBCOMMANDS can ever run, all of
//     them read-only (no checkout/reset/fetch/branch/write).
//   - the query is passed after -e and matched as a fixed string (-F), so it
//     can never become an option, a regex or a shell command;
//   - the optional path is validated (no traversal/absolute/pathspec magic)
//     and passed as a :(literal) pathspec after "--";
//   - the clone must be a repository root whose origin is GITHUB_REPO, so
//     Mission Control's own repo (or any other) is never searched by mistake;
//   - credential-like files are excluded, output is capped, secrets redacted.

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { redactSecrets } from "../lib/redact";
import { validateRepoPath } from "./github-read";

export const SEARCH_MAX_MATCHES = 60;
export const SEARCH_MAX_CHARS = 9_000;
const MATCH_TEXT_CHARS = 240;
const QUERY_MAX_CHARS = 200;
const GIT_TIMEOUT_MS = 10_000;

export const ALLOWED_SUBCOMMANDS: ReadonlySet<string> = new Set(["rev-parse", "config", "grep"]);

// Excluded from every search (credential-like files).
const EXCLUDES = ["**/.env*", "**/*.jks", "**/*.keystore", "**/*.p12", "**/*.pfx", "**/*.pem", "**/*.key", "**/key.properties", "**/id_rsa*", "**/id_ed25519*"].map(
  (g) => `:(top,exclude,glob)${g}`,
);

export type GitRunner = (root: string, args: readonly string[]) => Promise<{ code: number; stdout: string }>;

// Default runner: no shell, fixed binary, bounded time/output, no prompts,
// no fsmonitor hook, no optional locks (read-only).
export const execGit: GitRunner = (root, args) =>
  new Promise((done) => {
    const sub = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-c");
    if (!sub || !ALLOWED_SUBCOMMANDS.has(sub)) {
      done({ code: 128, stdout: "" });
      return;
    }
    execFile(
      "git",
      ["-C", root, "-c", "core.fsmonitor=false", "-c", "core.quotepath=off", ...args],
      {
        cwd: root,
        shell: false,
        windowsHide: true,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", PAGER: "cat" },
      },
      (err, stdout) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 128) : 0;
        done({ code, stdout: String(stdout ?? "") });
      },
    );
  });

const norm = (p: string) => {
  let r = resolve(p);
  try {
    r = realpathSync.native(r); // canonical form (long names, real casing)
  } catch {
    // keep the resolved path; a missing path simply won't match
  }
  return r.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
};

// "https://github.com/owner/repo(.git)" | "git@github.com:owner/repo(.git)" -> "owner/repo"
export function githubSlug(url: string): string | null {
  const m = /github\.com[:/]+([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

export interface SearchTarget {
  root: string;
  repo: string;
  commit: string; // the run's pinned 40-hex commit, verified present locally
}

// Verifies WHAT will be searched: the right repository, and the pinned commit
// present in it. Any doubt -> refuse.
export async function resolveSearchTarget(pinnedCommit: unknown, run: GitRunner = execGit): Promise<SearchTarget | { error: string }> {
  if (typeof pinnedCommit !== "string" || !/^[0-9a-f]{40}$/.test(pinnedCommit)) {
    return { error: "No valid pinned FootRank commit for this run — nothing was searched." };
  }
  const repo = process.env.GITHUB_REPO?.trim();
  if (!repo) return { error: "GITHUB_REPO is not set — search_code does not know which repository to search." };
  const root = resolve(process.env.FOOTRANK_PATH?.trim() || "C:\\Projects\\footrank");
  if (!existsSync(root)) return { error: "The FootRank repository clone (FOOTRANK_PATH) was not found on this machine." };

  const top = await run(root, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || norm(top.stdout.trim()) !== norm(root)) return { error: "FOOTRANK_PATH is not the root of a git repository — refusing to search." };

  const origin = await run(root, ["config", "--get", "remote.origin.url"]);
  if (origin.code !== 0 || githubSlug(origin.stdout) !== repo.toLowerCase()) {
    return { error: `The clone at FOOTRANK_PATH is not ${repo} — refusing to search a different repository.` };
  }

  // Read-only existence check of the exact pinned commit (never a branch).
  const sha = await run(root, ["rev-parse", "--verify", "--quiet", `${pinnedCommit}^{commit}`]);
  if (sha.code !== 0 || sha.stdout.trim() !== pinnedCommit) {
    return { error: `Pinned FootRank commit ${pinnedCommit} is not available in the local clone; run git fetch before retrying.` };
  }
  return { root, repo, commit: pinnedCommit };
}

export function validateQuery(q: unknown): { ok: true; query: string } | { ok: false; reason: string } {
  if (typeof q !== "string" || q.trim() === "") return { ok: false, reason: "query is required" };
  if (q.length > QUERY_MAX_CHARS) return { ok: false, reason: `query is longer than ${QUERY_MAX_CHARS} characters` };
  if (/[\u0000-\u001f\u007f]/.test(q)) return { ok: false, reason: "query contains control characters (single line only)" };
  return { ok: true, query: q };
}

export async function searchCode(query: unknown, path: unknown, pinnedCommit: unknown, run: GitRunner = execGit): Promise<string> {
  const q = validateQuery(query);
  if (!q.ok) return `Rejected: ${q.reason}. Nothing was searched.`;
  const p = validateRepoPath(path ?? "", { allowEmpty: true });
  if (!p.ok) return `Rejected: ${p.reason}. Nothing was searched.`;

  const target = await resolveSearchTarget(pinnedCommit, run);
  if ("error" in target) return target.error;

  const pathspecs = [...(p.path ? [`:(top,literal)${p.path}`] : []), ...EXCLUDES];
  const res = await run(target.root, ["grep", "-n", "-I", "--no-color", "-F", "-e", q.query, target.commit, "--", ...pathspecs]);
  const where = p.path ? ` in ${p.path}` : "";
  const header = `search_code ${JSON.stringify(q.query)}${where}\nrepo: ${target.repo} @ ${target.commit} (pinned for this run; uncommitted local work is not searched)`;
  if (res.code === 1) return `${header}\n\nNo matches.`;
  if (res.code !== 0) return `${header}\n\nSearch failed (git exit ${res.code}). Nothing was changed.`;

  const prefix = `${target.commit}:`;
  const hits: { file: string; line: number; text: string }[] = [];
  for (const raw of res.stdout.split(/\r?\n/)) {
    if (!raw.startsWith(prefix)) continue;
    const m = /^(.*?):(\d+):(.*)$/.exec(raw.slice(prefix.length));
    if (m) hits.push({ file: m[1], line: Number(m[2]), text: m[3] });
  }
  if (hits.length === 0) return `${header}\n\nNo matches.`;

  const files = new Set(hits.map((h) => h.file)).size;
  const rows: string[] = [];
  let chars = 0;
  for (const h of hits.slice(0, SEARCH_MAX_MATCHES)) {
    let text = redactSecrets(h.text.trim());
    if (text.length > MATCH_TEXT_CHARS) text = `${text.slice(0, MATCH_TEXT_CHARS)} …`;
    const row = `${h.file}:${h.line}: ${text}`;
    if (chars + row.length + 1 > SEARCH_MAX_CHARS) break;
    rows.push(row);
    chars += row.length + 1;
  }
  const hidden = hits.length - rows.length;
  const more = hidden > 0 ? `\n… ${hidden} more match(es) not shown — narrow the path or use a more specific query.` : "";
  return `${header}\n${hits.length} match(es) in ${files} file(s)${hidden > 0 ? `, showing ${rows.length}` : ""}:\n\n${rows.join("\n")}${more}\n\nOpen a location with read_repo_file(path, start_line, end_line).`;
}
