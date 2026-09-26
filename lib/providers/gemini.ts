// Free-tier Gemini provider (Phase 2, commit 3).
//
// INACTIVE until a key from a Google project WITHOUT billing is placed in
// GEMINI_API_KEY. Not wired into the router yet.
//
// Hard rules enforced here:
//   - Only the models in GEMINI_FREE_MODELS can ever be constructed or
//     called. The model is fixed per provider instance; it is never read from
//     env, request, user input or the database. Anything else is rejected
//     before a network request is made.
//   - The only network destination is Google's Generative Language API.
//   - The API key is read from the environment inside this adapter only, sent
//     in the x-goog-api-key header (never in a URL), and redacted from every
//     error message.
//   - No retries, no switching models, no fallback: 402 / billing / daily
//     quota -> QUOTA_EXHAUSTED; per-minute throttling -> RATE_LIMITED. The
//     free-only router (later commit) decides what happens next.
//   - Only caller-supplied tools are forwarded; Phase 1's offered-tool check
//     still decides whether a returned tool call may execute.
//
// Quota metadata below is informational; 80% enforcement lives in the router.

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

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta" as const;

// Verified free-tier limits for this account (AI Studio, 2026-09-26).
export const GEMINI_FREE_MODELS = Object.freeze({
  "gemini-3.5-flash-lite": Object.freeze({ requestsPerMinute: 15, inputTokensPerMinute: 250_000, requestsPerDay: 500 }),
  "gemini-3.1-flash-lite": Object.freeze({ requestsPerMinute: 15, inputTokensPerMinute: 250_000, requestsPerDay: 500 }),
  "gemini-3.8-flash": Object.freeze({ requestsPerMinute: 5, inputTokensPerMinute: 250_000, requestsPerDay: 20 }),
});
export type GeminiFreeModel = keyof typeof GEMINI_FREE_MODELS;

export function isGeminiFreeModel(m: unknown): m is GeminiFreeModel {
  return typeof m === "string" && Object.prototype.hasOwnProperty.call(GEMINI_FREE_MODELS, m);
}

const DEFAULT_TIMEOUT_MS = 60_000;

type GeminiPart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name?: unknown; args?: unknown };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
};
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };
type GeminiResponse = {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  error?: { message?: string };
};

// ---- tool-call ids --------------------------------------------------------
// Gemini 3 attaches a thoughtSignature to function-call parts that must be
// sent back with the call on the next turn. The generic interface only has an
// opaque tool-call id, so the signature (and Gemini's own call id, if any) is
// carried inside that id and decoded here. Nothing provider-specific leaks
// into LlmToolCall.
const ID_PREFIX = "gc~";
function encodeCallId(index: number, geminiId: string | undefined, sig: string | undefined): string {
  return `${ID_PREFIX}${index}~${geminiId ?? ""}~${sig ?? ""}`;
}
function decodeCallId(id: string): { geminiId?: string; sig?: string } {
  if (!id.startsWith(ID_PREFIX)) return {};
  const [, geminiId, sig] = id.slice(ID_PREFIX.length).split("~");
  return { geminiId: geminiId || undefined, sig: sig || undefined };
}

// ---- request translation -------------------------------------------------
function toContents(messages: LlmMessage[]): GeminiContent[] {
  const out: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", parts: [{ text: m.content }] });
    else if (m.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const c of m.toolCalls ?? []) {
        const { geminiId, sig } = decodeCallId(c.id);
        parts.push({ functionCall: { ...(geminiId ? { id: geminiId } : {}), name: c.name, args: c.input }, ...(sig ? { thoughtSignature: sig } : {}) });
      }
      if (parts.length) out.push({ role: "model", parts });
    } else {
      const { geminiId } = decodeCallId(m.toolCallId);
      const part: GeminiPart = {
        functionResponse: { ...(geminiId ? { id: geminiId } : {}), name: m.name, response: m.isError ? { error: m.content } : { content: m.content } },
      };
      // Consecutive tool results for one model turn go in a single content.
      const last = out[out.length - 1];
      if (last && last.role === "user" && last.parts.every((p) => p.functionResponse)) last.parts.push(part);
      else out.push({ role: "user", parts: [part] });
    }
  }
  return out;
}

function buildBody(req: LlmRequest): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = { maxOutputTokens: req.maxOutputTokens };
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (req.json) {
    generationConfig.responseMimeType = "application/json";
    if (req.json.schema) generationConfig.responseJsonSchema = req.json.schema;
  }
  return {
    contents: toContents(req.messages),
    ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
    // Only the tools the caller supplied — never a registry lookup.
    ...(req.tools?.length
      ? { tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }] }
      : {}),
    generationConfig,
  };
}

// ---- error handling -------------------------------------------------------
function redact(text: string, key: string | undefined): string {
  let out = String(text ?? "");
  if (key) out = out.split(key).join("[redacted-key]");
  return out.replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted-key]");
}

// Gemini's 429 text mentions "billing details" even for ordinary per-minute
// throttling, so 429s are classified from the structured quota details first.
function classifyGeminiHttp(status: number, rawBody: string, key: string | undefined): LlmError {
  const body = redact(rawBody, key);
  if (status === 402) return new LlmError("QUOTA_EXHAUSTED", `gemini: billing/payment required (HTTP 402) — free use unavailable`, { provider: "gemini", status, billing: true });
  if (status === 429) {
    const perDay = /PerDay|per_day|requests_per_day|daily/i.test(body);
    const perMinute = /PerMinute|per_minute|requests_per_minute|tokens_per_minute/i.test(body);
    const zeroLimit = /limit:\s*0\b/.test(body);
    if (perDay || zeroLimit) return new LlmError("QUOTA_EXHAUSTED", `gemini: free daily quota exhausted (HTTP 429)`, { provider: "gemini", status });
    if (perMinute) return new LlmError("RATE_LIMITED", `gemini: per-minute rate limit (HTTP 429)`, { provider: "gemini", status });
    return new LlmError("RATE_LIMITED", `gemini: rate limited (HTTP 429)`, { provider: "gemini", status });
  }
  // Any other billing/payment wording means "free use unavailable" — stop, never pay.
  if (/billing|payment required|prepay|credit balance|insufficient[_ ]quota/i.test(body)) {
    return new LlmError("QUOTA_EXHAUSTED", `gemini: billing required (HTTP ${status}) — free use unavailable`, { provider: "gemini", status, billing: true });
  }
  if (status === 400 && /API_KEY_INVALID|API key not valid|API key expired/i.test(body)) {
    return new LlmError("PROVIDER_UNAVAILABLE", "gemini: API key rejected (HTTP 400)", { provider: "gemini", status });
  }
  if (status === 400 && /FAILED_PRECONDITION|location is not supported/i.test(body)) {
    return new LlmError("PROVIDER_UNAVAILABLE", "gemini: service not available for this project/location (HTTP 400)", { provider: "gemini", status });
  }
  if (status === 404) return new LlmError("PROVIDER_UNAVAILABLE", "gemini: model not available to this project (HTTP 404)", { provider: "gemini", status });
  if (status === 401 || status === 403) {
    return new LlmError("PROVIDER_UNAVAILABLE", `gemini: credentials rejected or not permitted (HTTP ${status})`, { provider: "gemini", status });
  }
  const e = classifyHttpError("gemini", status, body);
  return new LlmError(e.kind, redact(e.message, key), { provider: "gemini", status, billing: e.billing });
}

function toLlmError(req: LlmRequest, err: unknown, key: string | undefined): LlmError {
  if (err instanceof LlmError) return err;
  if (req.signal?.aborted) return new LlmError("INVALID_REQUEST", "gemini: request cancelled by caller", { provider: "gemini" });
  const e = classifyNetworkError("gemini", err);
  // Rebuild without the original error as cause, so nothing un-redacted travels along.
  return new LlmError(e.kind, redact(e.message, key), { provider: "gemini" });
}

// ---- response parsing -----------------------------------------------------
function parseResponse(raw: unknown): GeminiResponse {
  if (!raw || typeof raw !== "object") throw new LlmError("MODEL_FAILURE", "gemini: malformed response", { provider: "gemini" });
  return raw as GeminiResponse;
}

async function readSse(res: Response, onEvent: (r: GeminiResponse) => void): Promise<void> {
  if (!res.body) throw new LlmError("MODEL_FAILURE", "gemini: empty streaming body", { provider: "gemini" });
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
      throw new LlmError("MODEL_FAILURE", "gemini: malformed stream event", { provider: "gemini" });
    }
    onEvent(parseResponse(parsed));
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
export function createGeminiProvider(model: GeminiFreeModel): LlmProvider {
  // Fail closed: anything outside the hard-coded free allowlist is refused
  // here, before any provider object (and therefore any request) can exist.
  if (!isGeminiFreeModel(model)) {
    throw new LlmError("INVALID_REQUEST", `gemini: model "${String(model).slice(0, 60)}" is not on the free-tier allowlist`, { provider: "gemini" });
  }
  const fixedModel: GeminiFreeModel = model;

  async function generate(req: LlmRequest): Promise<LlmResponse> {
    assertGenericRequest(req);
    const key = process.env.GEMINI_API_KEY?.trim();
    if (!key) throw new LlmError("PROVIDER_UNAVAILABLE", "gemini: not configured (no GEMINI_API_KEY)", { provider: "gemini" });

    const stream = typeof req.onTextDelta === "function";
    const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(fixedModel)}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
    const timeout = AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;

    let text = "";
    const toolCalls: LlmToolCall[] = [];
    let finishReason: string | undefined;
    let blockReason: string | undefined;
    let usage: GeminiResponse["usageMetadata"];
    const absorb = (r: GeminiResponse) => {
      if (r.error) throw new LlmError("MODEL_FAILURE", `gemini: ${redact(String(r.error.message ?? "error"), key).slice(0, 200)}`, { provider: "gemini" });
      if (r.promptFeedback?.blockReason) blockReason = r.promptFeedback.blockReason;
      if (r.usageMetadata) usage = r.usageMetadata;
      const cand = r.candidates?.[0];
      if (!cand) return;
      if (cand.finishReason) finishReason = cand.finishReason;
      const parts = cand.content?.parts;
      if (parts !== undefined && !Array.isArray(parts)) throw new LlmError("MODEL_FAILURE", "gemini: parts is not an array", { provider: "gemini" });
      for (const p of parts ?? []) {
        if (!p || typeof p !== "object") throw new LlmError("MODEL_FAILURE", "gemini: malformed part", { provider: "gemini" });
        if (p.functionCall) {
          const { name, args = {}, id } = p.functionCall;
          if (typeof name !== "string" || !name) throw new LlmError("MODEL_FAILURE", "gemini: function call without a name", { provider: "gemini" });
          if (!args || typeof args !== "object" || Array.isArray(args)) throw new LlmError("MODEL_FAILURE", `gemini: function call ${name} arguments are not an object`, { provider: "gemini" });
          toolCalls.push({ id: encodeCallId(toolCalls.length, typeof id === "string" ? id : undefined, p.thoughtSignature), name, input: args as Record<string, unknown> });
        } else if (typeof p.text === "string" && !p.thought) {
          text += p.text;
          if (stream && p.text) req.onTextDelta!(p.text);
        } else if (p.text !== undefined && typeof p.text !== "string") {
          throw new LlmError("MODEL_FAILURE", "gemini: part text is not a string", { provider: "gemini" });
        }
      }
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(buildBody(req)),
        signal,
      });
      if (!res.ok) throw classifyGeminiHttp(res.status, await res.text().catch(() => ""), key);
      if (stream) await readSse(res, absorb);
      else {
        let raw: unknown;
        try {
          raw = JSON.parse(await res.text());
        } catch {
          throw new LlmError("MODEL_FAILURE", "gemini: malformed response", { provider: "gemini" });
        }
        absorb(parseResponse(raw));
      }
    } catch (e) {
      throw toLlmError(req, e, key);
    }

    if (blockReason) throw new LlmError("MODEL_FAILURE", `gemini: prompt blocked (${blockReason})`, { provider: "gemini" });
    if (!text.trim() && toolCalls.length === 0) {
      throw new LlmError("MODEL_FAILURE", `gemini: empty response${finishReason ? ` (${finishReason})` : ""}`, { provider: "gemini" });
    }
    if (finishReason === "MALFORMED_FUNCTION_CALL") throw new LlmError("MODEL_FAILURE", "gemini: malformed function call", { provider: "gemini" });
    if (req.json && toolCalls.length === 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new LlmError("MODEL_FAILURE", "gemini: JSON mode returned invalid JSON", { provider: "gemini" });
      }
      if (!parsed || typeof parsed !== "object") throw new LlmError("MODEL_FAILURE", "gemini: JSON mode did not return an object", { provider: "gemini" });
    }

    const reported = typeof usage?.promptTokenCount === "number" && typeof usage?.candidatesTokenCount === "number";
    return {
      text,
      toolCalls,
      stopReason: toolCalls.length ? "tool_calls" : finishReason === "MAX_TOKENS" ? "max_tokens" : "end",
      usage: reported
        ? { inputTokens: usage!.promptTokenCount!, outputTokens: usage!.candidatesTokenCount! + (usage!.thoughtsTokenCount ?? 0), estimated: false }
        : { inputTokens: estimateRequestTokens(req), outputTokens: estimateTokens(text + (toolCalls.length ? JSON.stringify(toolCalls) : "")), estimated: true },
      provider: "gemini",
      model: fixedModel,
    };
  }

  // Configured = a key is present. Deliberately makes NO network request, so
  // availability checks never consume free quota.
  async function isAvailable(): Promise<boolean> {
    return !!process.env.GEMINI_API_KEY?.trim();
  }

  return Object.freeze({ id: "gemini" as const, model: fixedModel, generate, isAvailable });
}
