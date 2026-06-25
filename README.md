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

Each agent runs its tool loop (`web_search`, `read_footrank_stats`, and for technical agents `list_repo`/`read_repo_file`), then calls `save_suggestion` for each recommendation. Suggestions land in the `suggestions` table and appear in the inbox with agent, category, and priority. You **Mark done** or **Dismiss**. Agents see their last 5 suggestions each run to avoid repeating themselves.

## Owner-only access

Single-user system for `tomisapoelcity@gmail.com`. Auth is **not yet enforced in code** — add Supabase Auth middleware gating every route (and the cron/QA endpoints) before deploying publicly.
