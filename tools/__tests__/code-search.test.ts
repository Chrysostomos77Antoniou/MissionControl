import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchCode, resolveSearchTarget, execGit, githubSlug, ALLOWED_SUBCOMMANDS, SEARCH_MAX_MATCHES, type GitRunner } from "../code-search";

// A real temporary git repo standing in for the FootRank clone: one pushed
// commit on refs/remotes/origin/master (with origin/HEAD pointing at it),
// plus uncommitted local edits that must NEVER be searched.
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const FAKE_KEY = ["AIza", "Sy", "B".repeat(33)].join("");
let repo = "";
let other = "";
let pushed = "";

function makeRepo(origin: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-search-"));
  git(dir, "init", "-q", "-b", "master");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "remote", "add", "origin", origin);
  return dir;
}

beforeAll(() => {
  repo = makeRepo("https://github.com/acme/footrank.git");
  const w = (p: string, s: string) => {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), s);
  };
  w("lib/core/constants/cities.dart", "String? canonicalCity(String? value) {\n  final v = value?.trim().toLowerCase();\n  return v;\n}\n");
  w("lib/match/presentation/pages/matches_page.dart", "import 'package:footrank/core/constants/cities.dart';\nclass MatchesPage {\n  void a() { _filterCity = canonicalCity(sel.city); }\n  void b() { _filterCity = canonicalCity(team.city); }\n}\n");
  w("test/models_test.dart", "test('canonicalCity maps any case', () { expect(canonicalCity('nicosia'), 'Nicosia'); });\n");
  w("lib/config.dart", `const apiKey = '${FAKE_KEY}'; // SECRET_MARKER\n`);
  w(".env", "SECRET_MARKER=do-not-read\n");
  w("lib/many.dart", Array.from({ length: 150 }, (_, i) => `final repeated${i} = 'NEEDLE';`).join("\n") + "\n");
  w("lib/shell.dart", "const s = 'a; rm -rf / #';\nconst t = '$(whoami)';\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "pushed state");
  pushed = git(repo, "rev-parse", "HEAD");
  git(repo, "update-ref", "refs/remotes/origin/master", pushed);
  git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master");
  // Uncommitted local work — must not appear in results.
  writeFileSync(join(repo, "lib/core/constants/cities.dart"), "String? canonicalCity(String? value) => LOCAL_ONLY_EDIT;\n");
  writeFileSync(join(repo, "lib/untracked.dart"), "final u = canonicalCity('x'); // LOCAL_ONLY_EDIT\n");

  other = makeRepo("https://github.com/someone/MissionControl.git");
  writeFileSync(join(other, "a.ts"), "canonicalCity\n");
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "x");
  git(other, "update-ref", "refs/remotes/origin/master", git(other, "rev-parse", "HEAD"));
  git(other, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master");
}, 60_000);

afterAll(() => {
  for (const d of [repo, other]) if (d) rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.GITHUB_REPO = "acme/footrank";
  process.env.FOOTRANK_PATH = repo;
});

describe("search_code", () => {
  it("finds a function definition and its callers, with exact file:line, at the pushed commit", async () => {
    const out = await searchCode("canonicalCity(", undefined, pushed);
    expect(out).toContain(`repo: acme/footrank @ ${pushed} (pinned for this run;`);
    expect(out).toContain("lib/core/constants/cities.dart:1: String? canonicalCity(String? value) {");
    expect(out).toContain("lib/match/presentation/pages/matches_page.dart:3:");
    expect(out).toContain("lib/match/presentation/pages/matches_page.dart:4:");
    expect(out).toContain("test/models_test.dart:1:");
    expect(out).toMatch(/4 match\(es\) in 3 file\(s\):/);
  });

  it("finds imports and class definitions", async () => {
    expect(await searchCode("import 'package:footrank/core/constants/cities.dart'", undefined, pushed)).toContain("lib/match/presentation/pages/matches_page.dart:1:");
    expect(await searchCode("class MatchesPage", undefined, pushed)).toContain("lib/match/presentation/pages/matches_page.dart:2: class MatchesPage {");
  });

  it("never searches uncommitted or untracked local work", async () => {
    const out = await searchCode("LOCAL_ONLY_EDIT", undefined, pushed);
    expect(out).toMatch(/No matches\.$/);
    expect(await searchCode("canonicalCity(", undefined, pushed)).not.toContain("untracked.dart");
  });

  it("path restriction limits results to a file or folder", async () => {
    const t = await searchCode("canonicalCity(", "test", pushed);
    expect(t).toContain("test/models_test.dart:1:");
    expect(t).not.toContain("lib/");
    const f = await searchCode("canonicalCity(", "lib/core/constants/cities.dart", pushed);
    expect(f).toMatch(/1 match\(es\) in 1 file\(s\)/);
  });

  it("no-result search", async () => {
    expect(await searchCode("thisStringIsNowhere", undefined, pushed)).toMatch(/\n\nNo matches\.$/);
    expect(await searchCode("canonicalCity(", "lib/does/not/exist", pushed)).toMatch(/No matches\.$/);
  });

  it("output is capped and says how many were hidden", async () => {
    const out = await searchCode("NEEDLE", undefined, pushed);
    expect(out).toMatch(new RegExp(`150 match\\(es\\) in 1 file\\(s\\), showing ${SEARCH_MAX_MATCHES}:`));
    expect(out).toMatch(/… 90 more match\(es\) not shown/);
    expect(out.split("\n").filter((l) => l.startsWith("lib/many.dart:")).length).toBe(SEARCH_MAX_MATCHES);
  });

  it("secrets are redacted and credential files are never searched", async () => {
    const out = await searchCode("SECRET_MARKER", undefined, pushed);
    expect(out).toContain("lib/config.dart:1:");
    expect(out).toContain("[redacted-secret]");
    expect(out).not.toContain(FAKE_KEY);
    expect(out).not.toContain(".env");
    expect(out).not.toContain("do-not-read");
  });

  it("shell metacharacters and option-like queries are plain text, never executed", async () => {
    const marker = join(repo, "PWNED");
    expect(await searchCode("a; rm -rf / #", undefined, pushed)).toContain("lib/shell.dart:1:");
    expect(await searchCode("$(whoami)", undefined, pushed)).toContain("lib/shell.dart:2:");
    expect(await searchCode(`x" && echo pwned > "${marker}`, undefined, pushed)).toMatch(/No matches\.$/);
    expect(await searchCode("x | echo pwned > PWNED", undefined, pushed)).toMatch(/No matches\.$/);
    expect(await searchCode("--open-files-in-pager=calc", undefined, pushed)).toMatch(/No matches\.$/);
    expect(await searchCode("-e", undefined, pushed)).toMatch(/No matches\.$|match/);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(repo, "lib", "PWNED"))).toBe(false);
  });

  it("malicious / traversal paths and invalid queries are rejected before git runs", async () => {
    let ran = 0;
    const spy: GitRunner = async (root, args) => {
      ran++;
      return execGit(root, args);
    };
    for (const p of ["../other", "lib/../../x", "C:/Windows", "/etc/passwd/../..", "lib\\core", ":(glob)**", ":!lib", "lib/*", "lib/a?b", ".env", "*"]) {
      expect(await searchCode("x", p, pushed, spy), p).toMatch(/^Rejected: /);
    }
    for (const q of ["", "   ", "a\nb", "a\u0000b", "x".repeat(201), 42]) {
      expect(await searchCode(q, undefined, pushed, spy)).toMatch(/^Rejected: /);
    }
    expect(ran).toBe(0);
  });

  it("repository confinement: refuses a clone of any other repo (e.g. Mission Control itself)", async () => {
    process.env.FOOTRANK_PATH = other;
    expect(await searchCode("canonicalCity", undefined, pushed)).toBe("The clone at FOOTRANK_PATH is not acme/footrank — refusing to search a different repository.");
    process.env.FOOTRANK_PATH = join(repo, "lib"); // a subfolder, not the repo root
    expect(await searchCode("canonicalCity", undefined, pushed)).toMatch(/not the root of a git repository — refusing/);
    process.env.FOOTRANK_PATH = join(repo, "nope");
    expect(await searchCode("canonicalCity", undefined, pushed)).toMatch(/was not found on this machine/);
    process.env.FOOTRANK_PATH = repo;
    delete process.env.GITHUB_REPO;
    expect(await searchCode("canonicalCity", undefined, pushed)).toMatch(/GITHUB_REPO is not set/);
  });

  it("fails closed when the local clone does not contain the pinned commit (no fetch, nothing searched)", async () => {
    const missing = "0123456789abcdef0123456789abcdef01234567";
    const seen: string[][] = [];
    const spy: GitRunner = async (root, args) => {
      seen.push([...args]);
      return execGit(root, args);
    };
    expect(await searchCode("canonicalCity(", undefined, missing, spy)).toBe(
      `Pinned FootRank commit ${missing} is not available in the local clone; run git fetch before retrying.`,
    );
    expect(seen.map((a) => a[0])).toEqual(["rev-parse", "config", "rev-parse"]); // no grep, no fetch
  });

  it("an invalid pin is refused before git runs; the local origin/master is never used as a fallback", async () => {
    let ran = 0;
    const spy: GitRunner = async (root, args) => {
      ran++;
      return execGit(root, args);
    };
    for (const bad of [undefined, "", "HEAD", "origin/master", "refs/remotes/origin/master", pushed.slice(0, 7), pushed.toUpperCase(), `${pushed} --all`]) {
      expect(await searchCode("canonicalCity(", undefined, bad, spy)).toBe("No valid pinned FootRank commit for this run — nothing was searched.");
    }
    expect(ran).toBe(0);
  });

  it("local origin/master moving after the pin does not change what is searched", async () => {
    // Its own fixture repo: commit A (pinned at run start), then commit B lands
    // and origin/master + origin/HEAD move to B while the run is still pinned to A.
    const moving = makeRepo("https://github.com/acme/footrank.git");
    try {
      writeFileSync(join(moving, "a.dart"), "final a = canonicalCity('x'); // IN_BOTH\n");
      git(moving, "add", "-A");
      git(moving, "commit", "-q", "-m", "A");
      const pinA = git(moving, "rev-parse", "HEAD");
      writeFileSync(join(moving, "b.dart"), "final b = 1; // ONLY_IN_NEWER\n");
      git(moving, "add", "-A");
      git(moving, "commit", "-q", "-m", "B");
      const newerB = git(moving, "rev-parse", "HEAD");
      git(moving, "update-ref", "refs/remotes/origin/master", newerB);
      git(moving, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master");
      process.env.FOOTRANK_PATH = moving;

      const pinned = await searchCode("ONLY_IN_NEWER", undefined, pinA);
      expect(pinned).toContain(`@ ${pinA} (pinned for this run;`);
      expect(pinned).toMatch(/No matches\.$/);
      expect(await searchCode("IN_BOTH", undefined, pinA)).toContain("a.dart:1:");
      // The newer commit is searched only by a run pinned to it.
      expect(await searchCode("ONLY_IN_NEWER", undefined, newerB)).toContain("b.dart:1:");
    } finally {
      rmSync(moving, { recursive: true, force: true });
    }
  });

  it("read-only: only allowlisted read subcommands run; HEAD, refs, index and files are unchanged", async () => {
    const seen: string[][] = [];
    const spy: GitRunner = async (root, args) => {
      seen.push([...args]);
      return execGit(root, args);
    };
    const before = {
      head: git(repo, "rev-parse", "HEAD"),
      refs: git(repo, "show-ref"),
      status: git(repo, "status", "--porcelain"),
      local: readFileSync(join(repo, "lib/core/constants/cities.dart"), "utf8"),
      index: statSync(join(repo, ".git", "index")).mtimeMs,
    };
    await searchCode("canonicalCity(", "lib", pushed, spy);
    await searchCode("nothing-here", undefined, pushed, spy);
    const indexAfter = statSync(join(repo, ".git", "index")).mtimeMs; // before any further `git status`
    expect(indexAfter).toBe(before.index);
    expect(seen.every((a) => ALLOWED_SUBCOMMANDS.has(a[0]))).toBe(true);
    expect(seen.map((a) => a[0])).toEqual(["rev-parse", "config", "rev-parse", "grep", "rev-parse", "config", "rev-parse", "grep"]);
    expect(git(repo, "rev-parse", "HEAD")).toBe(before.head);
    expect(git(repo, "show-ref")).toBe(before.refs);
    expect(git(repo, "status", "--porcelain")).toBe(before.status);
    expect(readFileSync(join(repo, "lib/core/constants/cities.dart"), "utf8")).toBe(before.local);
  });

  it("the runner refuses any non-allowlisted git subcommand", async () => {
    for (const sub of ["checkout", "reset", "fetch", "pull", "push", "commit", "branch", "clean", "symbolic-ref", "update-ref", "config-set"]) {
      expect(await execGit(repo, [sub, "--help"])).toEqual({ code: 128, stdout: "" });
    }
    expect(await execGit(repo, ["-c", "x=y", "checkout", "."])).toEqual({ code: 128, stdout: "" });
  });

  it("the grep call is fixed-string, after -e, at a pinned commit, with literal pathspecs", async () => {
    let grepArgs: string[] = [];
    const spy: GitRunner = async (root, args) => {
      if (args[0] === "grep") grepArgs = [...args];
      return execGit(root, args);
    };
    await searchCode("-x;y", "lib/core", pushed, spy);
    const i = grepArgs.indexOf("-e");
    expect(grepArgs.slice(0, 5)).toEqual(["grep", "-n", "-I", "--no-color", "-F"]);
    expect(grepArgs[i + 1]).toBe("-x;y");
    expect(grepArgs[i + 2]).toBe(pushed);
    expect(grepArgs[i + 3]).toBe("--");
    expect(grepArgs[i + 4]).toBe(":(top,literal)lib/core");
    expect(grepArgs.filter((a) => a.startsWith(":(top,exclude,glob)")).length).toBeGreaterThan(0);
  });

  it("resolves the target it will search, and parses GitHub remotes", async () => {
    const t = await resolveSearchTarget(pushed);
    expect(t).toEqual({ root: expect.any(String), repo: "acme/footrank", commit: pushed });
    expect(githubSlug("https://github.com/Acme/FootRank.git")).toBe("acme/footrank");
    expect(githubSlug("git@github.com:acme/footrank.git")).toBe("acme/footrank");
    expect(githubSlug("https://gitlab.com/acme/footrank.git")).toBeNull();
  });
});
