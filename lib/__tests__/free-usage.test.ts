import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: { op: string; args: unknown[] }[] = [];
let countResult: { count: number | null; error: { message: string } | null } = { count: 0, error: null };
let insertResult: { data: { id: string } | null; error: { message: string } | null } = { data: { id: "r1" }, error: null };
function chain() {
  const c: Record<string, (...a: unknown[]) => unknown> = {};
  for (const op of ["select", "eq", "gte", "insert", "update", "single"]) {
    c[op] = (...args: unknown[]) => {
      calls.push({ op, args });
      if (op === "gte") return Promise.resolve(countResult);
      if (op === "single") return Promise.resolve(insertResult);
      if (op === "eq" && calls.some((x) => x.op === "update")) return Promise.resolve({ error: null });
      return c;
    };
  }
  (c as unknown as { then?: unknown }).then = undefined;
  return c;
}
vi.mock("../supabase", () => ({
  supabaseAdmin: {
    from: (t: string) => {
      calls.push({ op: "from", args: [t] });
      const c = chain();
      // markExhausted awaits insert() directly
      const origInsert = c.insert;
      c.insert = (...a: unknown[]) => {
        const r = origInsert(...a) as Record<string, unknown>;
        return Object.assign(Promise.resolve({ error: null }), r);
      };
      return c;
    },
  },
}));

import { supabaseFreeUsageStore as store, quotaDayStart, usageRowModel, exhaustedRowModel } from "../free-usage";

beforeEach(() => {
  calls.length = 0;
  countResult = { count: 0, error: null };
  insertResult = { data: { id: "r1" }, error: null };
});

describe("quotaDayStart (28: consistent calendar day)", () => {
  it("is the earlier of Pacific and UTC midnight (never under-counts)", () => {
    // 15:00 UTC on 26 Sep = 08:00 PDT: Pacific day started 07:00 UTC, UTC day at 00:00 -> 00:00 UTC.
    expect(quotaDayStart(new Date("2026-09-26T15:00:00Z")).toISOString()).toBe("2026-09-26T00:00:00.000Z");
    // 03:00 UTC on 27 Sep = 20:00 PDT on 26 Sep: Pacific day started 26 Sep 07:00 UTC (earlier than UTC midnight 27 Sep).
    expect(quotaDayStart(new Date("2026-09-27T03:00:00Z")).toISOString()).toBe("2026-09-26T07:00:00.000Z");
    // Winter (PST, UTC-8)
    expect(quotaDayStart(new Date("2026-12-10T05:00:00Z")).toISOString()).toBe("2026-12-09T08:00:00.000Z");
  });
  it("is stable within the same window and moves forward across days", () => {
    const a = quotaDayStart(new Date("2026-09-26T10:00:00Z"));
    const b = quotaDayStart(new Date("2026-09-26T20:00:00Z"));
    const c = quotaDayStart(new Date("2026-09-28T10:00:00Z"));
    expect(a.getTime()).toBeLessThanOrEqual(b.getTime());
    expect(c.getTime()).toBeGreaterThan(b.getTime());
  });
});

describe("supabase usage store (usage_log, no schema change)", () => {
  it("row names are provider/model only", () => {
    expect(usageRowModel("gemini:gemini-3.5-flash-lite")).toBe("free:gemini:gemini-3.5-flash-lite");
    expect(exhaustedRowModel("gemini:gemini-3.8-flash")).toBe("free-exhausted:gemini:gemini-3.8-flash");
  });

  it("counts today's requests for exactly one model", async () => {
    countResult = { count: 7, error: null };
    const since = new Date("2026-09-26T00:00:00Z");
    expect(await store.countRequestsSince("gemini:gemini-3.5-flash-lite", since)).toBe(7);
    expect(calls).toContainEqual({ op: "from", args: ["usage_log"] });
    expect(calls).toContainEqual({ op: "eq", args: ["model", "free:gemini:gemini-3.5-flash-lite"] });
    expect(calls).toContainEqual({ op: "gte", args: ["created_at", since.toISOString()] });
  });

  it("throws (fail closed) when the count is unavailable", async () => {
    countResult = { count: null, error: { message: "connection refused" } };
    await expect(store.countRequestsSince("gemini:gemini-3.5-flash-lite", new Date())).rejects.toThrow(/unavailable/);
    countResult = { count: null, error: null };
    await expect(store.countRequestsSince("gemini:gemini-3.5-flash-lite", new Date())).rejects.toThrow(/unavailable/);
    countResult = { count: null, error: { message: "x" } };
    await expect(store.isExhaustedSince("gemini:gemini-3.5-flash-lite", new Date())).rejects.toThrow(/unavailable/);
  });

  it("25/26/27. reserve inserts cost 0 with provider/model only — no prompt, no key", async () => {
    expect(await store.reserve("gemini:gemini-3.5-flash-lite")).toBe("r1");
    const insert = calls.find((c) => c.op === "insert")!;
    expect(insert.args[0]).toEqual({ model: "free:gemini:gemini-3.5-flash-lite", input_tokens: 0, output_tokens: 0, cost: 0 });
  });

  it("reserve throws when the insert fails", async () => {
    insertResult = { data: null, error: { message: "rls" } };
    await expect(store.reserve("gemini:gemini-3.8-flash")).rejects.toThrow(/reservation failed/);
  });

  it("complete writes token counts with cost 0", async () => {
    await store.complete("r1", { inputTokens: 12.4, outputTokens: 3 });
    const update = calls.find((c) => c.op === "update")!;
    expect(update.args[0]).toEqual({ input_tokens: 12, output_tokens: 3, cost: 0 });
  });

  it("markExhausted writes a cost-0 marker row", async () => {
    await store.markExhausted("gemini:gemini-3.8-flash");
    const insert = calls.find((c) => c.op === "insert")!;
    expect(insert.args[0]).toEqual({ model: "free-exhausted:gemini:gemini-3.8-flash", cost: 0 });
  });
});
