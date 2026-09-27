import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceLedger, parseReadWindow, parseSearchResult, evidenceRefNote, EVIDENCE_TOOLS } from "../evidence-ledger";
import { searchCode } from "../../tools/code-search";
import { formatNumberedWindow } from "../../tools/github-read";
import { PIN, OTHER_PIN, OUT, CITIES, MATCHES_PAGE } from "./finding-fixtures";

// Format fidelity: the ledger must parse what the REAL tools print.
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
let repo = "";
let sha = "";

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "mc-ledger-"));
  git(repo, "init", "-q", "-b", "master");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "remote", "add", "origin", "https://github.com/acme/footrank.git");
  mkdirSync(join(repo, "lib"), { recursive: true });
  writeFileSync(join(repo, "lib/a.dart"), "class A {\n  void go() { canonicalCity(x); }\n}\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "x");
  sha = git(repo, "rev-parse", "HEAD");
}, 60_000);

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("evidence ledger: parsing real tool output", () => {
  it("parses a real read_repo_file window (formatNumberedWindow) with the tool's own line numbers", () => {
    const out = formatNumberedWindow("lib/a.dart", PIN, "l1\nl2\nl3\nl4\n", 2, 3);
    const w = parseReadWindow(out)!;
    expect(w).toMatchObject({ path: "lib/a.dart", commit: PIN, start: 2, end: 3, total: 4 });
    expect([...w.lines.entries()]).toEqual([[2, "l2"], [3, "l3"]]);
  });

  it("parses a real search_code result (hits and no-match) from a real git repo", async () => {
    process.env.GITHUB_REPO = "acme/footrank";
    process.env.FOOTRANK_PATH = repo;
    const hit = parseSearchResult(await searchCode("canonicalCity(", undefined, sha))!;
    expect(hit).toMatchObject({ query: "canonicalCity(", scope: "", commit: sha, noMatches: false, complete: true });
    expect(hit.hits).toEqual([{ file: "lib/a.dart", line: 2, text: "void go() { canonicalCity(x); }" }]);
    const none = parseSearchResult(await searchCode("nothingHere", "lib", sha))!;
    expect(none).toMatchObject({ query: "nothingHere", scope: "lib", noMatches: true, hits: [] });
  });

  it("the fixture renderers match the real formats", () => {
    expect(parseReadWindow(OUT.cities())).toMatchObject({ path: CITIES, start: 1, end: 20, total: 20 });
    expect(parseSearchResult(OUT.searchMembers())!.hits.map((h) => `${h.file}:${h.line}`)).toEqual(["lib/home/presentation/pages/home_page.dart:108", `${MATCHES_PAGE}:298`]);
  });
});

describe("evidence ledger: recording", () => {
  it("records successful tool results with unguessable run-specific refs and returns them", () => {
    const l = new EvidenceLedger({ commit: PIN });
    const r1 = l.record("read_repo_file", { path: CITIES }, OUT.cities());
    const r2 = l.record("db_read", { sql: "select 1" }, "[{\"n\":1}]");
    expect(r1).toMatch(/^ev1-[0-9a-f]{6}$/);
    expect(r2).toMatch(/^ev2-[0-9a-f]{6}$/);
    expect(l.get(r1)?.read?.path).toBe(CITIES);
    expect(evidenceRefNote(r1!)).toContain(r1!);
  });

  it("two runs never share refs, and a ref from one run is unknown to another", () => {
    const a = new EvidenceLedger({ commit: PIN });
    const b = new EvidenceLedger({ commit: PIN });
    const ra = a.record("read_repo_file", { path: CITIES }, OUT.cities())!;
    const rb = b.record("read_repo_file", { path: CITIES }, OUT.cities())!;
    expect(ra).not.toBe(rb); // same seq and same output, different run secret
    expect(b.get(ra)).toBeUndefined();
    expect(a.runId).not.toBe(b.runId);
  });

  it("code results from a different commit than the run's pin, or with no pin, are never evidence", () => {
    expect(new EvidenceLedger({ commit: PIN }).record("read_repo_file", {}, formatNumberedWindow(CITIES, OTHER_PIN, "a\n", 1, 1))).toBeNull();
    expect(new EvidenceLedger({}).record("read_repo_file", {}, OUT.cities())).toBeNull();
    expect(new EvidenceLedger({ commit: PIN }).record("search_code", {}, OUT.searchMembers().replace(PIN, OTHER_PIN))).toBeNull();
  });

  it("refusals, errors, unparseable output and non-evidence tools are not recorded", () => {
    const l = new EvidenceLedger({ commit: PIN });
    expect(l.record("read_repo_file", {}, "Rejected: path traversal is not allowed. Nothing was read.")).toBeNull();
    expect(l.record("read_repo_file", {}, `Not found: x does not exist at commit ${PIN}.`)).toBeNull();
    expect(l.record("db_read", {}, "Query rejected by the read-only guard: x. Nothing was executed.")).toBeNull();
    expect(l.record("search_code", {}, "garbage")).toBeNull();
    expect(l.record("list_repo", {}, "lib/\ntest/")).toBeNull(); // list_repo is not pinned
    expect(l.record("save_suggestion", {}, "Saved.")).toBeNull();
    expect(EVIDENCE_TOOLS.has("list_repo")).toBe(false);
  });

  it("a tampered record fails its seal and is treated as not from this run", () => {
    const l = new EvidenceLedger({ commit: PIN });
    const ref = l.record("db_read", {}, "[{\"n\":1}]")!;
    (l.get(ref) as { output: string }).output = "[{\"n\":999}]";
    expect(l.get(ref)).toBeUndefined();
  });
});
