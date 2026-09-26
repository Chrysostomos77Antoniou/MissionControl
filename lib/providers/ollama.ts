// Local Ollama provider (Phase 2, commit 2).
//
// Mission Control is local-only; Ollama is the primary model runtime.
// Endpoint and model are FIXED here — not read from environment variables,
// request fields or anywhere else — so nothing can point this adapter at a
// remote or paid service or swap in another model:
//   endpoint: http://127.0.0.1:11434   (loopback only)
//   model:    qwen3.5:4b
//
// Implements the provider-neutral LlmProvider from lib/llm.ts. It never
// retries, never falls back to another provider (the free-only router decides
// that), and only forwards the tools the caller explicitly supplied — Phase 1's
// offered-tool check (lib/tool-guard.ts) still gates execution of whatever
// tool calls come back.

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

export const OLLAMA_ENDPOINT = "http://127.0.0.1:11434" as const;
export const OLLAMA_MODEL = "qwen3.5:4b" as const;

const DEFAULT_TIMEOUT_MS = 180_000; // CPU-only inference on this machine can be slow
const AVAILABILITY_TIMEOUT_MS = 2_000;
const MIN_CTX = 4_096;
const MAX_CTX = 16_384; // bounded by the machine's RAM (~15 GB total)

type OllamaToolCall = { id?: string; function?: { name?: unknown; arguments?: unknown } };
type OllamaChunk = {
  message?: { content?: unknown; tool_calls?: OllamaToolCall[] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
};

function toOllamaMessages(req: LlmRequest) {
  const out: Record<string, unknown>[] = [];
  if (req.system) out.push({ role: "system", content: req.system });
  for (const m of req.messages as LlmMessage[]) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.content,
        ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.input } })) } : {}),
      });
    } else out.push({ role: "tool", tool_name: m.name, content: m.isError ? `ERROR: ${m.content}` : m.content });
  }
  return out;
}

function contextSizeFor(req: LlmRequest): number {
  const needed = estimateRequestTokens(req) + req.maxOutputTokens + 512;
  if (needed > MAX_CTX) {
    // Too big for the local model's configured context: not a bad request in
    // general, just not something this provider can serve.
    throw new LlmError("PROVIDER_UNAVAILABLE", `ollama: request needs ~${needed} tokens of context; local limit is ${MAX_CTX}`, { provider: "ollama" });
  }
  return Math.max(MIN_CTX, Math.ceil(needed / 1024) * 1024);
}

function parseToolCalls(raw: OllamaToolCall[] | undefined, startIndex: number): LlmToolCall[] {
  if (!raw) return [];
  if (!Array.isArray(raw)) throw new LlmError("MODEL_FAILURE", "ollama: tool_calls is not an array", { provider: "ollama" });
  return raw.map((c, i) => {
    const name = c?.function?.name;
    let args = c?.function?.arguments ?? {};
    if (typeof name !== "string" || !name) throw new LlmError("MODEL_FAILURE", "ollama: tool call without a name", { provider: "ollama" });
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        throw new LlmError("MODEL_FAILURE", `ollama: tool call ${name} has non-JSON arguments`, { provider: "ollama" });
      }
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new LlmError("MODEL_FAILURE", `ollama: tool call ${name} arguments are not an object`, { provider: "ollama" });
    }
    return { id: typeof c.id === "string" && c.id ? c.id : `ollama-call-${startIndex + i}`, name, input: args as Record<string, unknown> };
  });
}

function combinedSignal(req: LlmRequest): AbortSignal {
  const timeout = AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
}

function toLlmError(req: LlmRequest, err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (req.signal?.aborted) {
    // Caller cancelled: not a provider fault, so it must not trigger fallback.
    return new LlmError("INVALID_REQUEST", "ollama: request cancelled by caller", { provider: "ollama", cause: err });
  }
  return classifyNetworkError("ollama", err);
}

async function readChunks(res: Response, onChunk: (c: OllamaChunk) => void): Promise<void> {
  if (!res.body) throw new LlmError("MODEL_FAILURE", "ollama: empty streaming body", { provider: "ollama" });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onChunk(parseChunk(line));
    }
  }
  if (buf.trim()) onChunk(parseChunk(buf.trim()));
}

function parseChunk(line: string): OllamaChunk {
  try {
    const c = JSON.parse(line) as OllamaChunk;
    if (!c || typeof c !== "object") throw new Error("not an object");
    return c;
  } catch {
    throw new LlmError("MODEL_FAILURE", "ollama: malformed response", { provider: "ollama" });
  }
}

async function generate(req: LlmRequest): Promise<LlmResponse> {
  assertGenericRequest(req);
  const numCtx = contextSizeFor(req);
  const stream = typeof req.onTextDelta === "function";
  const body: Record<string, unknown> = {
    model: OLLAMA_MODEL,
    messages: toOllamaMessages(req),
    stream,
    think: false, // thinking mode off: far slower on CPU and not needed for these tasks
    options: { num_ctx: numCtx, num_predict: req.maxOutputTokens, ...(req.temperature !== undefined ? { temperature: req.temperature } : {}) },
  };
  // Only the tools the caller supplied — never a registry lookup.
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
  if (req.json) body.format = req.json.schema ?? "json";

  let text = "";
  const toolCalls: LlmToolCall[] = [];
  let final: OllamaChunk | null = null;
  const absorb = (c: OllamaChunk) => {
    if (c.error) throw new LlmError("MODEL_FAILURE", `ollama: ${String(c.error).slice(0, 200)}`, { provider: "ollama" });
    const piece = c.message?.content;
    if (piece !== undefined && piece !== null && typeof piece !== "string") {
      throw new LlmError("MODEL_FAILURE", "ollama: message content is not text", { provider: "ollama" });
    }
    if (piece) {
      text += piece;
      if (stream) req.onTextDelta!(piece);
    }
    toolCalls.push(...parseToolCalls(c.message?.tool_calls, toolCalls.length));
    if (c.done) final = c;
  };

  try {
    const res = await fetch(`${OLLAMA_ENDPOINT}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: combinedSignal(req),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      if (res.status === 404 && /model.*not found|not found.*model|pull/i.test(errBody)) {
        throw new LlmError("PROVIDER_UNAVAILABLE", `ollama: model ${OLLAMA_MODEL} is not installed`, { provider: "ollama", status: 404 });
      }
      throw classifyHttpError("ollama", res.status, errBody);
    }
    if (stream) await readChunks(res, absorb);
    else absorb(parseChunk(await res.text()));
  } catch (e) {
    throw toLlmError(req, e);
  }

  const done = final as OllamaChunk | null;
  if (!done) throw new LlmError("MODEL_FAILURE", "ollama: response ended without completion", { provider: "ollama" });
  if (!text.trim() && toolCalls.length === 0) throw new LlmError("MODEL_FAILURE", "ollama: empty response", { provider: "ollama" });
  if (req.json && toolCalls.length === 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new LlmError("MODEL_FAILURE", "ollama: JSON mode returned invalid JSON", { provider: "ollama" });
    }
    if (!parsed || typeof parsed !== "object") throw new LlmError("MODEL_FAILURE", "ollama: JSON mode did not return an object", { provider: "ollama" });
  }

  const reported = typeof done.prompt_eval_count === "number" && typeof done.eval_count === "number";
  return {
    text,
    toolCalls,
    stopReason: toolCalls.length ? "tool_calls" : done.done_reason === "length" ? "max_tokens" : "end",
    usage: reported
      ? { inputTokens: done.prompt_eval_count!, outputTokens: done.eval_count!, estimated: false }
      : {
          // Ollama omits prompt_eval_count when the whole prompt was cached.
          inputTokens: typeof done.prompt_eval_count === "number" ? done.prompt_eval_count : estimateRequestTokens(req),
          outputTokens: typeof done.eval_count === "number" ? done.eval_count : estimateTokens(text + (toolCalls.length ? JSON.stringify(toolCalls) : "")),
          estimated: true,
        },
    provider: "ollama",
    model: OLLAMA_MODEL,
  };
}

// Lightweight check: is Ollama running locally with the required model?
// Never throws, never retries, never touches any other provider or state.
async function isAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_ENDPOINT}/api/tags`, { signal: AbortSignal.timeout(AVAILABILITY_TIMEOUT_MS) });
    if (!res.ok) return false;
    const data = (await res.json()) as { models?: { name?: string; model?: string }[] };
    return (data.models ?? []).some((m) => m.name === OLLAMA_MODEL || m.model === OLLAMA_MODEL);
  } catch {
    return false;
  }
}

export const ollamaProvider: LlmProvider = Object.freeze({
  id: "ollama" as const,
  model: OLLAMA_MODEL,
  generate,
  isAvailable,
});
