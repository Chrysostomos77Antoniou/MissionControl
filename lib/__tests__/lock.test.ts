import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// In-memory stand-in for the live `agent_locks` table: agent text PRIMARY KEY,
// started_at timestamptz. Implements only the query shapes lib/lock.ts uses.
const db = vi.hoisted(() => {
  type Row = { agent: string; started_at: string };
  type Err = { code?: string; message: string } | null;
  const state = {
    rows: new Map<string, Row>(),
    deleteError: null as Err,
    insertError: null as Err,
    throwOnInsert: false,
  };
  function del() {
    const filters: ((r: Row) => boolean)[] = [];
    let returning = false;
    const q = {
      eq(col: keyof Row, v: string) {
        filters.push((r) => r[col] === v);
        return q;
      },
      lt(col: keyof Row, v: string) {
        filters.push((r) => r[col] < v);
        return q;
      },
      select() {
        returning = true;
        return q;
      },
      then(resolve: (x: unknown) => void) {
        if (state.deleteError) return resolve({ data: null, error: state.deleteError });
        const removed = [...state.rows.values()].filter((r) => filters.every((f) => f(r)));
        for (const r of removed) state.rows.delete(r.agent);
        resolve({ data: returning ? removed.map((r) => ({ agent: r.agent })) : null, error: null });
      },
    };
    return q;
  }
  const client = {
    from(table: string) {
      if (table !== "agent_locks") throw new Error(`unexpected table ${table}`);
      return {
        delete: del,
        insert(row: Row) {
          if (state.throwOnInsert) throw new Error("network down");
          if (state.insertError) return Promise.resolve({ error: state.insertError });
          if (state.rows.has(row.agent)) return Promise.resolve({ error: { code: "23505", message: "duplicate key value violates unique constraint" } });
          state.rows.set(row.agent, { ...row });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { state, client };
});
vi.mock("../supabase", () => ({ supabaseAdmin: db.client }));

import {
  acquireLock,
  releaseLock,
  acquireAgentLock,
  releaseAgentLock,
  acquireCycleLock,
  releaseCycleLock,
  AGENT_LOCK_TTL_MS,
  CYCLE_LOCK_TTL_MS,
  CYCLE_LOCK_KEY,
} from "../lock";
import { MAX_LOOP_MS, MAX_ROUTER_CALL_MS, LOOP_DEADLINE_MS, MAX_TOOL_CALLS_PER_TURN, TOOL_TIMEOUT_MS } from "../../agents/free-loop";

const T0 = new Date("2026-09-26T10:00:00.000Z");
const at = (ms: number) => () => new Date(T0.getTime() + ms);

beforeEach(() => {
  db.state.rows.clear();
  db.state.deleteError = null;
  db.state.insertError = null;
  db.state.throwOnInsert = false;
});

describe("run locks (6a)", () => {
  it("acquire succeeds on a free key and returns its owner token", async () => {
    const r = await acquireAgentLock("growth", at(0));
    expect(r).toEqual({ status: "acquired", token: T0.toISOString() });
    expect(db.state.rows.get("growth")).toEqual({ agent: "growth", started_at: T0.toISOString() });
  });

  it("contention: a live lock is reported as held", async () => {
    await acquireAgentLock("growth", at(0));
    expect(await acquireAgentLock("growth", at(60_000))).toEqual({ status: "held" });
    expect(await acquireAgentLock("devops", at(60_000))).toMatchObject({ status: "acquired" }); // per key
  });

  it("the owner releases with its token", async () => {
    const r = await acquireAgentLock("growth", at(0));
    expect(r.status).toBe("acquired");
    expect(await releaseAgentLock("growth", (r as { token: string }).token)).toBe(true);
    expect(db.state.rows.has("growth")).toBe(false);
  });

  it("a wrong owner token releases nothing", async () => {
    await acquireAgentLock("growth", at(0));
    expect(await releaseAgentLock("growth", "2026-09-26T09:59:59.999Z")).toBe(false);
    expect(db.state.rows.has("growth")).toBe(true);
  });

  it("a lock younger than the TTL is not stale; one older than the TTL is taken over", async () => {
    await acquireAgentLock("growth", at(0));
    expect(await acquireAgentLock("growth", at(AGENT_LOCK_TTL_MS - 1))).toEqual({ status: "held" });
    const r = await acquireAgentLock("growth", at(AGENT_LOCK_TTL_MS + 1));
    expect(r).toEqual({ status: "acquired", token: new Date(T0.getTime() + AGENT_LOCK_TTL_MS + 1).toISOString() });
  });

  it("the old owner cannot release the lock a newer run acquired after takeover", async () => {
    const old = (await acquireAgentLock("growth", at(0))) as { token: string };
    const fresh = (await acquireAgentLock("growth", at(AGENT_LOCK_TTL_MS + 1))) as { token: string };
    expect(await releaseAgentLock("growth", old.token)).toBe(false);
    expect(db.state.rows.get("growth")?.started_at).toBe(fresh.token);
    expect(await releaseAgentLock("growth", fresh.token)).toBe(true);
  });

  it("a database error is reported as an error, never as normal contention", async () => {
    db.state.insertError = { code: "08006", message: "connection failure" };
    expect(await acquireAgentLock("growth", at(0))).toEqual({ status: "error", detail: "connection failure" });
    db.state.insertError = null;
    db.state.deleteError = { message: "permission denied for table agent_locks" };
    expect(await acquireAgentLock("growth", at(0))).toEqual({ status: "error", detail: "stale-lock cleanup failed: permission denied for table agent_locks" });
    db.state.deleteError = null;
    db.state.throwOnInsert = true;
    expect(await acquireAgentLock("growth", at(0))).toEqual({ status: "error", detail: "network down" });
  });

  it("release reports failure (false) when the delete errors", async () => {
    const r = (await acquireAgentLock("growth", at(0))) as { token: string };
    db.state.deleteError = { message: "timeout" };
    expect(await releaseAgentLock("growth", r.token)).toBe(false);
  });

  it("the cycle lock uses the reserved key, is independent of agent locks, and has its own TTL", async () => {
    expect(CYCLE_LOCK_KEY).toBe("__cycle__");
    await acquireAgentLock("growth", at(0));
    const c = (await acquireCycleLock(at(0))) as { status: string; token: string };
    expect(c.status).toBe("acquired");
    expect(db.state.rows.has("__cycle__")).toBe(true);
    expect(await acquireCycleLock(at(AGENT_LOCK_TTL_MS + 1))).toEqual({ status: "held" }); // agent TTL does not apply
    expect(await acquireCycleLock(at(CYCLE_LOCK_TTL_MS + 1))).toMatchObject({ status: "acquired" });
    expect(await releaseCycleLock(c.token)).toBe(false); // old cycle owner
    expect(db.state.rows.has("growth")).toBe(true); // cycle lock never touches agent rows
  });

  it("generic acquireLock/releaseLock honour the TTL they are given", async () => {
    const r = (await acquireLock("devops", 1000, at(0))) as { token: string };
    expect(await acquireLock("devops", 1000, at(999))).toEqual({ status: "held" });
    expect(await acquireLock("devops", 1000, at(1001))).toMatchObject({ status: "acquired" });
    expect(await releaseLock("devops", r.token)).toBe(false);
  });

  it("the agent TTL exceeds the longest possible locked run (loop bound + grader call)", () => {
    expect(MAX_LOOP_MS).toBe(LOOP_DEADLINE_MS + MAX_ROUTER_CALL_MS + MAX_TOOL_CALLS_PER_TURN * TOOL_TIMEOUT_MS);
    expect(AGENT_LOCK_TTL_MS).toBeGreaterThan(MAX_LOOP_MS + MAX_ROUTER_CALL_MS);
    expect(CYCLE_LOCK_TTL_MS).toBeGreaterThan(AGENT_LOCK_TTL_MS);
  });

  it("MAX_ROUTER_CALL_MS covers the real provider timeouts (ollama + 2 x gemini, at most 3 attempts)", () => {
    const timeout = (f: string) => Number(/const DEFAULT_TIMEOUT_MS = ([\d_]+)/.exec(readFileSync(join(__dirname, "..", "providers", f), "utf8"))![1].replace(/_/g, ""));
    const ollama = timeout("ollama.ts");
    const gemini = timeout("gemini.ts");
    expect(Math.max(ollama + 2 * gemini, 3 * gemini)).toBeLessThanOrEqual(MAX_ROUTER_CALL_MS);
  });
});
