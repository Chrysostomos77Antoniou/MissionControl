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

### Free AI providers (€0, fail-closed)

Agents run only through the free-only router in `lib/free-llm.ts`. The provider/model allowlist is hard-coded there; no environment variable can add a provider or change a model, and there is no paid fallback — when every approved free option is unavailable or at its local daily ceiling, the run stops with `FREE_AI_QUOTA_EXHAUSTED`.

| Provider | Model | Key (server-side `.env.local` only) | Local daily ceiling |
|---|---|---|---|
| Ollama (local, `127.0.0.1:11434`) | `qwen3.5:4b` | none | none (local) — never used for the `high` tier |
| Google Gemini (AI Studio free tier) | `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-3.8-flash` | `GEMINI_API_KEY` — from a Google project **without billing** | 80% of the free limit (400 / 400 / 16 requests) |
| Groq (Free plan) | `openai/gpt-oss-120b` | `GROQ_API_KEY` — from an organization on the **Free plan** (no payment method, never upgraded) | 500 requests (50% of 1,000/day) — `simple`/`medium` tiers only; never `high` (Cybersecurity) until security-benchmarked |

A missing key makes that provider unavailable without any network request. Keys are never exposed to the browser (no `NEXT_PUBLIC_*`), never logged and never stored in `usage_log`.
Cerebras is intentionally **not** supported: its API has no permanent free tier (a card-verified, 30-day trial credit only).

## Running

- `npm run dev` — dashboard at http://localhost:3000 (agent roster + suggestions inbox + live feed + orchestrator chat)
- `npm test` — unit tests
- Trigger one cycle by hand (same endpoint the scheduler uses):
  ```powershell
  powershell -File tools\schedule-cycle.ps1 -Group daily   # 4h | daily | 5day
  ```
- Run QA on demand: the **▶ Run QA** button on the dashboard (or `POST /api/qa`).

## Scheduled cycles (local only)

Mission Control runs **only on this machine**; nothing in the cloud can reach it, so there is no Vercel/GitHub cron.

- **Trigger:** Windows Task Scheduler runs `tools/schedule-cycle.ps1 -Group 4h|daily|5day`, which POSTs to `http://127.0.0.1:3000/api/cycle`. You register the tasks yourself once (commands are in the script's header). The app must be running (`npm run dev` / `npm start`) or the cycle is simply missed.
- **Auth:** `/api/cycle` requires `Authorization: Bearer <CRON_SECRET>`. If `CRON_SECRET` is missing or empty the endpoint rejects everything. The script reads the secret from `MC_CRON_SECRET` or `.env.local` and never prints it.
- **One at a time:** a cycle takes a cycle lock (a second cycle is skipped, not queued) and runs due agents sequentially.
- **Change detection:** before each due agent, a deterministic fingerprint of its inputs is compared with its last successful baseline (stored as `cycle:baseline` rows in `activity_log`): the agent's own open suggestions (all agents) plus all-time FootRank totals — users, matches, teams, behavior reports, notifications (growth, marketing, community, devops). Unchanged → skipped with **no AI call**.
- **7-day maximum age:** an agent whose last successful run is 7+ days old runs even if nothing changed.
- **First run / failures:** no baseline → the agent runs. A baseline is written only after a successful (`ok`) run; a stopped, maxed-out or failed run keeps the old one. If an input can't be read the agent is skipped (never treated as "unchanged"). If free AI is unavailable for a tier, later agents on that tier are not started.
- **Manual runs** (dashboard buttons, chat "run …") skip change detection only — they still use the cycle and agent locks, one agent at a time, free-only models, the numeric-claim guard, and human approval for any fix.

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
