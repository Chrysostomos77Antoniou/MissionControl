import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { groqProvider, GROQ_API_BASE, GROQ_MODEL, GROQ_FREE_LIMITS } from "../providers/groq";
import { LlmError } from "../llm-errors";
import type { LlmRequest, LlmToolSpec } from "../llm";

// Fake keys assembled from pieces; not key-shaped for any secret scanner.
const KEY = ["TESTONLY", "groq", "key", "0123456789"].join("-");
// A value shaped like a real Groq key, built at runtime only (never a literal).
const KEYLIKE = ["gsk", "_", "Zz".repeat(26)].join("");
const URL_ = `${GROQ_API_BASE}/chat/completions`;
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const completion = (message: Record<string, unknown>, finish_reason = "stop", usage: unknown = { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 }) =>
  json({ id: "chatcmpl-1", object: "chat.completion", model: GROQ_MODEL, choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason }], usage });
const errBody = (status: number, message: string, extra: Record<string, unknown> = {}) => json({ error: { message, type: "invalid_request_error", ...extra } }, status);
const sse = (events: unknown[], trailer = "data: [DONE]\n\n") =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const e of events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`));
        c.enqueue(new TextEncoder().encode(trailer));
        c.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null, extra: Record<string, unknown> = {}) => ({ object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }], ...extra });
const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({ messages: [{ role: "user", content: "hello" }], maxOutputTokens: 64, ...over });
const tool = (name: string): LlmToolSpec => ({ name, description: `${name} tool`, parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } });
const sent = (i = 0) => ({ url: String(fetchMock.mock.calls[i][0]), init: fetchMock.mock.calls[i][1] as RequestInit, body: JSON.parse(fetchMock.mock.calls[i][1].body as string) });
const failure = async (p: Promise<unknown>): Promise<LlmError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof LlmError) return e;
    throw e;
  }
  throw new Error("expected rejection");
};

let savedEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  process.env.GROQ_API_KEY = KEY;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  process.env = savedEnv;
  vi.unstubAllGlobals();
});

describe("groq: allowlist and configuration", () => {
  it("has one fixed model and one fixed endpoint", async () => {
    expect(groqProvider.id).toBe("groq");
    expect(groqProvider.model).toBe("openai/gpt-oss-120b");
    fetchMock.mockResolvedValue(completion({ content: "hi" }));
    const r = await groqProvider.generate(req());
    expect([r.provider, r.model]).toEqual(["groq", "openai/gpt-oss-120b"]);
    expect(sent().url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(sent().body.model).toBe("openai/gpt-oss-120b");
  });

  it("exposes the documented free-plan limits as frozen metadata", () => {
    expect(GROQ_FREE_LIMITS).toEqual({ requestsPerMinute: 30, requestsPerDay: 1000, tokensPerMinute: 8000, tokensPerDay: 200000 });
    expect(Object.isFrozen(GROQ_FREE_LIMITS)).toBe(true);
  });

  it("provider object is frozen (model cannot be swapped)", () => {
    expect(Object.isFrozen(groqProvider)).toBe(true);
    expect(() => {
      (groqProvider as { model: string }).model = "openai/gpt-oss-20b";
    }).toThrow();
  });

  it("env vars cannot change the model or the endpoint", async () => {
    Object.assign(process.env, { GROQ_MODEL: "llama-3.3-70b", GROQ_BASE_URL: "https://evil.example", OPENAI_BASE_URL: "https://evil.example", LLM_BASE_URL: "https://evil.example" });
    fetchMock.mockResolvedValue(completion({ content: "x" }));
    await groqProvider.generate(req());
    expect(sent().url).toBe(URL_);
    expect(sent().body.model).toBe(GROQ_MODEL);
  });

  it.each(["model", "baseURL", "apiKey", "provider", "reasoning_effort", "response_format", "key"])(
    "rejects non-generic request field %s before any network request",
    async (k) => {
      await expect(groqProvider.generate({ ...req(), [k]: "x" } as unknown as LlmRequest)).rejects.toThrow(/non-generic field/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("missing key -> PROVIDER_UNAVAILABLE with no request; isAvailable() makes no network call", async () => {
    delete process.env.GROQ_API_KEY;
    expect((await failure(groqProvider.generate(req()))).kind).toBe("PROVIDER_UNAVAILABLE");
    expect(await groqProvider.isAvailable()).toBe(false);
    process.env.GROQ_API_KEY = "   ";
    expect((await failure(groqProvider.generate(req()))).kind).toBe("PROVIDER_UNAVAILABLE");
    expect(await groqProvider.isAvailable()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    process.env.GROQ_API_KEY = KEY;
    expect(await groqProvider.isAvailable()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the key only in the Authorization header, never in the URL or body", async () => {
    fetchMock.mockResolvedValue(completion({ content: "x" }));
    await groqProvider.generate(req());
    const { url, init } = sent();
    expect(url).not.toContain(KEY);
    expect(String(init.body)).not.toContain(KEY);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });

  it("a prompt larger than the free per-minute token budget is refused without a request", async () => {
    const big = "x".repeat((GROQ_FREE_LIMITS.tokensPerMinute + 10) * 4);
    const e = await failure(groqProvider.generate(req({ messages: [{ role: "user", content: big }] })));
    expect(e.kind).toBe("PROVIDER_UNAVAILABLE");
    expect(e.message).toMatch(/free plan allows 8000/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the adapter source has one destination and reads only GROQ_API_KEY", () => {
    const src = readFileSync(join(__dirname, "..", "providers", "groq.ts"), "utf8");
    const hosts = new Set((src.match(/https?:\/\/[^\s"'`/,]+/g) ?? []).map((u) => new URL(u).host));
    expect([...hosts]).toEqual(["api.groq.com"]);
    expect([...src.matchAll(/fetch\(([^,]+),/g)].map((m) => m[1])).toEqual(["`${GROQ_API_BASE}/chat/completions`"]);
    expect([...src.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1])).toEqual(["GROQ_API_KEY", "GROQ_API_KEY"]);
  });
});

describe("groq: generation", () => {
  it("text response with system prompt, temperature and output limit", async () => {
    fetchMock.mockResolvedValue(completion({ content: "Hello there", reasoning: "internal chain of thought" }));
    const r = await groqProvider.generate(req({ system: "be brief", temperature: 0.3 }));
    expect(r).toMatchObject({ text: "Hello there", toolCalls: [], stopReason: "end", provider: "groq", model: GROQ_MODEL });
    expect(r.usage).toEqual({ inputTokens: 40, outputTokens: 6, estimated: false });
    const b = sent().body;
    expect(b.messages).toEqual([{ role: "system", content: "be brief" }, { role: "user", content: "hello" }]);
    expect(b.max_completion_tokens).toBe(64);
    expect(b.temperature).toBe(0.3);
    expect(b.tools).toBeUndefined();
    expect(b.response_format).toBeUndefined();
    expect(b.stream).toBeUndefined();
    // Reasoning is never mixed into the answer text.
    expect(r.text).not.toContain("chain of thought");
  });

  it("finish_reason length -> max_tokens; missing usage -> estimated", async () => {
    fetchMock.mockResolvedValue(completion({ content: "cut" }, "length", null));
    const r = await groqProvider.generate(req());
    expect(r.stopReason).toBe("max_tokens");
    expect(r.usage.estimated).toBe(true);
  });

  it("forwards only the caller's tools, in Groq's function format", async () => {
    fetchMock.mockResolvedValue(completion({ content: "ok" }));
    await groqProvider.generate(req({ tools: [tool("db_read"), tool("search_code")] }));
    expect(sent().body.tools).toEqual([
      { type: "function", function: { name: "db_read", description: "db_read tool", parameters: tool("db_read").parameters } },
      { type: "function", function: { name: "search_code", description: "search_code tool", parameters: tool("search_code").parameters } },
    ]);
  });

  it("tool call: native tool_calls (JSON-string arguments) become generic LlmToolCalls", async () => {
    fetchMock.mockResolvedValue(
      completion({ content: null, tool_calls: [
        { id: "call_abc", type: "function", function: { name: "db_read", arguments: "{\"sql\":\"select 1\"}" } },
        { id: "call_def", type: "function", function: { name: "search_code", arguments: "" } },
      ] }, "tool_calls"),
    );
    const r = await groqProvider.generate(req({ tools: [tool("db_read"), tool("search_code")] }));
    expect(r.stopReason).toBe("tool_calls");
    expect(r.text).toBe("");
    expect(r.toolCalls).toEqual([
      { id: "call_abc", name: "db_read", input: { sql: "select 1" } },
      { id: "call_def", name: "search_code", input: {} },
    ]);
  });

  it("tool continuation: assistant tool call + tool result are sent back in Groq's format, then a final answer", async () => {
    // Ids from any provider (here a long Gemini-style id) are renumbered per request.
    const geminiId = `gc~0~abc~${"S".repeat(300)}`;
    fetchMock.mockResolvedValue(completion({ content: "There are 3 matches." }));
    const r = await groqProvider.generate(
      req({
        tools: [tool("db_read")],
        messages: [
          { role: "user", content: "count matches" },
          { role: "assistant", content: "", toolCalls: [{ id: geminiId, name: "db_read", input: { sql: "select count(*) from matches" } }, { id: "call_x", name: "db_read", input: { sql: "select 2" } }] },
          { role: "tool", toolCallId: geminiId, name: "db_read", content: "[{\"count\":3}]" },
          { role: "tool", toolCallId: "call_x", name: "db_read", content: "permission denied", isError: true },
        ],
      }),
    );
    expect(sent().body.messages).toEqual([
      { role: "user", content: "count matches" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_0", type: "function", function: { name: "db_read", arguments: "{\"sql\":\"select count(*) from matches\"}" } },
          { id: "call_1", type: "function", function: { name: "db_read", arguments: "{\"sql\":\"select 2\"}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_0", name: "db_read", content: "[{\"count\":3}]" },
      { role: "tool", tool_call_id: "call_1", name: "db_read", content: "ERROR: permission denied" },
    ]);
    expect(r).toMatchObject({ text: "There are 3 matches.", toolCalls: [], stopReason: "end" });
  });

  it("JSON without a schema -> json_object mode; valid JSON passes", async () => {
    fetchMock.mockResolvedValue(completion({ content: "{\"score\":4}" }));
    const r = await groqProvider.generate(req({ json: {} }));
    expect(sent().body.response_format).toEqual({ type: "json_object" });
    expect(JSON.parse(r.text)).toEqual({ score: 4 });
  });

  it("JSON with a schema -> json_schema (best effort); the reply is still validated", async () => {
    const schema = { type: "object" as const, properties: { verdict: { type: "string" } }, required: ["verdict"] };
    fetchMock.mockResolvedValue(completion({ content: "{\"verdict\":\"SURVIVES\"}" }));
    await groqProvider.generate(req({ json: { schema } }));
    expect(sent().body.response_format).toEqual({ type: "json_schema", json_schema: { name: "response", schema, strict: false } });
  });

  it.each([["prose", "Sure! The score is 4."], ["array", "[1,2]"], ["string", "\"x\""]])("JSON mode never passes %s off as success", async (_n, content) => {
    fetchMock.mockResolvedValue(completion({ content }));
    const e = await failure(groqProvider.generate(req({ json: {} })));
    expect(e.kind).toBe("MODEL_FAILURE");
  });

  it("JSON + streaming caller: not streamed (unsupported by Groq); validated text is handed over once", async () => {
    fetchMock.mockResolvedValue(completion({ content: "{\"a\":1}" }));
    const deltas: string[] = [];
    await groqProvider.generate(req({ json: {}, onTextDelta: (d) => deltas.push(d) }));
    expect(sent().body.stream).toBeUndefined();
    expect(deltas).toEqual(["{\"a\":1}"]);
    // An invalid JSON reply never reaches the caller's stream.
    fetchMock.mockResolvedValue(completion({ content: "nope" }));
    const d2: string[] = [];
    expect((await failure(groqProvider.generate(req({ json: {}, onTextDelta: (d) => d2.push(d) })))).kind).toBe("MODEL_FAILURE");
    expect(d2).toEqual([]);
  });
});

describe("groq: streaming", () => {
  it("streams text deltas and reads usage from the final chunk", async () => {
    fetchMock.mockResolvedValue(
      sse([chunk({ role: "assistant", content: "" }), chunk({ content: "Hel" }), chunk({ reasoning: "hidden" }), chunk({ content: "lo" }), chunk({}, "stop", { x_groq: { usage: { prompt_tokens: 12, completion_tokens: 3 } } })]),
    );
    const deltas: string[] = [];
    const r = await groqProvider.generate(req({ onTextDelta: (d) => deltas.push(d) }));
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(r).toMatchObject({ text: "Hello", stopReason: "end", usage: { inputTokens: 12, outputTokens: 3, estimated: false } });
    expect(sent().body.stream).toBe(true);
    expect(sent().body.stream_options).toEqual({ include_usage: true });
  });

  it("assembles streamed tool-call fragments by index", async () => {
    fetchMock.mockResolvedValue(
      sse([
        chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "db_read", arguments: "" } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: "{\"sql\":" } }] }),
        chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "list_repo", arguments: "{}" } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: "\"select 1\"}" } }] }),
        chunk({}, "tool_calls", { usage: { prompt_tokens: 20, completion_tokens: 9 } }),
      ]),
    );
    const r = await groqProvider.generate(req({ tools: [tool("db_read"), tool("list_repo")], onTextDelta: () => {} }));
    expect(r.toolCalls).toEqual([
      { id: "call_a", name: "db_read", input: { sql: "select 1" } },
      { id: "call_b", name: "list_repo", input: {} },
    ]);
    expect(r.stopReason).toBe("tool_calls");
    expect(r.usage).toEqual({ inputTokens: 20, outputTokens: 9, estimated: false });
  });

  it("malformed stream event -> MODEL_FAILURE", async () => {
    fetchMock.mockResolvedValue(sse([chunk({ content: "a" })], "data: {not json\n\n"));
    expect((await failure(groqProvider.generate(req({ onTextDelta: () => {} })))).kind).toBe("MODEL_FAILURE");
  });

  it("error event inside the stream -> MODEL_FAILURE, key redacted", async () => {
    fetchMock.mockResolvedValue(sse([{ error: { message: `boom ${KEY}` } }]));
    const e = await failure(groqProvider.generate(req({ onTextDelta: () => {} })));
    expect(e.kind).toBe("MODEL_FAILURE");
    expect(e.message).not.toContain(KEY);
  });
});

describe("groq: malformed responses", () => {
  it.each([
    ["non-JSON body", () => new Response("<html>", { status: 200 })],
    ["JSON array", () => json([1, 2])],
    ["no choices", () => json({ choices: [] })],
    ["no message", () => json({ choices: [{ finish_reason: "stop" }] })],
    ["content not text", () => completion({ content: { a: 1 } })],
    ["tool_calls not an array", () => completion({ content: null, tool_calls: { a: 1 } }, "tool_calls")],
    ["tool call without a name", () => completion({ content: null, tool_calls: [{ id: "c", type: "function", function: { arguments: "{}" } }] }, "tool_calls")],
    ["non-JSON tool arguments", () => completion({ content: null, tool_calls: [{ id: "c", type: "function", function: { name: "db_read", arguments: "{sql:" } }] }, "tool_calls")],
    ["array tool arguments", () => completion({ content: null, tool_calls: [{ id: "c", type: "function", function: { name: "db_read", arguments: "[1]" } }] }, "tool_calls")],
    ["empty answer", () => completion({ content: "" })],
    ["error object with 200", () => json({ error: { message: "oops" } })],
  ])("%s -> MODEL_FAILURE", async (_n, make) => {
    fetchMock.mockResolvedValue(make());
    expect((await failure(groqProvider.generate(req()))).kind).toBe("MODEL_FAILURE");
  });
});

describe("groq: error classification", () => {
  it.each([
    [401, errBody(401, "Invalid API Key", { code: "invalid_api_key" }), "PROVIDER_UNAVAILABLE", false],
    [403, errBody(403, "Forbidden"), "PROVIDER_UNAVAILABLE", false],
    [404, errBody(404, "The model `openai/gpt-oss-120b` does not exist or you do not have access to it.", { code: "model_not_found" }), "PROVIDER_UNAVAILABLE", false],
    [429, errBody(429, "Rate limit reached for model `openai/gpt-oss-120b` on requests per minute (RPM): Limit 30, Used 30, Requested 1.", { code: "rate_limit_exceeded" }), "RATE_LIMITED", false],
    [429, errBody(429, "Rate limit reached on tokens per minute (TPM): Limit 8000, Used 7900, Requested 500.", { code: "rate_limit_exceeded" }), "RATE_LIMITED", false],
    [429, errBody(429, "Rate limit reached on tokens per day (TPD): Limit 200000, Used 199990, Requested 900.", { code: "rate_limit_exceeded" }), "QUOTA_EXHAUSTED", false],
    [429, errBody(429, `Rate limit reached for model \`openai/gpt-oss-120b\` on requests per minute (RPM): Limit 30, Used 30, Requested 1. Please try again in 2s. Need more tokens? Upgrade to Dev Tier today at ${["https://console.groq.com", "settings", "billing"].join("/")}`, { code: "rate_limit_exceeded" }), "RATE_LIMITED", false],
    [429, errBody(429, `Rate limit reached on tokens per day (TPD): Limit 200000, Used 199990, Requested 900. Upgrade to Dev Tier today at ${["https://console.groq.com", "settings", "billing"].join("/")}`, { code: "rate_limit_exceeded" }), "QUOTA_EXHAUSTED", false],
    [413, errBody(413, `Request too large on tokens per minute (TPM): Limit 8000, Requested 9100. Upgrade to Dev Tier today at ${["https://console.groq.com", "settings", "billing"].join("/")}`, { code: "rate_limit_exceeded" }), "PROVIDER_UNAVAILABLE", false],
    [400, errBody(400, "Your organization has insufficient_quota; update billing"), "QUOTA_EXHAUSTED", true],
    [429, errBody(429, "Rate limit reached on requests per day (RPD): Limit 1000, Used 1000, Requested 1.", { code: "rate_limit_exceeded" }), "QUOTA_EXHAUSTED", false],
    [402, errBody(402, "Payment required"), "QUOTA_EXHAUSTED", true],
    [400, errBody(400, "API access blocked", { code: "blocked_api_access" }), "QUOTA_EXHAUSTED", true],
    [413, errBody(413, "Request too large for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Requested 9100.", { type: "tokens", code: "rate_limit_exceeded" }), "PROVIDER_UNAVAILABLE", false],
    [400, errBody(400, "Failed to call a function. Please adjust your prompt.", { code: "tool_use_failed" }), "MODEL_FAILURE", false],
    [400, errBody(400, "Generated JSON does not match the expected schema.", { code: "json_validate_failed" }), "MODEL_FAILURE", false],
    [400, errBody(400, "'messages' must be an array"), "INVALID_REQUEST", false],
    [422, errBody(422, "unprocessable"), "INVALID_REQUEST", false],
    [498, errBody(498, "flex tier capacity exceeded"), "PROVIDER_UNAVAILABLE", false],
    [500, errBody(500, "internal"), "PROVIDER_UNAVAILABLE", false],
    [502, errBody(502, "bad gateway"), "PROVIDER_UNAVAILABLE", false],
    [503, errBody(503, "Service Unavailable"), "PROVIDER_UNAVAILABLE", false],
  ])("HTTP %i -> %s", async (status, res, kind, billing) => {
    fetchMock.mockResolvedValue(res);
    const e = await failure(groqProvider.generate(req()));
    expect([e.kind, e.status, e.billing, e.provider]).toEqual([kind, status, billing, "groq"]);
  });

  it("network error -> PROVIDER_UNAVAILABLE", async () => {
    fetchMock.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }));
    expect((await failure(groqProvider.generate(req()))).kind).toBe("PROVIDER_UNAVAILABLE");
  });

  it("timeout -> PROVIDER_UNAVAILABLE (so the router moves on)", async () => {
    fetchMock.mockImplementation((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason))));
    const e = await failure(groqProvider.generate(req({ timeoutMs: 20 })));
    expect(e.kind).toBe("PROVIDER_UNAVAILABLE");
  });

  it("caller cancellation -> INVALID_REQUEST (not an outage)", async () => {
    fetchMock.mockImplementation((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason))));
    const ac = new AbortController();
    const p = groqProvider.generate(req({ signal: ac.signal }));
    setTimeout(() => ac.abort(), 5);
    expect((await failure(p)).kind).toBe("INVALID_REQUEST");
  });

  it("the API key never appears in errors, even when the server echoes it", async () => {
    for (const k of [KEY, KEYLIKE]) {
      process.env.GROQ_API_KEY = k;
      for (const status of [400, 401, 429, 500]) {
        fetchMock.mockResolvedValueOnce(errBody(status, `bad key ${k} / Authorization: Bearer ${k}`));
        const e = await failure(groqProvider.generate(req()));
        expect(e.message).not.toContain(k);
        expect(String(e.stack)).not.toContain(k);
        expect(e.cause).toBeUndefined();
      }
      fetchMock.mockRejectedValueOnce(new TypeError(`connect failed for ${k}`));
      const e = await failure(groqProvider.generate(req()));
      expect(e.message).not.toContain(k);
      expect(e.cause).toBeUndefined();
    }
  });
});
