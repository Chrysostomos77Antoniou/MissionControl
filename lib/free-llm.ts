// Free-only LLM router (Phase 2, commit 4) — the €0 enforcement layer.
//
// Callers ask for a TASK TIER ("simple" | "medium" | "high"); the router alone
// decides which approved free provider/model runs it. There is no parameter,
// environment variable or config through which a caller can name a provider
// or model. The only models that can ever be called are the five in
// FREE_ALLOWLIST (local Ollama qwen3.5:4b + three free-tier Gemini models +
// Groq's single free-plan model, GROQ_MODEL in lib/providers/groq.ts).
//
// Guarantees:
//   - Allowlist: every candidate is checked against FREE_ALLOWLIST, and the
//     provider instance about to run is re-checked (id + model) at call time.
//   - Pre-flight quota: before any REMOTE (Gemini/Groq) request, today's
//     request count is read from usage_log and compared with a hard-coded
//     local ceiling below the provider's documented free limit (Gemini
//     400/400/16 = 80%; Groq 500 = 50%). If the count can't be read — or the
//     request can't be recorded first — that provider is NOT called (fail
//     closed).
//   - Finite attempts: each candidate is tried at most once per request; the
//     candidate list is fixed per tier (≤ 4 entries). No loops, no sleeps.
//   - No paid path: billing/402 errors mark that provider exhausted for the
//     day and are never "fixed" by paying; there is no paid provider to fall
//     back to.
//   - When nothing is left: throws an LlmError whose message starts with
//     FREE_AI_QUOTA_EXHAUSTED and logs that marker.
//   - Privacy: logs/records only provider, model, tier, result and token
//     counts — never prompts, tool results or keys.

import { assertGenericRequest, type LlmProvider, type LlmRequest, type LlmResponse, type ProviderId } from "./llm";
import { LlmError, FREE_AI_QUOTA_EXHAUSTED, type LlmErrorKind } from "./llm-errors";
import { ollamaProvider, OLLAMA_MODEL } from "./providers/ollama";
import { createGeminiProvider, GEMINI_FREE_MODELS, isGeminiFreeModel, type GeminiFreeModel } from "./providers/gemini";
import { groqProvider, GROQ_MODEL, GROQ_FREE_LIMITS } from "./providers/groq";
import { quotaDayStart, supabaseFreeUsageStore, type FreeUsageStore } from "./free-usage";

export type TaskTier = "simple" | "medium" | "high";
export const TASK_TIERS: readonly TaskTier[] = Object.freeze(["simple", "medium", "high"]);

export interface FreeModelRef {
  provider: ProviderId;
  model: string;
}

// Internal safety ceiling = 80% of the verified free daily limit.
const CEILING_RATIO = 0.8;
export const GEMINI_DAILY_CEILING: Readonly<Record<GeminiFreeModel, number>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(GEMINI_FREE_MODELS) as GeminiFreeModel[]).map((m) => [m, Math.floor(GEMINI_FREE_MODELS[m].requestsPerDay * CEILING_RATIO)]),
  ) as Record<GeminiFreeModel, number>,
);

// Groq: 50% of the documented free-plan requests/day (1,000). Lower than the
// Gemini ratio because Groq documents that an organization's limits are shown
// on its own limits page and may differ; the free plan's tokens/day (200K) and
// tokens/minute (8K) are the tighter limits in practice, and a daily-limit 429
// marks Groq exhausted for the day (see lib/providers/groq.ts).
const GROQ_CEILING_RATIO = 0.5;
export const GROQ_DAILY_CEILING = Math.floor(GROQ_FREE_LIMITS.requestsPerDay * GROQ_CEILING_RATIO);

// The complete set of provider/model pairs this router may ever call.
export const FREE_ALLOWLIST: readonly FreeModelRef[] = Object.freeze([
  Object.freeze({ provider: "ollama" as const, model: OLLAMA_MODEL }),
  ...(Object.keys(GEMINI_FREE_MODELS) as GeminiFreeModel[]).map((m) => Object.freeze({ provider: "gemini" as const, model: m })),
  Object.freeze({ provider: "groq" as const, model: GROQ_MODEL }),
]);

// Remote providers: a request is only sent after the local daily ceiling is
// checked and the request is recorded. null = local (no quota to protect).
function dailyCeilingFor(c: FreeModelRef): number | null {
  if (c.provider === "gemini" && isGeminiFreeModel(c.model)) return GEMINI_DAILY_CEILING[c.model];
  if (c.provider === "groq" && c.model === GROQ_MODEL) return GROQ_DAILY_CEILING;
  if (c.provider === "ollama") return null;
  // Unknown remote pair: no ceiling means no request (fail closed).
  return 0;
}

export function isAllowedFreeModel(provider: unknown, model: unknown): boolean {
  return FREE_ALLOWLIST.some((a) => a.provider === provider && a.model === model);
}

export function assertAllowedFreeModel(provider: unknown, model: unknown): FreeModelRef {
  if (!isAllowedFreeModel(provider, model)) {
    throw new LlmError("INVALID_REQUEST", `router: ${String(provider).slice(0, 40)}/${String(model).slice(0, 60)} is not an approved free model`, { provider: "router" });
  }
  return { provider: provider as ProviderId, model: model as string };
}

// Tier -> ordered candidates. Qwen 3.5 4B is first only for SIMPLE tasks, a
// last resort for MEDIUM, and never used for HIGH (code/security reasoning —
// the 4B benchmark produced false security claims). Groq's GROQ_MODEL (a
// 120B open-weight model) is a fallback after Gemini for SIMPLE and MEDIUM
// only; its free plan is small (8K tokens/minute), so it only serves requests
// that fit. It is NOT in HIGH (Cybersecurity, code-writing fixes) because it
// has not passed the Mission Control security benchmark; adding it there
// needs an explicit benchmark + approval.
const TIER_PLAN: Readonly<Record<TaskTier, readonly FreeModelRef[]>> = Object.freeze({
  simple: Object.freeze([
    { provider: "ollama", model: OLLAMA_MODEL },
    { provider: "gemini", model: "gemini-3.5-flash-lite" },
    { provider: "gemini", model: "gemini-3.1-flash-lite" },
    { provider: "groq", model: GROQ_MODEL },
  ]),
  medium: Object.freeze([
    { provider: "gemini", model: "gemini-3.5-flash-lite" },
    { provider: "gemini", model: "gemini-3.1-flash-lite" },
    { provider: "groq", model: GROQ_MODEL },
    { provider: "ollama", model: OLLAMA_MODEL },
  ]),
  high: Object.freeze([
    { provider: "gemini", model: "gemini-3.8-flash" },
    { provider: "gemini", model: "gemini-3.5-flash-lite" },
    { provider: "gemini", model: "gemini-3.1-flash-lite" },
  ]),
} as Record<TaskTier, readonly FreeModelRef[]>);

export function candidatesFor(tier: TaskTier): readonly FreeModelRef[] {
  if (!TASK_TIERS.includes(tier)) throw new LlmError("INVALID_REQUEST", `router: unknown task tier "${String(tier).slice(0, 20)}"`, { provider: "router" });
  return TIER_PLAN[tier].map((c) => assertAllowedFreeModel(c.provider, c.model));
}

// = the longest tier plan, so every approved candidate can be reached once.
export const MAX_ATTEMPTS_PER_REQUEST = 4;
const RATE_LIMIT_COOLDOWN_MS = 60_000;

export type AttemptResult = "ok" | "skipped_ceiling" | "skipped_exhausted" | "skipped_cooldown" | "skipped_usage_unknown" | Lowercase<LlmErrorKind>;

export interface RouterEvent {
  tier: TaskTier;
  provider: ProviderId;
  model: string;
  result: AttemptResult;
  billing?: boolean;
  used?: number;
  ceiling?: number;
}

export interface FreeLlmResult extends LlmResponse {
  tier: TaskTier;
  cost: 0;
  attempts: { provider: ProviderId; model: string; result: AttemptResult }[];
}

export interface FreeLlmRouterDeps {
  store?: FreeUsageStore;
  now?: () => Date;
  onEvent?: (e: RouterEvent | { marker: typeof FREE_AI_QUOTA_EXHAUSTED; tier: TaskTier; attempts: string }) => void;
}

const keyOf = (c: FreeModelRef) => `${c.provider}:${c.model}`;

function defaultLog(e: unknown) {
  // Structured, prompt-free diagnostics only.
  console.warn(`[free-llm] ${JSON.stringify(e)}`);
}

export function createFreeLlmRouter(deps: FreeLlmRouterDeps = {}) {
  const store = deps.store ?? supabaseFreeUsageStore;
  const now = deps.now ?? (() => new Date());
  const emit = deps.onEvent ?? defaultLog;
  // Process-local memory, on top of the persisted markers.
  const exhaustedFor = new Map<string, number>(); // key -> quota-day start (ms)
  const coolingUntil = new Map<string, number>(); // key -> epoch ms

  function providerFor(c: FreeModelRef): LlmProvider {
    const p =
      c.provider === "ollama" ? ollamaProvider
      : c.provider === "groq" ? groqProvider
      : c.provider === "gemini" && isGeminiFreeModel(c.model) ? createGeminiProvider(c.model)
      : null;
    // Belt and braces: the instance about to run must itself be allowlisted.
    if (!p || !isAllowedFreeModel(p.id, p.model) || p.id !== c.provider || p.model !== c.model) {
      throw new LlmError("INVALID_REQUEST", "router: refused a provider instance outside the free allowlist", { provider: "router" });
    }
    return p;
  }

  async function generate(tier: TaskTier, request: LlmRequest): Promise<FreeLlmResult> {
    const plan = candidatesFor(tier); // validates tier + allowlist
    assertGenericRequest(request); // no model/provider/base-URL fields can ride along
    const dayStart = quotaDayStart(now());
    const attempts: FreeLlmResult["attempts"] = [];
    const tried = new Set<string>();
    let lastError: LlmError | null = null;
    let quotaRelated = true;
    let streamed = false;
    const req: LlmRequest = request.onTextDelta
      ? { ...request, onTextDelta: (d) => { streamed = true; request.onTextDelta!(d); } }
      : request;

    const note = (c: FreeModelRef, result: AttemptResult, extra: Partial<RouterEvent> = {}) => {
      attempts.push({ provider: c.provider, model: c.model, result });
      emit({ tier, provider: c.provider, model: c.model, result, ...extra });
    };

    for (const c of plan) {
      if (attempts.filter((a) => !a.result.startsWith("skipped")).length >= MAX_ATTEMPTS_PER_REQUEST) break;
      const key = keyOf(c);
      if (tried.has(key)) continue; // never the same provider/model twice
      tried.add(key);

      if (exhaustedFor.get(key) === dayStart.getTime()) { note(c, "skipped_exhausted"); continue; }
      if ((coolingUntil.get(key) ?? 0) > now().getTime()) { note(c, "skipped_cooldown"); quotaRelated = false; continue; }

      let reservation: string | null = null;
      const ceiling = dailyCeilingFor(c);
      if (ceiling !== null) {
        // Remote provider: pre-flight quota check. Any failure here means the
        // provider is NOT called.
        let used: number;
        try {
          if (await store.isExhaustedSince(key, dayStart)) {
            exhaustedFor.set(key, dayStart.getTime());
            note(c, "skipped_exhausted");
            continue;
          }
          used = await store.countRequestsSince(key, dayStart);
        } catch {
          note(c, "skipped_usage_unknown");
          quotaRelated = false;
          lastError = new LlmError("PROVIDER_UNAVAILABLE", `router: ${c.provider} usage could not be determined — not calling it`, { provider: "router" });
          continue;
        }
        if (used >= ceiling) {
          exhaustedFor.set(key, dayStart.getTime());
          note(c, "skipped_ceiling", { used, ceiling });
          continue;
        }
        if (!(await providerFor(c).isAvailable())) {
          note(c, "provider_unavailable");
          quotaRelated = false;
          lastError = new LlmError("PROVIDER_UNAVAILABLE", `${c.provider}: not configured`, { provider: c.provider });
          continue;
        }
        try {
          reservation = await store.reserve(key); // count the request before sending it
        } catch {
          note(c, "skipped_usage_unknown");
          quotaRelated = false;
          lastError = new LlmError("PROVIDER_UNAVAILABLE", `router: could not record ${c.provider} usage — not calling it`, { provider: "router" });
          continue;
        }
      } else {
        // Local: no quota to protect; recording is best effort.
        reservation = await store.reserve(key).catch(() => null);
      }

      try {
        const res = await providerFor(c).generate(req);
        if (reservation) await store.complete(reservation, res.usage).catch(() => {});
        note(c, "ok");
        return { ...res, tier, cost: 0, attempts };
      } catch (err) {
        const e = err instanceof LlmError ? err : new LlmError("MODEL_FAILURE", "provider threw a non-LLM error", { provider: c.provider });
        lastError = e;
        note(c, e.kind.toLowerCase() as AttemptResult, e.billing ? { billing: true } : {});

        if (e.kind === "INVALID_REQUEST") throw e; // our request is wrong (or cancelled): switching providers won't help
        if (streamed) throw e; // text already reached the caller; don't splice a second provider's answer onto it

        if (e.kind === "QUOTA_EXHAUSTED") {
          exhaustedFor.set(key, dayStart.getTime());
          await store.markExhausted(key).catch(() => {});
          if (e.billing) {
            // Billing wall: every model of that provider is off-limits today.
            for (const a of FREE_ALLOWLIST) {
              if (a.provider !== c.provider) continue;
              const k = keyOf(a);
              exhaustedFor.set(k, dayStart.getTime());
              await store.markExhausted(k).catch(() => {});
            }
          }
        } else {
          quotaRelated = false;
          if (e.kind === "RATE_LIMITED") coolingUntil.set(key, now().getTime() + RATE_LIMIT_COOLDOWN_MS);
        }
        // Otherwise: move on to the next approved FREE candidate (finite list).
      }
    }

    const summary = attempts.map((a) => `${a.provider}:${a.model}=${a.result}`).join(", ");
    emit({ marker: FREE_AI_QUOTA_EXHAUSTED, tier, attempts: summary });
    throw new LlmError(
      quotaRelated ? "QUOTA_EXHAUSTED" : (lastError?.kind ?? "PROVIDER_UNAVAILABLE"),
      `${FREE_AI_QUOTA_EXHAUSTED}: no approved free provider could serve this ${tier} request (${summary || "no candidates"}). Stopping — no paid fallback exists.`,
      { provider: "router" },
    );
  }

  return Object.freeze({ generate });
}

// The router Mission Control will use (wired to agents in a later commit).
export const freeLlm = createFreeLlmRouter();
