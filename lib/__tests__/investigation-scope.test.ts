import { describe, it, expect } from "vitest";
import { EvidenceLedger, parseReadWindow } from "../evidence-ledger";
import {
  buildScope,
  detectOverclaim,
  followUpMessage,
  scopeLine,
  scopeDetail,
  isCodeFile,
  isImportExportOnlyHit,
  SPECIFIC_SEARCH_MAX_HITS,
  CLUSTER_GAP_LINES,
} from "../investigation-scope";
import { readOut, searchOut, PIN } from "./finding-fixtures";

// A generic page file and a search whose hits are spread like a real symbol:
// a declaration near the top, a logic block further down, and a stray use.
const PAGE = "lib/feature/presentation/pages/feature_page.dart";
const SYMBOL_HITS: [string, number, string][] = [57, 123, 155, 177, 194, 197, 202, 204, 581].map((n) => [PAGE, n, `use of stateField at ${n}`]);

function ledger(...outputs: [string, Record<string, unknown>, string][]) {
  const l = new EvidenceLedger({ commit: PIN });
  for (const [tool, input, out] of outputs) l.record(tool, input, out);
  return l;
}
const read = (file: string, total: number, start: number, end: number) => ["read_repo_file", { path: file, start_line: start, end_line: end }, readOut(file, total, {}, start, end)] as [string, Record<string, unknown>, string];
const search = (query: string, hits: [string, number, string][], scope?: string) => ["search_code", { query }, searchOut(query, hits, scope)] as [string, Record<string, unknown>, string];

describe("source inspection is only what read_repo_file returned", () => {
  it("A. list_repo alone is discovery only: no source inspection", () => {
    const s = buildScope([], { listRepoCalls: 3, searchCalls: 0 });
    expect(s).toMatchObject({ level: "discovery-only", sourceReads: [], sourceLinesRead: 0, listRepoCalls: 3 });
    expect(buildScope([], { listRepoCalls: 0, searchCalls: 0 }).level).toBe("none");
  });

  it("B. search_code alone is not source inspection (it creates leads, not coverage)", () => {
    const l = ledger(search("stateField", SYMBOL_HITS));
    const s = buildScope(l.all(), { listRepoCalls: 0, searchCalls: 1 });
    expect(s.level).toBe("discovery-only");
    expect(s.sourceReads).toEqual([]);
    expect(s.unreadLeads.map((x) => `${x.start}-${x.end}`)).toEqual(["123-204", "57-57", "581-581"]);
  });

  it("C. read_repo_file counts only for the exact range returned, including truncation", () => {
    const big = "lib/big.dart";
    // Ask for 1-2000; the tool truncates the window (line/character caps): only what it printed counts.
    const out = readOut(big, 3000, {}, 1, 2000);
    const printed = parseReadWindow(out)!;
    expect(printed.end).toBeLessThan(2000);
    const l = ledger(["read_repo_file", { path: big, start_line: 1, end_line: 2000 }, out], read(PAGE, 700, 90, 110));
    const s = buildScope(l.all(), { listRepoCalls: 0, searchCalls: 0 });
    expect(s.sourceReads).toEqual([
      { file: big, ranges: [{ start: 1, end: printed.end }] },
      { file: PAGE, ranges: [{ start: 90, end: 110 }] },
    ]);
    expect(s.sourceLinesRead).toBe(printed.end + 21);
    expect(s.level).toBe("targeted"); // reads exist, no leads
  });

  it("C'. failed or refused reads never count", () => {
    const l = ledger(["read_repo_file", { path: PAGE }, "Rejected: path traversal is not allowed. Nothing was read."]);
    expect(buildScope(l.all(), { listRepoCalls: 0, searchCalls: 0 }).sourceReads).toEqual([]);
  });

  it("D. a search hit outside the read range stays an unread lead; a covered cluster does not", () => {
    const l = ledger(search("stateField", SYMBOL_HITS), read(PAGE, 2113, 1, 100));
    const s = buildScope(l.all(), { listRepoCalls: 3, searchCalls: 1 });
    expect(s.level).toBe("partial");
    expect(s.inspectedClusters).toBe(1); // the declaration at 57
    expect(s.unreadLeads).toEqual([
      { file: PAGE, start: 123, end: 204, hits: 7, queries: ["stateField"] },
      { file: PAGE, start: 581, end: 581, hits: 1, queries: ["stateField"] },
    ]);
  });

  it("F. reading the lead clusters makes the scope targeted", () => {
    const l = ledger(search("stateField", SYMBOL_HITS), read(PAGE, 2113, 40, 220), read(PAGE, 2113, 560, 600));
    const s = buildScope(l.all(), { listRepoCalls: 0, searchCalls: 1 });
    expect(s).toMatchObject({ level: "targeted", unreadLeads: [], inspectedClusters: 3 });
  });

  it("clustering: hits more than CLUSTER_GAP_LINES apart are separate code areas", () => {
    const hits: [string, number, string][] = [[PAGE, 100, "x"], [PAGE, 100 + CLUSTER_GAP_LINES, "x"], [PAGE, 100 + 2 * CLUSTER_GAP_LINES + 1, "x"]];
    const s = buildScope(ledger(search("x1", hits)).all(), { listRepoCalls: 0, searchCalls: 1 });
    expect(s.unreadLeads.map((x) => `${x.start}-${x.end}`)).toEqual(["100-140", "181-181"]);
  });

  it("broad or capped searches, docs and non-code files create no leads", () => {
    const many: [string, number, string][] = Array.from({ length: SPECIFIC_SEARCH_MAX_HITS + 1 }, (_, i) => [PAGE, i * 100 + 1, "m"]);
    const mixed: [string, number, string][] = [["docs/ARCHITECTURE.md", 5, "sym"], ["README.md", 2, "sym"], ["pubspec.lock", 3, "sym"], ["lib/a.dart", 9, "sym"]];
    const capped = searchOut("capped", [[PAGE, 5, "c"]]).replace("\n\nOpen a location", "\n… 70 more match(es) not shown — narrow the path or use a more specific query.\n\nOpen a location");
    const s = buildScope(ledger(search("m", many), search("sym", mixed), ["search_code", { query: "capped" }, capped]).all(), { listRepoCalls: 0, searchCalls: 3 });
    expect(s.unreadLeads).toEqual([{ file: "lib/a.dart", start: 9, end: 9, hits: 1, queries: ["sym"] }]);
    expect(isCodeFile("docs/x.dart")).toBe(false);
    expect(isCodeFile("lib/x.dart")).toBe(true);
  });

  it("ranking: lib/ before other code before test/, then by hit count; hits merge across queries", () => {
    const l = ledger(
      search("a", [["test/models_test.dart", 6, "t"], ["test/models_test.dart", 8, "t"], ["test/models_test.dart", 9, "t"]]),
      search("b", [["tool/gen.dart", 1, "g"], ["lib/core/x.dart", 13, "d"], [PAGE, 123, "p"]]),
      search("c", [[PAGE, 155, "p"], ["lib/core/x.dart", 13, "d"]]),
    );
    const s = buildScope(l.all(), { listRepoCalls: 0, searchCalls: 3 });
    expect(s.unreadLeads.map((x) => `${x.file}:${x.start}-${x.end}:${x.hits}`)).toEqual([
      `${PAGE}:123-155:2`,
      "lib/core/x.dart:13-13:1",
      "tool/gen.dart:1-1:1",
      "test/models_test.dart:6-9:3",
    ]);
    expect(s.unreadLeads[1].queries).toEqual(["b", "c"]);
  });

  it("N. the scope comes from tool history only, never from what the model says", () => {
    const l = ledger(search("stateField", SYMBOL_HITS), read(PAGE, 2113, 1, 100));
    const s = buildScope(l.all(), { listRepoCalls: 0, searchCalls: 1 });
    // The model can claim anything; the recorded scope does not move.
    expect(detectOverclaim("I read feature_page.dart in full and reviewed the entire codebase.", s)).not.toBeNull();
    expect(scopeLine(s, null)).toContain("source read: feature_page.dart 1–100");
    expect(scopeLine(s, null)).toContain("unread leads: feature_page.dart 123–204; feature_page.dart 581");
  });
});

describe("Dart import/export-only hits are not leads by themselves", () => {
  const IMPORTS: [string, number, string][] = [
    ["lib/a/one_page.dart", 3, "import '../widgets/some_widget.dart';"],
    ["lib/b/two_repository.dart", 5, `import "package:app/core/some_widget.dart" as sw;`],
    ["lib/c/three.dart", 1, "import 'some_widget.dart' show SomeWidget, otherThing;"],
    ["test/four_test.dart", 2, "import 'package:app/some_widget.dart' hide Foo; // test"],
    ["lib/d/five.dart", 4, "import 'stub.dart' if (dart.library.io) 'io_widget.dart' deferred as w;"],
  ];
  const EXPORTS: [string, number, string][] = [
    ["lib/some_lib.dart", 1, "export 'src/some_widget.dart';"],
    ["lib/barrel.dart", 7, `export "../some_widget.dart" show SomeWidget;`],
  ];
  const scopeOf = (...outs: [string, Record<string, unknown>, string][]) => buildScope(ledger(...outs).all(), { listRepoCalls: 0, searchCalls: outs.length });

  it("1. import-only search hits create no unread leads", () => {
    const s = scopeOf(search("some_widget", IMPORTS));
    expect(s.unreadLeads).toEqual([]);
    expect(s.level).toBe("discovery-only"); // still discovery, never inspection
    for (const [f, , t] of IMPORTS) expect(isImportExportOnlyHit(f, t)).toBe(true);
  });

  it("2. export-only search hits create no unread leads", () => {
    const s = scopeOf(search("some_widget", EXPORTS));
    expect(s.unreadLeads).toEqual([]);
    for (const [f, , t] of EXPORTS) expect(isImportExportOnlyHit(f, t)).toBe(true);
  });

  it("3. a mix still creates leads for the implementation hits (same file keeps its real clusters)", () => {
    const f = "lib/feature/foo_page.dart";
    const s = scopeOf(
      search("foo", [
        [f, 10, "import '../foo.dart';"],
        [f, 11, "export 'foo_view.dart';"],
        [f, 50, "final foo = Foo();"],
        [f, 80, "foo.doSomething();"],
        [f, 200, "if (foo.isReady) return;"],
        ...IMPORTS,
      ]),
    );
    expect(s.unreadLeads).toEqual([
      { file: f, start: 50, end: 80, hits: 2, queries: ["foo"] },
      { file: f, start: 200, end: 200, hits: 1, queries: ["foo"] },
    ]);
  });

  it("normal code that mentions import/export or the term is never excluded", () => {
    const keep = [
      "final importPath = '../foo.dart';",
      "exportReport(foo);",
      "await importer.import('foo.dart');",
      "// import '../foo.dart';",
      "import 'package:app/foo.dart'", // multi-line directive continues on the next line
      "import 'package:app/foo.dart' show Foo, Bar, Baz, Qux, Quux, Corge, Grault, Garply, Waldo, Fred, Plugh, Xyzzy, Thud, W …", // truncated row
      "import 'x.dart'; final foo = 1;",
    ];
    for (const t of keep) expect(isImportExportOnlyHit("lib/x.dart", t)).toBe(false);
    // The rule is Dart-only: a TypeScript import stays a normal hit.
    expect(isImportExportOnlyHit("lib/x.ts", "import { foo } from './foo';")).toBe(false);
    expect(isImportExportOnlyHit("lib/x.ts", "import './foo';")).toBe(false);
    const s = scopeOf(search("foo", keep.slice(0, 3).map((t, i) => ["lib/x.dart", 100 * (i + 1), t] as [string, number, string])));
    expect(s.unreadLeads).toHaveLength(3);
  });

  it("4. reading the implementation range marks that cluster inspected exactly as before", () => {
    const f = "lib/feature/foo_page.dart";
    const hits: [string, number, string][] = [[f, 10, "import '../foo.dart';"], [f, 50, "final foo = Foo();"], [f, 80, "foo.doSomething();"], [f, 200, "if (foo.isReady) return;"]];
    const partial = scopeOf(search("foo", hits), read(f, 400, 45, 85));
    expect(partial).toMatchObject({ level: "partial", inspectedClusters: 1 });
    expect(partial.unreadLeads).toEqual([{ file: f, start: 200, end: 200, hits: 1, queries: ["foo"] }]);
    expect(partial.sourceReads).toEqual([{ file: f, ranges: [{ start: 45, end: 85 }] }]);
    const full = scopeOf(search("foo", hits), read(f, 400, 45, 85), read(f, 400, 190, 210));
    expect(full).toMatchObject({ level: "targeted", unreadLeads: [], inspectedClusters: 2 });
    // Reading only the import line covers nothing: it was never a lead.
    const importOnly = scopeOf(search("foo", hits), read(f, 400, 1, 20));
    expect(importOnly.inspectedClusters).toBe(0);
    expect(importOnly.unreadLeads.map((x) => `${x.start}-${x.end}`)).toEqual(["50-80", "200-200"]);
  });

  it("5. the _filterCity-style symbol clustering is unchanged (with extra import hits in other files)", () => {
    const s = scopeOf(search("stateField", [...SYMBOL_HITS, ...IMPORTS]));
    expect(s.unreadLeads).toEqual([
      { file: PAGE, start: 123, end: 204, hits: 7, queries: ["stateField"] },
      { file: PAGE, start: 57, end: 57, hits: 1, queries: ["stateField"] },
      { file: PAGE, start: 581, end: 581, hits: 1, queries: ["stateField"] },
    ]);
    const d = scopeOf(search("stateField", SYMBOL_HITS), read(PAGE, 2113, 1, 100));
    expect(d.inspectedClusters).toBe(1);
    expect(d.unreadLeads.map((x) => `${x.start}-${x.end}`)).toEqual(["123-204", "581-581"]);
  });

  it("6. broad or capped searches still create no leads, imports or not", () => {
    const many: [string, number, string][] = Array.from({ length: SPECIFIC_SEARCH_MAX_HITS + 1 }, (_, i) => [PAGE, i * 100 + 1, `final foo${i} = 1;`]);
    const capped = searchOut("capped", [[PAGE, 5, "final foo = 1;"]]).replace("\n\nOpen a location", "\n… 70 more match(es) not shown — narrow the path or use a more specific query.\n\nOpen a location");
    const s = scopeOf(search("many", many), ["search_code", { query: "capped" }, capped]);
    expect(s.unreadLeads).toEqual([]);
  });
});

describe("overclaims (fixed regexes)", () => {
  const partial = buildScope(ledger(search("stateField", SYMBOL_HITS), read(PAGE, 2113, 1, 100)).all(), { listRepoCalls: 3, searchCalls: 1 });
  const dbOnly = buildScope(ledger(["db_read", { sql: "select 1" }, '[{"n":1}]']).all(), { listRepoCalls: 0, searchCalls: 0 });
  const discovery = buildScope([], { listRepoCalls: 4, searchCalls: 2 });
  const targeted = buildScope(ledger(search("stateField", SYMBOL_HITS), read(PAGE, 2113, 40, 220), read(PAGE, 2113, 560, 600)).all(), { listRepoCalls: 0, searchCalls: 1 });

  it("E. broad claims after only a small/unrelated read are overclaims (the real runs' wording)", () => {
    for (const t of [
      "I have completed a thorough inspection of the live database state, repository architecture, and codebase.",
      "I have completed a focused investigation of the FootRank Flutter codebase and live database state.",
      "All systems checked and verified.",
      "No issues exist anywhere in the entire app.",
      "Codebase & Architecture Inspection: checked the filters.",
    ]) expect(detectOverclaim(t, partial)).toMatchObject({ kind: "broad-scope" });
  });

  it("claims of code inspection with no source read at all are overclaims", () => {
    expect(detectOverclaim("I reviewed the implementation of the repository layer.", discovery)).toMatchObject({ kind: "code-inspection-without-reading" });
    expect(detectOverclaim("Checked the source for the ranking logic.", dbOnly)).toMatchObject({ kind: "code-inspection-without-reading" });
  });

  it("G/H. honest, scope-limited conclusions are not overclaims", () => {
    for (const [t, s] of [
      ["I found nothing new in feature_page.dart lines 1–100. I did not inspect lines 123–204.", partial],
      ["Nothing new in the database queries I ran; I did not read any source code.", dbOnly],
      ["Only read feature_page.dart lines 1–100, so the rest of the codebase was not inspected.", partial],
      ["Live data: 19 users, 6 teams, no new issue in the tables I queried.", dbOnly],
      ["Nothing new in feature_page.dart lines 40–220 and 560–600.", targeted],
    ] as const) expect(detectOverclaim(t, s)).toBeNull();
  });

  it("a targeted scope may describe the code it actually read", () => {
    expect(detectOverclaim("I reviewed the implementation in feature_page.dart and it is correct.", targeted)).toBeNull();
  });
});

describe("follow-up and scope records", () => {
  const partial = buildScope(ledger(search("stateField", SYMBOL_HITS), read(PAGE, 2113, 1, 100)).all(), { listRepoCalls: 3, searchCalls: 1 });

  it("the follow-up is built from recorded facts and names the unread code", () => {
    const m = followUpMessage(partial, true, { kind: "broad-scope", phrase: "codebase" });
    expect(m).toContain("search_code and list_repo are discovery only");
    expect(m).toContain(`${PAGE} lines 123–204 (7 hits for "stateField")`);
    expect(m).toContain("Read the relevant implementation with read_repo_file, or conclude and state plainly that it was not inspected.");
    expect(m).toContain('("codebase")');
  });

  it("J. the follow-up never says or implies that a finding is required", () => {
    for (const m of [followUpMessage(partial, true, null), followUpMessage(partial, false, { kind: "broad-scope", phrase: "entire" })]) {
      expect(m).toContain("You are not required to submit a finding.");
      expect(m).toContain('"Nothing new in <the scope you actually covered>" is a valid conclusion.');
      const withoutDisclaimer = m.replace("You are not required to submit a finding.", "");
      expect(withoutDisclaimer).not.toMatch(/\b(must|should|need to|required to|have to)\b[^.\n]{0,30}\b(submit|save|report|find)\b/i);
      expect(withoutDisclaimer).not.toMatch(/\b(bug|finding|issue|defect)s? (is|are) (expected|required)/i);
      expect(m).not.toMatch(/save_suggestion/);
    }
  });

  it("scope line and audit detail are compact and deterministic", () => {
    const line = scopeLine(partial, { kind: "broad-scope", phrase: "codebase" });
    expect(line).toBe("[Scope recorded by Mission Control: level partial · DB queries 0, stats 0 · discovery: list_repo 3, search_code 1 · source read: feature_page.dart 1–100 · unread leads: feature_page.dart 123–204; feature_page.dart 581 · ⚠ scope claim not supported by tool history]");
    expect(line.length).toBeLessThan(300);
    expect(JSON.parse(scopeDetail(partial, null, 1))).toMatchObject({ v: 1, level: "partial", listRepo: 3, search: 1, linesRead: 100, followUps: 1, overclaim: null, unreadLeads: [{ start: 123, end: 204, hits: 7 }, { start: 581 }] });
  });
});
