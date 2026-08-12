# Agent Eval Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Mission Control agent a measurable quality signal — an approval-rate computed from the owner's own `done`/`dismissed` decisions, plus an automated 1-5 grade on every single run — surfaced on that agent's detail page.

**Architecture:** One new Supabase table (`agent_evals`). Two new read/write helpers added to existing `lib/` files, following the exact patterns those files already use (`lib/consensus.ts`'s fire-and-forget Haiku-call-with-try/catch shape; `lib/memory.ts`'s simple insert/select shape). A single new call site inside `agents/run-agent.ts`'s `runAgent`, non-blocking. A small stats panel added to the existing (currently bare) `app/agents/[id]/page.tsx`.

**Tech Stack:** Next.js 16 / TypeScript, `@anthropic-ai/sdk` (Haiku model), Supabase (`supabaseAdmin`), Vitest (already installed, currently unused — see Global Constraints).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-12-agent-eval-loop-design.md` — every task below implements one section of it.
- **Testing convention for this codebase:** Vitest is installed (`npm test` → `vitest run`) but there are zero existing test files in `app/`, `lib/`, `agents/`, or `tools/` — every other feature in this project (`lib/consensus.ts`, `lib/usage.ts`, `lib/memory.ts`, `lib/health.ts`, `lib/lock.ts`, all built this session) was verified with `npx tsc --noEmit` + `npm run lint` + `npm run build` + a manual trigger, not unit tests, because they're thin wrappers around live Supabase/Anthropic calls with nothing pure to unit-test. This plan follows that same convention for every I/O function. The one exception is `computeApprovalRate` (Task 2) — genuinely pure logic (no I/O), the first real candidate for a Vitest test in this codebase, and it gets one.
- Match existing import style: relative paths (`../lib/x`, `./x`), no path aliases — copy the exact style of the file being edited.
- Supabase project id for migrations: `yspccychuwvlrjgioqss`.
- After every task: `npx tsc --noEmit`, then `npm run lint`, then `npm run build` — all three must be clean before moving to the next task (this project's established discipline, applied all session).

---

### Task 1: `agent_evals` table

**Files:**
- Create: `supabase/migrations/0003_agent_evals.sql`

**Interfaces:**
- Produces: table `agent_evals` with columns `id, agent, cycle_at, score, reasoning, suggestions_count, created_at` — every later task's Supabase calls depend on this existing.

- [ ] **Step 1: Write the migration file**

```sql
create table if not exists agent_evals (
  id uuid primary key default gen_random_uuid(),
  agent text not null,
  cycle_at timestamptz not null,
  score smallint not null check (score between 1 and 5),
  reasoning text not null,
  suggestions_count smallint not null default 0,
  created_at timestamptz default now()
);

create index if not exists idx_agent_evals_agent_cycle on agent_evals(agent, cycle_at desc);
```

- [ ] **Step 2: Apply the migration**

Use the Supabase `apply_migration` MCP tool with `project_id: "yspccychuwvlrjgioqss"`, `name: "agent_evals"`, and the SQL from Step 1 as `query`.

- [ ] **Step 3: Verify**

Use the Supabase `list_tables` MCP tool (or `execute_sql` with `select column_name, data_type from information_schema.columns where table_name = 'agent_evals'`) and confirm all 7 columns exist with the expected types.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0003_agent_evals.sql
git commit -m "Add agent_evals table for the agent eval loop"
```

---

### Task 2: Suggestion-based helpers in `lib/suggestions.ts`

**Files:**
- Modify: `lib/suggestions.ts`
- Create: `lib/__tests__/suggestions.test.ts`

**Interfaces:**
- Consumes: `supabaseAdmin` from `./supabase`, `AgentId`/`Suggestion` from `./types` (both already imported in this file).
- Produces:
  - `suggestionsSince(agent: AgentId, sinceIso: string): Promise<Suggestion[]>` — used by Task 4.
  - `computeApprovalRate(done: number, dismissed: number): number | null` — pure function, used by `agentApprovalStats` below.
  - `interface ApprovalStats { done: number; dismissed: number; rate: number | null }` — used by Task 5.
  - `agentApprovalStats(agent: AgentId, sinceIso: string): Promise<ApprovalStats>` — used by Task 5.

Note: this project's established test convention (see `tools/__tests__/registry.test.ts`) is a `__tests__` subdirectory, not a colocated `*.test.ts` file — follow that pattern here.

- [ ] **Step 1: Write the failing test for `computeApprovalRate`**

Create `lib/__tests__/suggestions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { computeApprovalRate } from "../suggestions";

describe("computeApprovalRate", () => {
  it("returns the fraction approved when both counts are positive", () => {
    expect(computeApprovalRate(3, 1)).toBe(0.75);
  });

  it("returns 1 when everything was approved", () => {
    expect(computeApprovalRate(5, 0)).toBe(1);
  });

  it("returns 0 when everything was dismissed", () => {
    expect(computeApprovalRate(0, 5)).toBe(0);
  });

  it("returns null instead of dividing by zero when nothing has been decided yet", () => {
    expect(computeApprovalRate(0, 0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run lib/__tests__/suggestions.test.ts`
Expected: FAIL — `computeApprovalRate` is not exported from `../suggestions` (it doesn't exist yet).

- [ ] **Step 3: Add the three functions to `lib/suggestions.ts`**

Append to the end of `lib/suggestions.ts` (after the existing `recordResult` function):

```ts
export async function suggestionsSince(agent: AgentId, sinceIso: string): Promise<Suggestion[]> {
  const { data } = await supabaseAdmin
    .from("suggestions")
    .select("*")
    .eq("agent", agent)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false });
  return (data ?? []) as Suggestion[];
}

// Pure — no I/O — so this is the one function in this file worth a real
// unit test. Returns null (not NaN/Infinity) when nothing has been decided
// yet, so callers can render "no data" instead of a bogus percentage.
export function computeApprovalRate(done: number, dismissed: number): number | null {
  const total = done + dismissed;
  if (total === 0) return null;
  return done / total;
}

export interface ApprovalStats {
  done: number;
  dismissed: number;
  rate: number | null;
}

export async function agentApprovalStats(agent: AgentId, sinceIso: string): Promise<ApprovalStats> {
  const { data } = await supabaseAdmin
    .from("suggestions")
    .select("status")
    .eq("agent", agent)
    .in("status", ["done", "dismissed"])
    .gte("created_at", sinceIso);
  const rows = (data ?? []) as { status: "done" | "dismissed" }[];
  const done = rows.filter((r) => r.status === "done").length;
  const dismissed = rows.filter((r) => r.status === "dismissed").length;
  return { done, dismissed, rate: computeApprovalRate(done, dismissed) };
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run lib/__tests__/suggestions.test.ts`
Expected: PASS — all 4 assertions green.

- [ ] **Step 5: Full verification**

Run: `npx tsc --noEmit` then `npm run lint` then `npm run build` — all clean.

- [ ] **Step 6: Commit**

```bash
git add lib/suggestions.ts lib/__tests__/suggestions.test.ts
git commit -m "Add suggestionsSince and agentApprovalStats to lib/suggestions.ts"
```

---

### Task 3: `lib/evals.ts` — the grading call

**Files:**
- Create: `lib/evals.ts`

**Interfaces:**
- Consumes: `anthropic, HAIKU` from `./anthropic`; `supabaseAdmin` from `./supabase`; `recordUsage` from `./usage`; `AgentId, Suggestion` from `./types` (all mirror `lib/consensus.ts`'s existing imports).
- Produces:
  - `interface AgentEval { id: string; agent: AgentId; cycle_at: string; score: number; reasoning: string; suggestions_count: number; created_at: string }` — used by Task 5.
  - `gradeAgentRun(agent: AgentId, cycleAt: string, text: string, saved: Suggestion[]): Promise<void>` — used by Task 4.
  - `recentEvals(agent: AgentId, limit?: number): Promise<AgentEval[]>` — used by Task 5.

No test file for this task — it's a live Anthropic + Supabase call, verified per the Global Constraints convention (build clean + manual trigger in Task 6), matching `lib/consensus.ts`.

- [ ] **Step 1: Write `lib/evals.ts`**

```ts
import { anthropic, HAIKU } from "./anthropic";
import { supabaseAdmin } from "./supabase";
import { recordUsage } from "./usage";
import type { AgentId, Suggestion } from "./types";

export interface AgentEval {
  id: string;
  agent: AgentId;
  cycle_at: string;
  score: number;
  reasoning: string;
  suggestions_count: number;
  created_at: string;
}

const GRADER_SYSTEM = `You are a quick quality grader for an AI analyst agent's work cycle. Score this cycle's output from 1 (poor) to 5 (excellent) against these standards: (1) claims are backed by verified evidence, not just assertions, (2) findings are specific and actionable, not generic, (3) recommendations are right-sized for an early-stage app with a small user base, not enterprise-scale overengineering, (4) the cycle avoids duplicating an already-open finding. A cycle that correctly concludes "nothing new to report" after real investigation deserves a high score — do not penalize an agent for finding nothing when nothing is genuinely wrong. Reply in exactly this format on one line, nothing else: SCORE: <1-5> REASON: <one sentence>`;

// Fire-and-forget grading for one agent's cycle — mirrors the shape of
// reviewCycleConsensus in lib/consensus.ts: a single cheap Haiku call,
// wrapped so a grading failure can never affect the cycle that triggered it.
export async function gradeAgentRun(
  agent: AgentId,
  cycleAt: string,
  text: string,
  saved: Suggestion[],
): Promise<void> {
  const savedList = saved.length
    ? saved.map((s) => `- (${s.priority}) ${s.title}: ${s.body.slice(0, 200)}`).join("\n")
    : "(none saved this cycle)";
  const userMessage = `Agent's final summary for this cycle:\n${text.slice(0, 1000)}\n\nSuggestions saved this cycle:\n${savedList}`;

  let score: number;
  let reasoning: string;
  try {
    const resp = await anthropic.messages.create({
      model: HAIKU,
      max_tokens: 150,
      system: GRADER_SYSTEM,
      messages: [{ role: "user", content: userMessage }],
    });
    await recordUsage(HAIKU, resp.usage);
    const raw = resp.content
      .filter((b): b is Extract<typeof resp.content[number], { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    const match = raw.match(/SCORE:\s*([1-5])\s*REASON:\s*(.+)/i);
    if (!match) return; // unparseable — skip rather than store garbage
    score = Number(match[1]);
    reasoning = match[2].trim().slice(0, 500);
  } catch {
    return; // never let a grading failure affect the cycle itself
  }

  await supabaseAdmin.from("agent_evals").insert({
    agent,
    cycle_at: cycleAt,
    score,
    reasoning,
    suggestions_count: saved.length,
  });
}

export async function recentEvals(agent: AgentId, limit = 10): Promise<AgentEval[]> {
  const { data } = await supabaseAdmin
    .from("agent_evals")
    .select("*")
    .eq("agent", agent)
    .order("cycle_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as AgentEval[];
}
```

- [ ] **Step 2: Full verification**

Run: `npx tsc --noEmit` then `npm run lint` then `npm run build` — all clean.

- [ ] **Step 3: Commit**

```bash
git add lib/evals.ts
git commit -m "Add lib/evals.ts — automated per-cycle grading"
```

---

### Task 4: Wire grading into `agents/run-agent.ts`

**Files:**
- Modify: `agents/run-agent.ts:1-70` (the `runAgent` function)

**Interfaces:**
- Consumes: `suggestionsSince` from `../lib/suggestions` (Task 2), `gradeAgentRun` from `../lib/evals` (Task 3).
- Produces: no new exports — `runAgent`'s existing signature (`(spec: AgentSpec) => Promise<string>`) is unchanged, this task only adds a non-blocking side effect inside it.

- [ ] **Step 1: Add the two new imports**

In `agents/run-agent.ts`, add to the existing import block (after the `reviewCycleConsensus` import on line 10):

```ts
import { suggestionsSince } from "../lib/suggestions";
import { gradeAgentRun } from "../lib/evals";
```

- [ ] **Step 2: Capture the cycle start time and grade after the run**

In `runAgent`, the current code (lines 56-66) is:

```ts
    const { text } = await runAgentLoop({
      agent: spec.id,
      system: spec.system,
      userMessage,
      tools: toolsFor(spec.id),
      maxTurns: 12,
      model: spec.model ?? SONNET, // per-agent override for low-stakes agents (see registry.ts)
      effort: "high", // deep analysis before concluding, not a quick scan
    });
    await writeMemory(spec.id, text.slice(0, 500));
    return text;
```

Replace it with:

```ts
    const cycleStart = new Date().toISOString();
    const { text } = await runAgentLoop({
      agent: spec.id,
      system: spec.system,
      userMessage,
      tools: toolsFor(spec.id),
      maxTurns: 12,
      model: spec.model ?? SONNET, // per-agent override for low-stakes agents (see registry.ts)
      effort: "high", // deep analysis before concluding, not a quick scan
    });
    await writeMemory(spec.id, text.slice(0, 500));

    // Never let a grading failure affect the cycle that triggered it —
    // same non-blocking pattern as alertIfCredentialsBroken/reviewCycleConsensus above.
    const saved = await suggestionsSince(spec.id, cycleStart);
    await gradeAgentRun(spec.id, cycleStart, text, saved).catch(() => {});

    return text;
```

- [ ] **Step 3: Full verification**

Run: `npx tsc --noEmit` then `npm run lint` then `npm run build` — all clean.

- [ ] **Step 4: Commit**

```bash
git add agents/run-agent.ts
git commit -m "Grade every agent cycle automatically via lib/evals"
```

---

### Task 5: Stats panel on `app/agents/[id]/page.tsx`

**Files:**
- Modify: `app/agents/[id]/page.tsx` (full file — currently 27 lines)

**Interfaces:**
- Consumes: `agentApprovalStats` from `../../../lib/suggestions` (Task 2), `recentEvals` from `../../../lib/evals` (Task 3).
- Produces: no new exports — this is a page component, not a library.

- [ ] **Step 1: Replace the full file**

```tsx
import { recentMemory } from "../../../lib/memory";
import { agentApprovalStats } from "../../../lib/suggestions";
import { recentEvals } from "../../../lib/evals";
import type { AgentId } from "../../../lib/types";

export const dynamic = "force-dynamic";

export default async function AgentDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agent = id as AgentId;
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [memory, stats, evals] = await Promise.all([
    recentMemory(agent, 10),
    agentApprovalStats(agent, thirtyDaysAgo),
    recentEvals(agent, 10),
  ]);

  return (
    <main className="p-4 max-w-2xl mx-auto">
      <h1 className="font-bold uppercase mb-4">{agent} AGENT</h1>

      <div
        className="rounded-lg p-3 mb-4"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
      >
        <div className="text-xs uppercase mb-2" style={{ color: "var(--text-dim)" }}>
          Last 30 days
        </div>
        <div className="text-sm">
          {stats.rate === null
            ? "No decided suggestions yet."
            : `${Math.round(stats.rate * 100)}% approval rate (${stats.done} approved, ${stats.dismissed} dismissed)`}
        </div>
      </div>

      <div
        className="rounded-lg p-3 mb-4"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
      >
        <div className="text-xs uppercase mb-2" style={{ color: "var(--text-dim)" }}>
          Recent quality grades
        </div>
        {evals.length === 0 ? (
          <div className="text-sm" style={{ color: "var(--text-dim)" }}>
            No graded runs yet.
          </div>
        ) : (
          evals.map((e) => (
            <div key={e.id} className="text-sm mb-1">
              <span className="font-bold">{e.score}/5</span> — {e.reasoning}
            </div>
          ))
        )}
      </div>

      {memory.map((m) => (
        <div
          key={m.id}
          className="rounded-lg p-3 mb-2"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
        >
          <div className="text-xs mb-1" style={{ color: "var(--text-dim)" }}>
            {m.cycle_at}
          </div>
          <div className="text-sm whitespace-pre-wrap">{m.summary}</div>
        </div>
      ))}
    </main>
  );
}
```

- [ ] **Step 2: Full verification**

Run: `npx tsc --noEmit` then `npm run lint` then `npm run build` — all clean.

- [ ] **Step 3: Commit**

```bash
git add "app/agents/[id]/page.tsx"
git commit -m "Show approval rate and recent grades on the agent detail page"
```

---

### Task 6: End-to-end verification

**Files:** none (verification only)

**Interfaces:** none — this task exercises everything built in Tasks 1-5 together.

- [ ] **Step 1: Trigger one real agent cycle**

Start the dev server (`npm run dev`), sign in, and use the dashboard's manual "Run" control to run a single agent (any technical agent, e.g. `engineering`, is a good pick — its suggestions carry real evidence for the grader to assess).

- [ ] **Step 2: Confirm a row landed in `agent_evals`**

Use the Supabase `execute_sql` MCP tool: `select * from agent_evals where agent = 'engineering' order by cycle_at desc limit 1;`
Expected: one row, `score` between 1 and 5, `reasoning` a non-empty sentence, `suggestions_count` matching how many suggestions that run actually saved.

- [ ] **Step 3: Confirm the page renders**

Navigate to `/agents/engineering` in the browser. Confirm:
- The "Last 30 days" panel shows either a real percentage or "No decided suggestions yet." (not a crash, not `NaN%`).
- The "Recent quality grades" panel shows the row from Step 2.
- The existing memory log below still renders as before.

- [ ] **Step 4: Confirm a zero-suggestion cycle still gets graded**

Find or trigger a cycle where the agent concluded "nothing new" (check `activity_log`/agent memory for one, or re-run an agent whose inbox is already fully covered). Confirm `agent_evals` still got a new row for that cycle (grading must not skip zero-suggestion runs — this was an explicit design requirement).

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "Verify agent eval loop end-to-end" --allow-empty
```
(Use `--allow-empty` only if Steps 1-4 needed no code changes; if you fixed anything while verifying, commit that fix normally instead.)

---

## Self-Review

**Spec coverage:** Data model (Task 1) ✓. Grading flow (Task 3, wired in Task 4) ✓. Approval-rate computation (Task 2) ✓. UI surface (Task 5) ✓. Cost — no dedicated task, it's a property of Task 3's design (Haiku, short prompts), confirmed by nothing further needed. Error handling — built into Task 3's try/catch and Task 4's `.catch(() => {})`, both directly copied from the existing `lib/consensus.ts` pattern. Testing plan — Task 6 covers all 4 spec verification steps directly.

**Placeholder scan:** No TBD/TODO. Every step has complete, runnable code or an exact command.

**Type consistency:** `AgentEval`, `ApprovalStats`, `computeApprovalRate`, `suggestionsSince`, `gradeAgentRun`, `recentEvals`, `agentApprovalStats` — checked that every later task's usage matches the exact name and signature defined in its producing task.
