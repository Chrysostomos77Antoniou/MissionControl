// Free-plan Groq provider.
//
// INACTIVE until a key from a Groq organization on the FREE plan (no payment
// method, never upgraded to the Developer plan) is placed in GROQ_API_KEY.
//
// Hard rules enforced here (same as lib/providers/gemini.ts):
//   - Exactly ONE model can ever be called: GROQ_MODEL. It is fixed in code;
//     it is never read from env, request, user input or the database.
//   - The only network destination is Groq's OpenAI-compatible API
//     (GROQ_API_BASE). No base-URL override exists.
//   - The API key is read from the environment inside this adapter only, sent
//     in the Authorization header (never in a URL), and redacted from every
//     error message. No key -> PROVIDER_UNAVAILABLE with NO network request.
//   - No retries, no switching models, no fallback. Billing/payment wording or
//     a spend-limit block -> QUOTA_EXHAUSTED (billing); daily token/request
//     limit -> QUOTA_EXHAUSTED; per-minute throttling -> RATE_LIMITED. The
//     free-only router (lib/free-llm.ts) decides what happens next.
//   - Only caller-supplied tools are forwarded; Phase 1's offered-tool check
//     still decides whether a returned tool call may execute.
//
// Free-plan limits below are documentation metadata (verified 2026-09-28 in
// Groq's docs, console.groq.com/docs/rate-limits, "Free Plan Limits" table). The
// local daily ceiling lives in the router; the per-minute token limit is used
// here to refuse requests that cannot fit, without sending them.

import {
  assertGenericRequest,
  estimateRequestTokens,
  estimateTokens,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmToolCall,
} from "../llm";
import { LlmError, classifyHttpError, classifyNetworkError } from "../llm-errors";

export const GROQ_API_BASE = "https://api.groq.com/openai/v1" as const;
export const GROQ_MODEL = "openai/gpt-oss-120b" as const;

// Official Free Plan limits for GROQ_MODEL (console.groq.com/docs/rate-limits).
export const GROQ_FREE_LIMITS = Object.freeze({
  requestsPerMinute: 30,
  requestsPerDay: 1_000,
  tokensPerMinute: 8_000,
  tokensPerDay: 200_000,
});

// Groq is a fast hosted service: a request that has not answered in 30 s is
// treated as unavailable so the router can move on (a dead remote provider must
// not eat the agent's deadline).
const DEFAULT_TIMEOUT_MS = 30_000;

type GroqToolCall = { index?: number; id?: unknown; type?: string; function?: { name?: unknown; arguments?: unknown } };
type GroqMessage = { content?: unknown; tool_calls?: GroqToolCall[]; reasoning?: unknown };
type GroqUsage = { prompt_tokens?: number; completion_tokens?: number };
type GroqCompletion = {
  choices?: { message?: GroqMessage; delta?: GroqMessage; finish_reason?: string | null }[];
  usage?: GroqUsage;
  x_groq?: { usage?: GroqUsage };
  error?: { message?: string };
};

// ---- request translation -------------------------------------------------
// Tool-call ids from other providers can be long or use unusual characters
// (Gemini packs a thought signature into its ids). Groq only needs each tool
// result to reference its call, so ids are re-numbered per request.
function toGroqMessages(req: LlmRequest): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const ids = new Map<string, string>();
  const idFor = (original: string) => {
    let id = ids.get(original);
    if (!id) {
      id = `call_${ids.size}`;
      ids.set(original, id);
    }
    return id;
  };
  if (req.system) out.push({ role: "system", content: req.system });
  for (const m of req.messages as LlmMessage[]) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      const calls = m.toolCalls ?? [];
      out.push({
        role: "assistant",
        content: m.content || (calls.length ? null : ""),
        ...(calls.length
          ? { tool_calls: calls.map((c) => ({ id: idFor(c.id), type: "function", function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) }
          : {}),
      });
    } else {
      out.push({ role: "tool", tool_call_id: idFor(m.toolCallId), name: m.name, content: m.isError ? `ERROR: ${m.content}` : m.content });
    }
  }
  return out;
}

function buildBody(req: LlmRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: GROQ_MODEL,
    messages: toGroqMessages(req),
    max_completion_tokens: req.maxOutputTokens,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
  };
  // Only the tools the caller supplied — never a registry lookup.
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
  if (req.json) {
    // Best-effort schema mode (strict mode needs schema restrictions callers
    // don't guarantee). The result is always validated below either way.
    body.response_format = req.json.schema
      ? { type: "json_schema", json_schema: { name: "response", schema: req.json.schema, strict: false } }
      : { type: "json_object" };
  }
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  return body;
}

// ---- error handling -------------------------------------------------------
function redact(text: string, key: string | undefined): string {
  let out = String(text ?? "");
  if (key) out = out.split(key).join("[redacted-key]");
  return out.replace(/gsk_[0-9A-Za-z]{8,}/g, "[redacted-key]").replace(/Bearer\s+\S+/gi, "Bearer [redacted-key]");
}

function classifyGroqHttp(status: number, rawBody: string, key: string | undefined): LlmError {
  const body = redact(rawBody, key);
  const snippet = body.replace(/\s+/g, " ").slice(0, 200);
  const err = (kind: LlmError["kind"], what: string, billing = false) =>
    new LlmError(kind, `groq: ${what} (HTTP ${status})${snippet ? ` — ${snippet}` : ""}`, { provider: "groq", status, billing });

  // Payment required, or a spend-limit block (only possible on a paid plan):
  // "free use unavailable" — stop, never pay.
  if (status === 402 || /blocked_api_access/i.test(body)) return err("QUOTA_EXHAUSTED", "billing/payment required — free use unavailable", true);
  // Groq's 429/413 texts advertise a paid upgrade ("… settings/billing") even
  // for ordinary throttling, so they are classified before billing wording.
  if (status === 429) {
    // Daily request/token allowance used up -> exhausted for today; anything
    // else (per-minute requests/tokens) is ordinary throttling.
    if (/per day|\bTPD\b|\bRPD\b|daily/i.test(body)) return err("QUOTA_EXHAUSTED", "free daily limit reached");
    return err("RATE_LIMITED", "rate limited");
  }
  // A request larger than the free per-minute token budget can never be
  // served by this provider; another free provider may still serve it.
  if (status === 413) return err("PROVIDER_UNAVAILABLE", "request too large for the free plan");
  // Any other payment signal means "free use unavailable" — stop, never pay.
  if (/billing|payment required|insufficient[_ ]quota|credit balance|upgrade (your )?plan/i.test(body)) {
    return err("QUOTA_EXHAUSTED", "billing/payment required — free use unavailable", true);
  }
  // The model produced an unusable tool call / JSON: a model failure, not a bug
  // in our request (so the router may try the next free provider).
  if (status === 400 && /tool_use_failed|json_validate_failed/i.test(body)) return err("MODEL_FAILURE", "model output rejected by Groq");
  if (status === 401 || status === 403) return err("PROVIDER_UNAVAILABLE", "credentials rejected or not permitted");
  if (status === 404) return err("PROVIDER_UNAVAILABLE", "model not available to this organization");
  if (status === 498) return err("PROVIDER_UNAVAILABLE", "capacity exceeded");
  const e = classifyHttpError("groq", status, body);
  return new LlmError(e.kind, redact(e.message, key), { provider: "groq", status, billing: e.billing });
}

function toLlmError(req: LlmRequest, err: unknown, key: string | undefined): LlmError {
  if (err instanceof LlmError) return err;
  if (req.signal?.aborted) return new LlmError("INVALID_REQUEST", "groq: request cancelled by caller", { provider: "groq" });
  const e = classifyNetworkError("groq", err);
  // Rebuilt without the original error as cause, so nothing un-redacted travels along.
  return new LlmError(e.kind, redact(e.message, key), { provider: "groq" });
}

// ---- response parsing -----------------------------------------------------
function parseArgs(name: string, raw: unknown): Record<string, unknown> {
  let args: unknown = raw ?? {};
  if (typeof args === "string") {
    if (!args.trim()) return {};
    try {
      args = JSON.parse(args);
    } catch {
      throw new LlmError("MODEL_FAILURE", `groq: tool call ${name} has non-JSON arguments`, { provider: "groq" });
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new LlmError("MODEL_FAILURE", `groq: tool call ${name} arguments are not an object`, { provider: "groq" });
  }
  return args as Record<string, unknown>;
}

function toToolCalls(raw: GroqToolCall[]): LlmToolCall[] {
  return raw.map((c, i) => {
    const name = c?.function?.name;
    if (typeof name !== "string" || !name) throw new LlmError("MODEL_FAILURE", "groq: tool call without a name", { provider: "groq" });
    return { id: typeof c.id === "string" && c.id ? c.id : `groq-call-${i}`, name, input: parseArgs(name, c.function?.arguments) };
  });
}

function parseCompletion(raw: unknown): GroqCompletion {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new LlmError("MODEL_FAILURE", "groq: malformed response", { provider: "groq" });
  return raw as GroqCompletion;
}

async function readSse(res: Response, onEvent: (c: GroqCompletion) => void): Promise<void> {
  if (!res.body) throw new LlmError("MODEL_FAILURE", "groq: empty streaming body", { provider: "groq" });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const handle = (line: string) => {
    const t = line.trim();
    if (!t.startsWith("data:")) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new LlmError("MODEL_FAILURE", "groq: malformed stream event", { provider: "groq" });
    }
    onEvent(parseCompletion(parsed));
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      handle(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.trim()) handle(buf);
}

// ---- provider -------------------------------------------------------------
async function generate(req: LlmRequest): Promise<LlmResponse> {
  assertGenericRequest(req);
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) throw new LlmError("PROVIDER_UNAVAILABLE", "groq: not configured (no GROQ_API_KEY)", { provider: "groq" });

  // A prompt larger than the free per-minute token budget can never succeed;
  // refuse it here instead of spending a free request on a certain 413.
  const promptTokens = estimateRequestTokens(req);
  if (promptTokens > GROQ_FREE_LIMITS.tokensPerMinute) {
    throw new LlmError("PROVIDER_UNAVAILABLE", `groq: request needs ~${promptTokens} input tokens; the free plan allows ${GROQ_FREE_LIMITS.tokensPerMinute} per minute`, { provider: "groq" });
  }

  // Groq does not support streaming together with structured output, so JSON
  // requests are answered in one piece (the caller still gets the full text).
  const stream = typeof req.onTextDelta === "function" && !req.json;
  const timeout = AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;

  let text = "";
  let toolCalls: LlmToolCall[] = [];
  let finishReason: string | undefined;
  let usage: GroqUsage | undefined;

  try {
    const res = await fetch(`${GROQ_API_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(buildBody(req, stream)),
      signal,
    });
    if (!res.ok) throw classifyGroqHttp(res.status, await res.text().catch(() => ""), key);

    if (stream) {
      // Tool-call fragments arrive per index; arguments are streamed as text.
      const partial = new Map<number, { id?: string; name?: string; args: string }>();
      await readSse(res, (c) => {
        if (c.error) throw new LlmError("MODEL_FAILURE", `groq: ${redact(String(c.error.message ?? "error"), key).slice(0, 200)}`, { provider: "groq" });
        if (c.usage) usage = c.usage;
        if (c.x_groq?.usage) usage = c.x_groq.usage;
        const choice = c.choices?.[0];
        if (!choice) return;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const d = choice.delta;
        if (!d) return;
        if (d.content !== undefined && d.content !== null) {
          if (typeof d.content !== "string") throw new LlmError("MODEL_FAILURE", "groq: delta content is not text", { provider: "groq" });
          if (d.content) {
            text += d.content;
            req.onTextDelta!(d.content);
          }
        }
        if (d.tool_calls !== undefined) {
          if (!Array.isArray(d.tool_calls)) throw new LlmError("MODEL_FAILURE", "groq: tool_calls is not an array", { provider: "groq" });
          for (const [pos, tc] of d.tool_calls.entries()) {
            const idx = typeof tc?.index === "number" ? tc.index : pos;
            const p = partial.get(idx) ?? { args: "" };
            if (typeof tc?.id === "string" && tc.id) p.id = tc.id;
            if (typeof tc?.function?.name === "string" && tc.function.name) p.name = tc.function.name;
            if (typeof tc?.function?.arguments === "string") p.args += tc.function.arguments;
            partial.set(idx, p);
          }
        }
      });
      toolCalls = toToolCalls([...partial.entries()].sort(([a], [b]) => a - b).map(([, p]) => ({ id: p.id, function: { name: p.name, arguments: p.args } })));
    } else {
      let raw: unknown;
      try {
        raw = JSON.parse(await res.text());
      } catch {
        throw new LlmError("MODEL_FAILURE", "groq: malformed response", { provider: "groq" });
      }
      const c = parseCompletion(raw);
      if (c.error) throw new LlmError("MODEL_FAILURE", `groq: ${redact(String(c.error.message ?? "error"), key).slice(0, 200)}`, { provider: "groq" });
      const choice = c.choices?.[0];
      if (!choice || !choice.message || typeof choice.message !== "object") throw new LlmError("MODEL_FAILURE", "groq: response has no message", { provider: "groq" });
      const content = choice.message.content;
      if (content !== undefined && content !== null && typeof content !== "string") throw new LlmError("MODEL_FAILURE", "groq: message content is not text", { provider: "groq" });
      text = content ?? "";
      const rawCalls = choice.message.tool_calls;
      if (rawCalls !== undefined && rawCalls !== null && !Array.isArray(rawCalls)) throw new LlmError("MODEL_FAILURE", "groq: tool_calls is not an array", { provider: "groq" });
      toolCalls = toToolCalls(rawCalls ?? []);
      finishReason = choice.finish_reason ?? undefined;
      usage = c.usage;
    }
  } catch (e) {
    throw toLlmError(req, e, key);
  }

  if (!text.trim() && toolCalls.length === 0) {
    throw new LlmError("MODEL_FAILURE", `groq: empty response${finishReason ? ` (${finishReason})` : ""}`, { provider: "groq" });
  }
  if (req.json && toolCalls.length === 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new LlmError("MODEL_FAILURE", "groq: JSON mode returned invalid JSON", { provider: "groq" });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new LlmError("MODEL_FAILURE", "groq: JSON mode did not return an object", { provider: "groq" });
  }
  // Unstreamed answer to a streaming caller: hand over the validated text once.
  if (!stream && text && typeof req.onTextDelta === "function") req.onTextDelta(text);

  const reported = typeof usage?.prompt_tokens === "number" && typeof usage?.completion_tokens === "number";
  return {
    text,
    toolCalls,
    stopReason: toolCalls.length ? "tool_calls" : finishReason === "length" ? "max_tokens" : "end",
    usage: reported
      ? { inputTokens: usage!.prompt_tokens!, outputTokens: usage!.completion_tokens!, estimated: false }
      : { inputTokens: promptTokens, outputTokens: estimateTokens(text + (toolCalls.length ? JSON.stringify(toolCalls) : "")), estimated: true },
    provider: "groq",
    model: GROQ_MODEL,
  };
}

// Configured = a key is present. Deliberately makes NO network request, so
// availability checks never consume free quota.
async function isAvailable(): Promise<boolean> {
  return !!process.env.GROQ_API_KEY?.trim();
}

export const groqProvider: LlmProvider = Object.freeze({
  id: "groq" as const,
  model: GROQ_MODEL,
  generate,
  isAvailable,
});
