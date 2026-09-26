// Provider-neutral LLM interface (Phase 2, commit 1).
//
// This is the ONLY shape the rest of Mission Control will use to talk to a
// language model. It deliberately has:
//   - no model name, base URL, API key or other provider knob — a provider
//     adapter is constructed with its own fixed, allowlisted model, and the
//     free-only router (a later commit) is the only thing that picks one;
//   - no provider-specific parameters (thinking budgets, cache control,
//     "effort", safety settings…). Those stay inside each adapter.
// assertGenericRequest() enforces the second point at runtime, so a caller
// can't smuggle `model`, `baseURL`, `thinking` etc. through an `as any`.
//
// Pure types + helpers: no I/O, no SDK imports.

export type ProviderId = "ollama" | "gemini";

// JSON Schema object used for tool parameters and structured output.
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface LlmToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface LlmToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type LlmMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: LlmToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export interface LlmRequest {
  system?: string;
  messages: LlmMessage[];
  // Tools the model may call on THIS request. Execution is still gated by
  // lib/tool-guard.ts: only tools offered here may ever be dispatched.
  tools?: LlmToolSpec[];
  // Ask for a JSON object (optionally matching a schema) instead of prose.
  json?: { schema?: JsonSchema };
  maxOutputTokens: number;
  temperature?: number;
  // Streaming: adapters that support it call this with text as it arrives;
  // the final LlmResponse still carries the full text.
  onTextDelta?: (delta: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  // true when the provider didn't report counts and they were estimated.
  estimated: boolean;
}

export type LlmStopReason = "end" | "tool_calls" | "max_tokens";

export interface LlmResponse {
  text: string;
  toolCalls: LlmToolCall[];
  stopReason: LlmStopReason;
  usage: LlmUsage;
  provider: ProviderId;
  model: string; // the adapter's fixed model id, for logging/usage only
}

// Every provider adapter implements exactly this.
export interface LlmProvider {
  readonly id: ProviderId;
  readonly model: string;
  generate(req: LlmRequest): Promise<LlmResponse>;
  // Cheap reachability check (e.g. Ollama running locally). Never throws.
  isAvailable(): Promise<boolean>;
}

const ALLOWED_REQUEST_KEYS: ReadonlySet<string> = new Set<keyof LlmRequest>([
  "system", "messages", "tools", "json", "maxOutputTokens", "temperature", "onTextDelta", "timeoutMs", "signal",
]);

export const MAX_OUTPUT_TOKENS_CEILING = 8192;

// Runtime guard: rejects provider-specific or model-selecting fields and
// obviously invalid values. Returns the request unchanged when valid.
export function assertGenericRequest(req: LlmRequest): LlmRequest {
  if (!req || typeof req !== "object") throw new TypeError("LLM request must be an object");
  const unknown = Object.keys(req).filter((k) => !ALLOWED_REQUEST_KEYS.has(k));
  if (unknown.length) {
    throw new TypeError(`LLM request has non-generic field(s): ${unknown.join(", ")} — provider/model options belong inside adapters`);
  }
  if (!Array.isArray(req.messages) || req.messages.length === 0) throw new TypeError("LLM request needs at least one message");
  if (!Number.isInteger(req.maxOutputTokens) || req.maxOutputTokens < 1 || req.maxOutputTokens > MAX_OUTPUT_TOKENS_CEILING) {
    throw new TypeError(`maxOutputTokens must be an integer in 1..${MAX_OUTPUT_TOKENS_CEILING}`);
  }
  if (req.temperature !== undefined && (typeof req.temperature !== "number" || req.temperature < 0 || req.temperature > 2)) {
    throw new TypeError("temperature must be between 0 and 2");
  }
  const names = new Set<string>();
  for (const t of req.tools ?? []) {
    if (!t || typeof t.name !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(t.name)) throw new TypeError(`invalid tool name: ${String(t?.name)}`);
    if (names.has(t.name)) throw new TypeError(`duplicate tool: ${t.name}`);
    names.add(t.name);
    if (!t.parameters || t.parameters.type !== "object") throw new TypeError(`tool ${t.name} parameters must be a JSON object schema`);
  }
  if (req.tools?.length && req.json) throw new TypeError("a request can use tools or JSON output, not both");
  return req;
}

// Rough token estimate (~4 chars/token) for providers that don't report usage
// and for pre-flight quota checks. Deliberately rounds up.
export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

export function estimateRequestTokens(req: Pick<LlmRequest, "system" | "messages" | "tools">): number {
  let chars = (req.system ?? "").length;
  for (const m of req.messages) {
    chars += m.content.length;
    if (m.role === "assistant" && m.toolCalls) chars += JSON.stringify(m.toolCalls).length;
  }
  if (req.tools?.length) chars += JSON.stringify(req.tools).length;
  return Math.ceil(chars / 4);
}

// Converts the tool definitions already used by tools/registry.ts
// ({ name, description, input_schema }) to the neutral shape, without
// importing any SDK type.
export function toLlmToolSpec(t: { name: string; description?: string; input_schema: { type: string; properties?: unknown; required?: string[] } }): LlmToolSpec {
  return {
    name: t.name,
    description: t.description ?? "",
    parameters: {
      type: "object",
      properties: (t.input_schema.properties as Record<string, unknown>) ?? {},
      ...(t.input_schema.required ? { required: t.input_schema.required } : {}),
    },
  };
}
