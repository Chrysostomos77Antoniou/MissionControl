import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  stableStringify,
  fingerprintTotals,
  fingerprintSuggestions,
  sourcesFor,
  buildSourceHashes,
  classify,
  detect,
  shouldRun,
  parseBaseline,
  serializeBaseline,
  makeBaseline,
  MAX_BASELINE_AGE_MS,
  TOTALS_AGENTS,
  BASELINE_ACTION,
  type FootrankTotals,
  type OpenSuggestionState,
  type Baseline,
} from "../change-detect";
import { AGENTS } from "../../agents/registry";

const T0 = Date.parse("2026-09-27T09:00:00.000Z");
const totals: FootrankTotals = { users: 19, matches: 12, teams: 6, behavior_reports: 36, notifications: 373 };
const open: OpenSuggestionState[] = [
  { id: "b", status: "new", priority: "high", title: "RLS missing" },
  { id: "a", status: "new", priority: "low", title: "Add index" },
];
const hashes = (agent: Parameters<typeof sourcesFor>[0], t: FootrankTotals | null = totals, o: OpenSuggestionState[] | null = open) => {
  const b = buildSourceHashes(agent, { totals: t, openSuggestions: o });
  if (!b.ok) throw new Error(b.detail);
  return b.sources;
};
const baselineOf = (agent: Parameters<typeof sourcesFor>[0], atMs = T0, t = totals, o = open): Baseline => makeBaseline(agent, hashes(agent, t, o), new Date(atMs));

describe("fingerprints", () => {
  it("stableStringify ignores object key order", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).toBe(stableStringify({ a: { c: [3, { e: 2, f: 1 }], d: 2 }, b: 1 }));
  });

  it("totals: same data with different key order -> same fingerprint; 64-hex SHA-256", () => {
    const shuffled = { notifications: 373, teams: 6, users: 19, behavior_reports: 36, matches: 12 };
    expect(fingerprintTotals(shuffled)).toBe(fingerprintTotals(totals));
    expect(fingerprintTotals(totals)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(["users", "matches", "teams", "behavior_reports", "notifications"] as const)("totals: a changed %s count -> different fingerprint", (k) => {
    expect(fingerprintTotals({ ...totals, [k]: totals[k] + 1 })).not.toBe(fingerprintTotals(totals));
  });

  it("totals: malformed counts are an error, never a fingerprint", () => {
    expect(() => fingerprintTotals({ ...totals, users: -1 })).toThrow();
    expect(() => fingerprintTotals({ ...totals, users: 1.5 })).toThrow();
    expect(() => fingerprintTotals({ ...totals, users: undefined as unknown as number })).toThrow();
  });

  it("open suggestions: row order and key order do not matter", () => {
    const reordered = [{ title: "Add index", priority: "low", status: "new", id: "a" }, { priority: "high", id: "b", title: "RLS missing", status: "new" }];
    expect(fingerprintSuggestions(reordered)).toBe(fingerprintSuggestions(open));
  });

  it("open suggestions: a changed title, priority or status, or an added/removed row -> different fingerprint", () => {
    const base = fingerprintSuggestions(open);
    expect(fingerprintSuggestions([{ ...open[0], title: "RLS missing on matches" }, open[1]])).not.toBe(base);
    expect(fingerprintSuggestions([{ ...open[0], priority: "medium" }, open[1]])).not.toBe(base);
    expect(fingerprintSuggestions([{ ...open[0], status: "done" }, open[1]])).not.toBe(base);
    expect(fingerprintSuggestions([open[0]])).not.toBe(base);
    expect(fingerprintSuggestions([...open, { id: "c", status: "new", priority: "low", title: "x" }])).not.toBe(base);
    expect(fingerprintSuggestions([])).not.toBe(base);
  });

  it("open suggestions: fields that do not reach the prompt are ignored", () => {
    const withExtras = open.map((r) => ({ ...r, body: "long text", created_at: "2026-01-01" }));
    expect(fingerprintSuggestions(withExtras)).toBe(fingerprintSuggestions(open));
  });

  it("the totals and open-suggestion hashes are domain-separated", () => {
    expect(fingerprintSuggestions([])).not.toBe(fingerprintTotals({ users: 0, matches: 0, teams: 0, behavior_reports: 0, notifications: 0 }));
  });
});

describe("source applicability", () => {
  it("FootRank totals apply to growth, marketing, community, devops only; open suggestions to every agent", () => {
    expect([...TOTALS_AGENTS].sort()).toEqual(["community", "devops", "growth", "marketing"]);
    for (const a of AGENTS) {
      expect(sourcesFor(a.id)).toContain("open_suggestions");
      expect(sourcesFor(a.id).includes("footrank_totals")).toBe(TOTALS_AGENTS.has(a.id));
    }
  });

  it("an agent without the totals source never needs (or reads) totals", () => {
    const b = buildSourceHashes("engineering", { totals: null, openSuggestions: open });
    expect(b.ok).toBe(true);
    expect(Object.keys((b as { sources: object }).sources)).toEqual(["open_suggestions"]);
  });

  it("a required source that could not be read is an error", () => {
    expect(buildSourceHashes("growth", { totals: null, openSuggestions: open })).toEqual({ ok: false, detail: "footrank_totals unavailable" });
    expect(buildSourceHashes("engineering", { openSuggestions: null })).toEqual({ ok: false, detail: "open_suggestions unavailable" });
    expect(buildSourceHashes("growth", { totals: { ...totals, users: -3 }, openSuggestions: open }).ok).toBe(false);
  });
});

describe("classification", () => {
  it("missing baseline -> missing (UNKNOWN -> run), never unchanged", () => {
    const d = classify("growth", hashes("growth"), null, T0);
    expect(d.kind).toBe("missing");
    expect(shouldRun(d)).toBe(true);
  });

  it("identical inputs, young baseline -> unchanged (no run)", () => {
    const d = classify("growth", hashes("growth"), baselineOf("growth"), T0 + 60_000);
    expect(d).toMatchObject({ kind: "unchanged", ageMs: 60_000 });
    expect(shouldRun(d)).toBe(false);
  });

  it("changed FootRank totals -> changed", () => {
    const d = classify("growth", hashes("growth", { ...totals, users: 20 }), baselineOf("growth"), T0 + 1);
    expect(d).toMatchObject({ kind: "changed", changed: ["footrank_totals"] });
  });

  it("changed open suggestions -> changed", () => {
    const d = classify("engineering", hashes("engineering", totals, [open[0]]), baselineOf("engineering"), T0 + 1);
    expect(d).toMatchObject({ kind: "changed", changed: ["open_suggestions"] });
  });

  it("a baseline lacking a now-required source counts as changed", () => {
    const old = makeBaseline("growth", { open_suggestions: hashes("growth").open_suggestions }, new Date(T0));
    expect(classify("growth", hashes("growth"), old, T0 + 1)).toMatchObject({ kind: "changed", changed: ["footrank_totals"] });
  });

  it("7-day boundary: 7 days minus 1 ms is unchanged; exactly 7 days is stale", () => {
    expect(MAX_BASELINE_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(classify("legal", hashes("legal"), baselineOf("legal"), T0 + MAX_BASELINE_AGE_MS - 1).kind).toBe("unchanged");
    const d = classify("legal", hashes("legal"), baselineOf("legal"), T0 + MAX_BASELINE_AGE_MS);
    expect(d.kind).toBe("stale");
    expect(shouldRun(d)).toBe(true);
    expect(classify("legal", hashes("legal"), baselineOf("legal"), T0 + 30 * 86_400_000).kind).toBe("stale");
  });

  it("detect(): an unreadable baseline or source is an error, never unchanged or missing", () => {
    expect(detect("growth", { totals, openSuggestions: open }, { ok: false, detail: "timeout" }, T0)).toEqual({ kind: "error", detail: "baseline unavailable: timeout" });
    const e = detect("growth", { totals: null, openSuggestions: open }, { ok: true, baseline: baselineOf("growth") }, T0 + 1);
    expect(e.kind).toBe("error");
    expect(shouldRun(e)).toBe(false);
    expect(detect("growth", { totals, openSuggestions: open }, { ok: true, baseline: baselineOf("growth") }, T0 + 1).kind).toBe("unchanged");
  });

  it("shouldRun: only missing / changed / stale", () => {
    expect(shouldRun({ kind: "missing", sources: {} })).toBe(true);
    expect(shouldRun({ kind: "changed", sources: {}, changed: ["open_suggestions"] })).toBe(true);
    expect(shouldRun({ kind: "stale", sources: {}, ageMs: 1 })).toBe(true);
    expect(shouldRun({ kind: "unchanged", sources: {}, ageMs: 1 })).toBe(false);
    expect(shouldRun({ kind: "error", detail: "x" })).toBe(false);
  });
});

describe("baseline storage format", () => {
  it("round-trips through the activity-log detail string", () => {
    expect(BASELINE_ACTION).toBe("cycle:baseline");
    const b = baselineOf("growth");
    const s = serializeBaseline(b);
    expect(JSON.parse(s)).toEqual({ v: 1, agent: "growth", at: new Date(T0).toISOString(), sources: b.sources });
    expect(parseBaseline("growth", s)).toEqual(b);
  });

  it("anything unreadable is treated as NO baseline (-> run), never as unchanged", () => {
    expect(parseBaseline("growth", null)).toBeNull();
    expect(parseBaseline("growth", "not json")).toBeNull();
    expect(parseBaseline("growth", serializeBaseline(baselineOf("devops")))).toBeNull(); // another agent's row
    expect(parseBaseline("growth", JSON.stringify({ ...baselineOf("growth"), v: 2 }))).toBeNull();
    expect(parseBaseline("growth", JSON.stringify({ ...baselineOf("growth"), at: "yesterday" }))).toBeNull();
  });

  it("only deterministic hashes are accepted; any other content (e.g. model text) is dropped", () => {
    const raw = JSON.stringify({ ...baselineOf("growth"), summary: "Engagement is 6%", sources: { open_suggestions: "Engagement is 6%", footrank_totals: hashes("growth").footrank_totals } });
    const b = parseBaseline("growth", raw)!;
    expect(b).not.toHaveProperty("summary");
    expect(b.sources).toEqual({ footrank_totals: hashes("growth").footrank_totals });
    // ...so the tampered row can only ever cause a run, never a skip
    expect(classify("growth", hashes("growth"), b, T0 + 1).kind).toBe("changed");
  });
});

describe("purity", () => {
  it("no environment reads, network, database, clock or model access", () => {
    const src = readFileSync(join(__dirname, "..", "change-detect.ts"), "utf8");
    expect(src).not.toMatch(/process\.env|fetch\(|supabase|free-llm|Date\.now|new Date\(\)|from "\.\.?\/(tools|agents)/);
    expect(src).toMatch(/from "node:crypto"/);
  });
});
