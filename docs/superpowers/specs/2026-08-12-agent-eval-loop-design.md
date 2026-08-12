# Agent Eval Loop — Design

## Problem

Mission Control has no way to tell whether an agent is doing a good job. Every run
either saves suggestions or concludes "nothing new" — but there is no scoring,
grading, or trend line behind that. The only real signal that exists today
(the owner's `done`/`dismissed` decision on each suggestion) is never aggregated
or surfaced back — it's write-only data sitting in the `suggestions` table.

This is a prerequisite for the separate "dynamic agent count" feature discussed
alongside it — you can't sensibly decide to run an agent more or less often
without first knowing whether its output is worth the spend. That second
feature is explicitly out of scope here and will get its own design.

## Goal

Give the owner two complementary signals per agent, combined into one view:

1. **Approval rate** — of this agent's own past decisions (`done` vs `dismissed`),
   computed from data that already exists. Zero new cost.
2. **Automated quality grade** — a cheap, immediate score on every single run,
   including "nothing new" runs, catching a bad cycle before the owner ever
   sees its output.

## Non-goals

- No golden-set / regression-test scenarios (deferred — see prior discussion).
- No automatic gating or blocking based on score. Grading is visibility only;
  the human-approval gate on suggestions is unchanged.
- No change to the `suggestions` table or its existing `new`/`done`/`dismissed`
  status flow.

## Data model

New table, `agent_evals`, modeled directly on the existing `agent_memory` table's
shape (`supabase/migrations/0001_mission_control.sql`) for consistency:

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

No changes to any existing table.

## Grading flow

New function `gradeAgentRun(agent, cycleStart, text)` in a new file `lib/evals.ts`,
following the exact pattern already established by `lib/consensus.ts`
(`reviewCycleConsensus`) — a single Haiku call, fire-and-forget from the
caller's perspective.

Called from `agents/run-agent.ts`, inside `runAgent`, right after
`runAgentLoop` returns and before `writeMemory`:

```ts
const cycleStart = new Date().toISOString(); // captured before runAgentLoop
const { text } = await runAgentLoop({ ... }); // existing call, unchanged

// New: fetch what this run actually saved, and grade it.
const savedThisRun = await suggestionsSince(spec.id, cycleStart); // new query
await gradeAgentRun(spec.id, cycleStart, text, savedThisRun).catch(() => {});
```

`suggestionsSince(agent, sinceIso)` is a small new query in `lib/suggestions.ts`
(same shape as `openSuggestionsForAgent`, filtered by `created_at >= sinceIso`
instead of `status = "new"`) — this gives the grader the actual saved
title/body/priority, not just the agent's own prose summary, so it's grading
the real output rather than the agent's self-report of its output.

**The grader's prompt** scores against the same standard already written into
every agent's system prompt (the shared `EXPERT`/`PROCEDURE`/`ADVISORY` blocks
in `agents/registry.ts`): verified evidence over claims, specific and
actionable, right-sized for FootRank's early stage, not a duplicate of
something already open. It returns a 1–5 score and one sentence of reasoning.
A "nothing new this cycle" run is graded on whether that conclusion looks
justified (e.g. the agent's text shows it actually checked something) versus
looks like it skipped the work — not penalized just for finding nothing.

## Approval-rate computation

New function `agentApprovalStats(agent, sinceIso)` in `lib/suggestions.ts`:
counts this agent's suggestions grouped by `status`, over a time window,
excluding `new` (not yet decided). Returns `{ done, dismissed, rate }`.
Pure read of existing data — no schema change, no new writes.

## Where it surfaces

`/agents/[id]/page.tsx` currently renders only a raw `recentMemory` log (bare,
unstyled — it predates the rest of the dashboard's visual work). Add a small
panel above the existing log:

- Approval rate + suggestion volume (last 30 days), from `agentApprovalStats`.
- Recent grade scores with their one-line reasoning (last 10), from a new
  `recentEvals(agent, limit)` read in `lib/evals.ts`.

No changes to the main `RoomsDashboard` — this stays scoped to the per-agent
detail page, which is exactly where an owner would go to answer "is this
specific agent worth what it's costing me."

## Cost

One extra Haiku call per agent run. At current run volumes (~200/month across
all agents, per the earlier GitHub Actions scheduling math), this is a few
dollars a month at most — Haiku is the cheapest tier and the grading prompt/
output are both short.

## Error handling

Grading failure (API error, malformed response) must never block or fail the
actual agent cycle. `gradeAgentRun` is called with `.catch(() => {})` from
`runAgent`, exactly matching the existing non-blocking pattern used for
`alertIfCredentialsBroken()` and `reviewCycleConsensus()` in `runGroup`. A
missing eval row for a given cycle is an acceptable failure mode; a blocked
agent cycle is not.

## Testing / verification plan

1. `npx tsc --noEmit` + `npm run lint` + `npm run build` after implementation,
   matching the verification discipline used throughout this project.
2. Manually trigger one agent run (`runOne`), confirm a row lands in
   `agent_evals` with a plausible score/reasoning.
3. Manually mark a couple of existing suggestions `done`/`dismissed` (or use
   ones already in that state) and confirm `agentApprovalStats` returns the
   expected counts/rate.
4. Load `/agents/[id]` for an agent with real history and confirm the new
   panel renders correctly, including the case where an agent has zero graded
   runs yet or zero decided suggestions yet (both should render a sensible
   empty state, not crash).
