# FootRank Mission Control

A standalone dashboard that runs three autonomous AI agents (Marketing, Growth, Content) for the FootRank app on a 4-hour cycle. Low-risk actions (web research, data reads, saving drafts) run automatically; high-risk actions (social posts, push notifications, GitHub issues/PRs) are queued for one-tap owner approval. The owner can also message the orchestrator directly.

## Stack

Next.js 15 (App Router) · TypeScript · `@anthropic-ai/sdk` (`claude-opus-4-8`) · Supabase · Tailwind v4 · Vercel Cron.

## Setup

1. `npm install`
2. Copy `.env.local.example` to `.env.local` and fill in:

| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API (agents + orchestrator) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Shared FootRank Supabase project (service role) |
| `TAVILY_API_KEY` | Web search tool |
| `FACEBOOK_ACCESS_TOKEN`, `INSTAGRAM_ACCESS_TOKEN`, `TIKTOK_ACCESS_TOKEN`, `YOUTUBE_API_KEY` | Social posting (on approval — v1 actuators stubbed) |
| `FIREBASE_SERVICE_ACCOUNT` | Push notifications (on approval — v1 actuator stubbed) |
| `GITHUB_TOKEN` | GitHub issues/PRs (on approval — v1 actuator stubbed) |
| `CRON_SECRET` | Shared secret guarding `POST /api/cycle` |

3. Apply the DB migration in `supabase/migrations/0001_mission_control.sql` (already applied to the FootRank Supabase project during setup).

## Running

- `npm run dev` — dashboard at http://localhost:3000
- `npm test` — unit tests
- Trigger a cycle manually:
  ```bash
  curl -X POST http://localhost:3000/api/cycle -H "Authorization: Bearer $CRON_SECRET"
  ```

## Autonomy & approvals

- **Cadence:** every 4 hours (`vercel.json` cron → `POST /api/cycle`).
- **Autonomous (no approval):** web research, Supabase reads, saving content drafts, activity logging.
- **Approval required:** social posts (Facebook/Instagram/TikTok/YouTube), push notifications, GitHub issues/PRs. These are written to the `approvals` table and never execute until approved at `/approvals`.

### Cron auth note

Vercel Cron invokes the path without a custom `Authorization` header. To keep the `CRON_SECRET` guard, either configure the cron to send the header, or switch the route guard in `app/api/cycle/route.ts` to verify Vercel's `x-vercel-cron` request signal.

## Owner-only access

Single-user system for `tomisapoelcity@gmail.com`. Auth is **not yet enforced in code** — add Supabase Auth middleware gating every route to that email before deploying publicly.

## v1 scope note

Approving an item marks it `approved` and logs it. Wiring the real platform API calls (Facebook/Instagram/TikTok/YouTube/Firebase/GitHub) on approval is the follow-up — the approval routes are the single integration point.
