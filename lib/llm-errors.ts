// Provider-neutral LLM errors (Phase 2, commit 1).
//
// Every adapter converts its failures into an LlmError with one of five kinds,
// so the free-only router can decide what to do without knowing providers:
//
//   QUOTA_EXHAUSTED      free allowance used up, billing/payment required,
//                        insufficient quota (HTTP 402, daily-quota 429, …)
//   RATE_LIMITED         per-minute throttling (HTTP 429 without a daily/
//                        billing signal)
//   PROVIDER_UNAVAILABLE not reachable / down / timed out / not configured /
//                        auth rejected (connection refused, 5xx, 401, 403)
//   INVALID_REQUEST      the request itself was rejected (400, 404, 413, 422)
//   MODEL_FAILURE        the model answered but unusably (malformed tool call,
//                        unparseable JSON, empty output)
//
// Nothing here ever retries, and nothing here ever chooses a provider. A
// billing/payment signal is always QUOTA_EXHAUSTED — i.e. "stop using this
// provider", never "try a paid tier".

import type { ProviderId } from "./llm";

export type LlmErrorKind =
  | "QUOTA_EXHAUSTED"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "INVALID_REQUEST"
  | "MODEL_FAILURE";

// Log/activity marker used when every approved free provider is exhausted.
export const FREE_AI_QUOTA_EXHAUSTED = "FREE_AI_QUOTA_EXHAUSTED";

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly provider: ProviderId | "router";
  readonly status?: number;
  readonly billing: boolean; // payment/billing was mentioned — never "fix" by paying

  constructor(kind: LlmErrorKind, message: string, opts: { provider: ProviderId | "router"; status?: number; billing?: boolean; cause?: unknown }) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "LlmError";
    this.kind = kind;
    this.provider = opts.provider;
    this.status = opts.status;
    this.billing = !!opts.billing;
  }
}

export function isLlmError(e: unknown): e is LlmError {
  return e instanceof LlmError;
}

const BILLING = /billing|payment required|insufficient[_ ]quota|credit balance|out of credits|prepay|upgrade (your )?plan|paid tier/i;
const DAILY_QUOTA = /per[_ ]?day|daily|requests?[_ ]per[_ ]day|quota (has been )?exceeded|exceeded (your )?(current )?quota|resource[_ ]?exhausted.*(day|quota)|free[_ ]tier/i;

// Map an HTTP failure from any provider to a kind. `body` is the (possibly
// truncated) response text; it is only inspected, never echoed back whole.
export function classifyHttpError(provider: ProviderId, status: number, body = ""): LlmError {
  const snippet = String(body).replace(/\s+/g, " ").slice(0, 200);
  const billing = BILLING.test(body);
  const msg = (what: string) => `${provider}: ${what} (HTTP ${status})${snippet ? ` — ${snippet}` : ""}`;

  if (status === 402 || billing) return new LlmError("QUOTA_EXHAUSTED", msg("billing/payment required — free use unavailable"), { provider, status, billing: true });
  if (status === 429) {
    return DAILY_QUOTA.test(body)
      ? new LlmError("QUOTA_EXHAUSTED", msg("free quota exhausted"), { provider, status })
      : new LlmError("RATE_LIMITED", msg("rate limited"), { provider, status });
  }
  if (status === 401 || status === 403) return new LlmError("PROVIDER_UNAVAILABLE", msg("credentials rejected or not permitted"), { provider, status });
  if (status === 408 || status >= 500) return new LlmError("PROVIDER_UNAVAILABLE", msg("provider unavailable"), { provider, status });
  if (status >= 400) return new LlmError("INVALID_REQUEST", msg("request rejected"), { provider, status });
  return new LlmError("MODEL_FAILURE", msg("unexpected response"), { provider, status });
}

// Map a thrown network-level error (fetch rejection, abort, timeout).
export function classifyNetworkError(provider: ProviderId, err: unknown): LlmError {
  if (isLlmError(err)) return err;
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string } };
  const detail = [e?.name, e?.code ?? e?.cause?.code, e?.message].filter(Boolean).join(" ").slice(0, 200);
  return new LlmError("PROVIDER_UNAVAILABLE", `${provider}: unreachable or timed out — ${detail || "network error"}`, { provider, cause: err });
}

// Whether the router may move on to the NEXT APPROVED FREE provider after this
// error. INVALID_REQUEST is a bug in our request, so it is not retried
// elsewhere. This never implies trying anything that is not on the free list.
export function canTryNextFreeProvider(e: LlmError): boolean {
  return e.kind !== "INVALID_REQUEST";
}
