# FootRank Mission Control

A dashboard where a team of **advisory AI agents** continuously review FootRank and write concrete suggestions into an inbox you read and act on. **Nothing is posted, sent, deployed, or auto-executed** — every agent only produces recommendations (including video/Reel ideas you film yourself). Technical agents read the FootRank Flutter codebase from GitHub to give file-level advice.

## Stack

Next.js 15 (App Router) · TypeScript · `@anthropic-ai/sdk` (`claude-opus-4-8`) · Supabase · Tailwind v4 · Vercel Cron.

## Agents & cadence

| Agent | Runs | Reads code? | Focus |
|---|---|---|---|
| Cybersecurity | hourly | ✓ | Auth/RLS hardening, dep & data-exposure risks, CVEs |
| Engineering | every 4h | ✓ | Architecture, scalability, tech debt, infra cost |
| Developer | every 4h | ✓ | Feature ideas + implementation notes |
| QA | on demand (button) | ✓ | Test gaps, edge cases, manual test scripts |
| UX/Design | every 5 days | ✓ | Flow & UI friction, onboarding drop-off |
| Marketing | daily | — | Campaigns, posts, short-form video concepts |
| Growth Analyst | daily | — | Funnel, retention, churn, activation |
| Data Analyst | daily | — | Cohorts, anomalies, what to measure |
| Community & Trust/Safety | daily | — | Moderation, fair-play (reads `behavior_reports`) |
| Competitive Intel | daily | — | Rival apps & market trends |
| Monetization | daily | — | Pricing, premium features, revenue ideas |

## Setup

1. `npm install`
2. Copy `.env.local.example` → `.env.local` and fill in: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ANTHROPIC_API_KEY`, `TAVILY_API_KEY`, `CRON_SECRET`, and for the technical agents `GITHUB_TOKEN` (repo read) + `GITHUB_REPO` (`owner/name`).
3. Migrations in `supabase/migrations/` are already applied to the FootRank Supabase project.

## Running

- `npm run dev` — dashboard at http://localhost:3000 (agent roster + suggestions inbox + live feed + orchestrator chat)
- `npm test` — unit tests
- Trigger a cadence group manually:
  ```bash
  curl -X POST "http://localhost:3000/api/cycle?group=daily" -H "Authorization: Bearer $CRON_SECRET"
  # groups: hourly | 4h | daily | 5day
  ```
- Run QA on demand: the **▶ Run QA** button on the dashboard (or `POST /api/qa`).

## Cron (Vercel)

`vercel.json` schedules the four cadence groups. **Sub-daily crons (hourly, 4h) require a Vercel Pro plan** — on Hobby, only the daily/5-day schedules fire; trigger the others manually or with an external scheduler.

## How suggestions flow

Each agent runs its tool loop (`web_search`, `read_footrank_stats`, and for technical agents `list_repo`/`read_repo_file`), then calls `save_suggestion` for each recommendation. Suggestions land in the inbox with agent, category, and priority. Agents see their last 5 suggestions each run to avoid repeating themselves.

Each suggestion has three buttons:

- **Okay — agent handles it** → the responsible agent writes the change as code on a `qa/*` branch, which runs the emulator test suite. Database changes are written as a **new migration file** under `supabase/migrations/` — Mission Control has no way to execute SQL against the live database. If QA passes, Mission Control **opens a pull request**; you review it and merge it on GitHub yourself (normal CI + security scan run on the PR). After merging, apply any migration yourself. **Mission Control never merges and never runs migrations.** If the change can't be expressed as code, the agent reports exactly what you must do.
- **Done** → archive it (you handled it).
- **Dismiss** → drop it.

**Safety rails (enforced in code, see `lib/fix-paths.ts`, `lib/tool-guard.ts`, `lib/sql-guard.ts`):** a model can only run tools actually offered to it on that turn (anything else is rejected and logged as `security:tool-rejected`); fixes cannot modify `.github/`, secrets/signing files, or existing migrations; `db_read` runs one guarded SELECT through Supabase's read-only endpoint (`supabase_read_only_user`, read-only transaction), blocks the `auth`/`vault` schemas and personal/free-text columns, and redacts personal data in results.

**Setup for "Okay":** `GITHUB_TOKEN` needs Contents + Pull-requests write (to push the `qa/*` branch and open the PR). Recommended: protect `master` in GitHub (require a pull request and passing CI) so nothing — including this token — can push to it directly.

## Owner-only access

Single-user system for `tomisapoelcity@gmail.com`. Auth is **not yet enforced in code** — add Supabase Auth middleware gating every route (and the cron/QA endpoints) before deploying publicly.
