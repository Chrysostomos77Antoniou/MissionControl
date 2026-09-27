import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  readRepoFileLines,
  readRepoFile,
  resolveFootRankCommit,
  formatNumberedWindow,
  splitLines,
  validateRepoPath,
  READ_DEFAULT_LINES,
  READ_MAX_LINES,
  READ_MAX_CHARS,
} from "../github-read";

const COMMIT = "27e1e5ac5a89cb9d5f5cb7ca6a1368afa0582a46";
const NEWER = "1111111111111111111111111111111111111111";
const file = (n: number, eol = "\n") => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join(eol) + eol;
const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

let calls: string[] = [];
function mockGitHub(content: string | null, opts: { status?: number; dir?: boolean; large?: boolean; commit?: string } = {}) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith("/commits/HEAD")) return new Response(opts.commit ?? COMMIT, { status: 200 });
      if (opts.status) return new Response("{}", { status: opts.status });
      if (opts.dir) return new Response(JSON.stringify([{ name: "a.dart" }]), { status: 200 });
      if (opts.large) return new Response(JSON.stringify({ type: "file", encoding: "none", content: "", size: 2_000_000 }), { status: 200 });
      return new Response(JSON.stringify({ type: "file", encoding: "base64", content: b64(content ?? "") }), { status: 200 });
    }),
  );
}

beforeEach(() => {
  process.env.GITHUB_REPO = "acme/footrank";
  process.env.GITHUB_TOKEN = ["test", "token"].join("-");
});
afterEach(() => vi.unstubAllGlobals());

describe("read_repo_file: numbered, ranged reads", () => {
  it("reports path, commit, range and total, and numbers lines exactly", async () => {
    mockGitHub(file(300));
    const out = await readRepoFileLines("lib/a.dart", 120, 122, COMMIT);
    expect(out).toBe(`lib/a.dart\ncommit: ${COMMIT}\nlines 120-122 of 300 (more below — call again with start_line=123)\n\n120| line 120\n121| line 121\n122| line 122`);
  });

  it("reads AT the pinned commit and never resolves GitHub HEAD itself", async () => {
    mockGitHub(file(3), { commit: NEWER });
    const out = await readRepoFileLines("lib/a.dart", undefined, undefined, COMMIT);
    expect(calls).toEqual([`https://api.github.com/repos/acme/footrank/contents/lib/a.dart?ref=${COMMIT}`]);
    expect(out).toContain(`commit: ${COMMIT}`);
    expect(out).not.toContain(NEWER);
  });

  it("resolveFootRankCommit resolves the default branch's commit once, from the same GitHub source", async () => {
    mockGitHub(null, { commit: COMMIT });
    expect(await resolveFootRankCommit()).toEqual({ ok: true, sha: COMMIT });
    expect(calls).toEqual(["https://api.github.com/repos/acme/footrank/commits/HEAD"]);
    mockGitHub(null, { commit: "not-a-sha" });
    expect(await resolveFootRankCommit()).toEqual({ ok: false, reason: "GitHub returned an unexpected commit id" });
    delete process.env.GITHUB_TOKEN;
    expect(await resolveFootRankCommit()).toEqual({ ok: false, reason: "GITHUB_REPO / GITHUB_TOKEN not set" });
  });

  it("GitHub HEAD moving after the pin does not change what is read", async () => {
    mockGitHub("old line\n", { commit: COMMIT });
    const pin = await resolveFootRankCommit();
    expect(pin).toEqual({ ok: true, sha: COMMIT });
    // Someone pushes: HEAD now resolves to NEWER. The run keeps its pin.
    mockGitHub("old line\n", { commit: NEWER });
    const out = await readRepoFileLines("lib/a.dart", 1, 1, (pin as { sha: string }).sha);
    expect(calls).toEqual([`https://api.github.com/repos/acme/footrank/contents/lib/a.dart?ref=${COMMIT}`]);
    expect(out).toContain(`commit: ${COMMIT}`);
  });

  it("without a valid pinned commit nothing is read (fail closed)", async () => {
    mockGitHub(file(3));
    for (const bad of [undefined, "", "HEAD", "master", "27e1e5a", COMMIT.toUpperCase(), `${COMMIT}; rm`]) {
      expect(await readRepoFileLines("lib/a.dart", 1, 2, bad)).toBe("No valid pinned FootRank commit for this run — nothing was read.");
    }
    expect(calls).toEqual([]);
  });

  it("first line and last line", async () => {
    mockGitHub(file(50));
    expect(await readRepoFileLines("lib/a.dart", 1, 1, COMMIT)).toMatch(/lines 1-1 of 50 .*\n\n1\| line 1$/);
    expect(await readRepoFileLines("lib/a.dart", 50, 50, COMMIT)).toMatch(/lines 50-50 of 50\n\n50\| line 50$/);
  });

  it("a range beyond EOF returns what exists and states the total", async () => {
    mockGitHub(file(10));
    const out = await readRepoFileLines("lib/a.dart", 8, 40, COMMIT);
    expect(out).toMatch(/lines 8-10 of 10 \(requested up to line 40; the file ends at line 10\)/);
    expect(out.trim().endsWith("10| line 10")).toBe(true);
    expect(await readRepoFileLines("lib/a.dart", 11, 20, COMMIT)).toMatch(/requested lines 11-20, but the file has only 10 lines — nothing to show/);
  });

  it("line numbers are correct for CRLF files, trailing newlines and a missing final newline", () => {
    expect(splitLines("a\r\nb\r\n")).toEqual(["a", "b"]);
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
    expect(splitLines("a\n\nb\n")).toEqual(["a", "", "b"]);
    expect(splitLines("")).toEqual([]);
    const out = formatNumberedWindow("x.dart", COMMIT, file(12, "\r\n"), 9, 12);
    expect(out).toMatch(/lines 9-12 of 12\n\n 9\| line 9\n10\| line 10\n11\| line 11\n12\| line 12$/);
    expect(out).not.toMatch(/\r/);
  });

  it("an empty file reports 0 lines", () => {
    expect(formatNumberedWindow("e.dart", COMMIT, "")).toBe(`e.dart\ncommit: ${COMMIT}\n(empty file: 0 lines)`);
  });

  it("bounded by default: no range shows the first 250 lines and says how to continue", async () => {
    mockGitHub(file(2114));
    const out = await readRepoFileLines("lib/match/presentation/pages/matches_page.dart", undefined, undefined, COMMIT);
    expect(READ_DEFAULT_LINES).toBe(250);
    expect(out).toMatch(/lines 1-250 of 2114 \(more below — call again with start_line=251\)/);
    expect(out).toMatch(/\n250\| line 250$/);
  });

  it("the old 12,000-character wall is gone: any later range can be read", async () => {
    mockGitHub(file(2114));
    const out = await readRepoFileLines("lib/match/presentation/pages/matches_page.dart", 2100, 2114, COMMIT);
    expect(out).toMatch(/lines 2100-2114 of 2114\n\n2100\| line 2100/);
  });

  it("hard caps: at most 400 lines and ~16,000 characters per call", async () => {
    mockGitHub(file(2000));
    const many = await readRepoFileLines("lib/a.dart", 1, 2000, COMMIT);
    expect(READ_MAX_LINES).toBe(400);
    expect(many).toMatch(/lines 1-400 of 2000/);
    const wide = Array.from({ length: 100 }, (_, i) => `${i + 1}`.padEnd(900, "x")).join("\n");
    const capped = formatNumberedWindow("w.dart", COMMIT, wide, 1, 100);
    expect(capped.length).toBeLessThan(READ_MAX_CHARS + 400);
    expect(capped).toMatch(/output capped at line \d+; more below — call again with start_line=\d+/);
  });

  it("invalid ranges are explained, never guessed", () => {
    expect(formatNumberedWindow("a", COMMIT, file(5), 0)).toMatch(/start_line must be a whole number >= 1/);
    expect(formatNumberedWindow("a", COMMIT, file(5), 2.5)).toMatch(/start_line must be a whole number/);
    expect(formatNumberedWindow("a", COMMIT, file(5), 4, 2)).toMatch(/end_line \(2\) is before start_line \(4\)/);
    expect(formatNumberedWindow("a", COMMIT, file(5), "3", "4")).toMatch(/lines 3-4 of 5/);
  });

  it("missing file, directory and too-large file are reported plainly", async () => {
    mockGitHub(null, { status: 404 });
    expect(await readRepoFileLines("lib/nope.dart", undefined, undefined, COMMIT)).toBe(`Not found: lib/nope.dart does not exist at commit ${COMMIT}. Use search_code or list_repo to locate it.`);
    mockGitHub(null, { dir: true });
    expect(await readRepoFileLines("lib", undefined, undefined, COMMIT)).toMatch(/is a directory/);
    mockGitHub(null, { large: true });
    expect(await readRepoFileLines("big.json", undefined, undefined, COMMIT)).toMatch(/too large .* Use search_code/);
  });

  it("path traversal, absolute paths, URL tricks and credential files are refused before any request", async () => {
    mockGitHub(file(2));
    for (const p of ["../secrets", "lib/../../x", "C:/Windows/win.ini", "lib\\a.dart", "lib/a.dart?ref=main", "lib/%2e%2e/x", "lib/a.dart#x", ".env", "android/key.properties", "android/app/upload.jks", "lib/./a.dart"]) {
      expect(await readRepoFileLines(p, undefined, undefined, COMMIT), p).toMatch(/^Rejected: /);
    }
    expect(calls).toEqual([]);
    expect(validateRepoPath("lib/core/constants/cities.dart")).toEqual({ ok: true, path: "lib/core/constants/cities.dart" });
  });

  it("secret-shaped strings in source are redacted; ordinary numbers are not", () => {
    const key = ["AIza", "Sy", "A".repeat(33)].join("");
    const out = formatNumberedWindow("c.dart", COMMIT, `const k = '${key}';\nconst ts = 20260915120000;\n`);
    expect(out).not.toContain(key);
    expect(out).toContain("[redacted-secret]");
    expect(out).toContain("20260915120000");
  });

  it("the fix agent's raw readRepoFile is unchanged (no numbering, no range)", async () => {
    mockGitHub("a\nb\n");
    expect(await readRepoFile("lib/a.dart")).toBe("a\nb\n");
  });
});
