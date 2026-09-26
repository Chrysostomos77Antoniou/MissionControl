import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createGeminiProvider, GEMINI_FREE_MODELS, GEMINI_API_BASE, isGeminiFreeModel, type GeminiFreeModel } from "../providers/gemini";
import { LlmError } from "../llm-errors";
import { offeredToolNames, isToolOffered } from "../tool-guard";
import type { LlmRequest, LlmToolSpec } from "../llm";

// Fake key assembled from pieces; not key-shaped for any secret scanner.
const KEY = ["TESTONLY", "gemini", "key", "0123456789"].join("-");
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const ok = (parts: unknown[], extra: Record<string, unknown> = {}) =>
  json({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 6, thoughtsTokenCount: 4, totalTokenCount: 50 }, ...extra });
const errBody = (code: number, status: string, message: string, details: unknown[] = []) => json({ error: { code, status, message, details } }, code);
const sse = (events: unknown[]) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const e of events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\r\n\r\n`));
        c.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({ messages: [{ role: "user", content: "hello" }], maxOutputTokens: 64, ...over });
const tool = (name: string): LlmToolSpec => ({ name, description: name, parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } });
const sent = (i = 0) => ({ url: String(fetchMock.mock.calls[i][0]), init: fetchMock.mock.calls[i][1] as RequestInit, body: JSON.parse(fetchMock.mock.calls[i][1].body as string) });
const lite = () => createGeminiProvider("gemini-3.5-flash-lite");
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
  process.env.GEMINI_API_KEY = KEY;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  process.env = savedEnv;
  vi.unstubAllGlobals();
});

describe("gemini: allowlist and configuration", () => {
  it("9. every allowed model can be built and is the only model it ever calls", async () => {
    expect(Object.keys(GEMINI_FREE_MODELS).sort()).toEqual(["gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-3.8-flash"]);
    for (const m of Object.keys(GEMINI_FREE_MODELS) as GeminiFreeModel[]) {
      fetchMock.mockResolvedValueOnce(ok([{ text: "hi" }]));
      const p = createGeminiProvider(m);
      expect(p.id).toBe("gemini");
      expect(p.model).toBe(m);
      const r = await p.generate(req());
      expect(r.model).toBe(m);
      expect(String(fetchMock.mock.calls.at(-1)![0])).toBe(`${GEMINI_API_BASE}/models/${m}:generateContent`);
    }
  });

  it("exposes the verified free-tier limits as read-only metadata", () => {
    expect(GEMINI_FREE_MODELS["gemini-3.5-flash-lite"].requestsPerDay).toBe(500);
    expect(GEMINI_FREE_MODELS["gemini-3.1-flash-lite"].requestsPerDay).toBe(500);
    expect(GEMINI_FREE_MODELS["gemini-3.8-flash"].requestsPerDay).toBe(20);
    expect(Object.isFrozen(GEMINI_FREE_MODELS)).toBe(true);
    expect(Object.isFrozen(GEMINI_FREE_MODELS["gemini-3.8-flash"])).toBe(true);
  });

  it.each(["gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-3.8-flash-latest", "GEMINI-3.8-FLASH", "", "../../evil", "gpt-5", "toString", "__proto__"])(
    "8/22. rejects non-allowlisted model %j before any network request",
    (m) => {
      expect(isGeminiFreeModel(m)).toBe(false);
      expect(() => createGeminiProvider(m as GeminiFreeModel)).toThrow(/not on the free-tier allowlist/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("22b. env vars cannot change the model or the endpoint", async () => {
    Object.assign(process.env, { GEMINI_MODEL: "gemini-3.1-pro-preview", GEMINI_BASE_URL: "https://evil.example", GOOGLE_API_BASE: "https://evil.example", LLM_BASE_URL: "https://evil.example" });
    fetchMock.mockResolvedValue(ok([{ text: "x" }]));
    await lite().generate(req());
    expect(sent().url).toBe(`${GEMINI_API_BASE}/models/gemini-3.5-flash-lite:generateContent`);
  });

  it.each(["model", "baseURL", "apiKey", "provider", "thinkingConfig", "safetySettings", "generationConfig", "tools_config", "key"])(
    "22c. rejects generic-request field %s before any network request",
    async (k) => {
      await expect(lite().generate({ ...req(), [k]: "x" } as unknown as LlmRequest)).rejects.toThrow(/non-generic field/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("provider objects are frozen", () => {
    const p = lite();
    expect(Object.isFrozen(p)).toBe(true);
    expect(() => {
      (p as { model: string }).model = "gemini-3.1-pro-preview";
    }).toThrow();
  });

  it("7. missing key -> PROVIDER_UNAVAILABLE with no request, and isAvailable() is false without any network call", async () => {
    delete process.env.GEMINI_API_KEY;
    const e = await failure(lite().generate(req()));
    expect(e.kind).toBe("PROVIDER_UNAVAILABLE");
    expect(await lite().isAvailable()).toBe(false);
    process.env.GEMINI_API_KEY = "   ";
    expect((await failure(lite().generate(req()))).kind).toBe("PROVIDER_UNAVAILABLE");
    expect(fetchMock).not.toHaveBeenCalled();
    process.env.GEMINI_API_KEY = KEY;
    expect(await lite().isAvailable()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the key only in the x-goog-api-key header, never in the URL", async () => {
    fetchMock.mockResolvedValue(ok([{ text: "x" }]));
    await lite().generate(req());
    const { url, init } = sent();
    expect(url).not.toContain(KEY);
    expect(url).not.toMatch(/[?&]key=/);
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
  });
});

describe("gemini: generation", () => {
  it("1. text response with system prompt, temperature and output limit", async () => {
    fetchMock.mockResolvedValue(ok([{ text: "Hello " }, { text: "there" }]));
    const r = await lite().generate(req({ system: "be brief", temperature: 0.3 }));
    expect(r).toMatchObject({ text: "Hello there", toolCalls: [], stopReason: "end", provider: "gemini", model: "gemini-3.5-flash-lite" });
    const b = sent().body;
    expect(b.systemInstruction).toEqual({ parts: [{ text: "be brief" }] });
    expect(b.contents).toEqual([{ role: "user", parts: [{ text: "hello" }] }]);
    expect(b.generationConfig).toEqual({ maxOutputTokens: 64, temperature: 0.3 });
    expect(b.tools).toBeUndefined();
  });

  it("ignores thought-summary parts in the returned text", async () => {
    fetchMock.mockResolvedValue(ok([{ text: "internal reasoning", thought: true }, { text: "answer" }]));
    expect((await lite().generate(req())).text).toBe("answer");
  });

  it("reports max_tokens", async () => {
    fetchMock.mockResolvedValue(json({ candidates: [{ content: { parts: [{ text: "cut" }] }, finishReason: "MAX_TOKENS" }] }));
    expect((await lite().generate(req())).stopReason).toBe("max_tokens");
  });

  it("2. JSON response with schema, validated", async () => {
    const schema = { type: "object" as const, properties: { score: { type: "integer" } }, required: ["score"] };
    fetchMock.mockResolvedValue(ok([{ text: '{"score":5}' }]));
    const r = await lite().generate(req({ json: { schema } }));
    expect(JSON.parse(r.text)).toEqual({ score: 5 });
    expect(sent().body.generationConfig).toMatchObject({ responseMimeType: "application/json", responseJsonSchema: schema });
  });

  it("3. valid tool call, preserving Gemini's call id and thought signature opaquely", async () => {
    fetchMock.mockResolvedValue(ok([{ functionCall: { id: "fc_1", name: "db_read", args: { q: "select 1" } }, thoughtSignature: "SIG_abc" }]));
    const r = await lite().generate(req({ tools: [tool("db_read")] }));
    expect(r.stopReason).toBe("tool_calls");
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]).toMatchObject({ name: "db_read", input: { q: "select 1" } });
    expect(Object.keys(r.toolCalls[0]).sort()).toEqual(["id", "input", "name"]);
  });

  it("4. tool-result continuation sends the call back with its signature and grouped function responses", async () => {
    fetchMock.mockResolvedValueOnce(ok([
      { functionCall: { id: "fc_1", name: "db_read", args: { q: "a" } }, thoughtSignature: "SIG_1" },
      { functionCall: { name: "web_search", args: { q: "b" } } },
    ]));
    const p = lite();
    const first = await p.generate(req({ tools: [tool("db_read"), tool("web_search")] }));
    fetchMock.mockResolvedValueOnce(ok([{ text: "done" }]));
    const second = await p.generate(
      req({
        tools: [tool("db_read"), tool("web_search")],
        messages: [
          { role: "user", content: "q" },
          { role: "assistant", content: "", toolCalls: first.toolCalls },
          { role: "tool", toolCallId: first.toolCalls[0].id, name: "db_read", content: "[1]" },
          { role: "tool", toolCallId: first.toolCalls[1].id, name: "web_search", content: "rejected", isError: true },
        ],
      }),
    );
    expect(second.text).toBe("done");
    const c = sent(1).body.contents;
    expect(c[1]).toEqual({
      role: "model",
      parts: [
        { functionCall: { id: "fc_1", name: "db_read", args: { q: "a" } }, thoughtSignature: "SIG_1" },
        { functionCall: { name: "web_search", args: { q: "b" } } },
      ],
    });
    expect(c[2]).toEqual({
      role: "user",
      parts: [
        { functionResponse: { id: "fc_1", name: "db_read", response: { content: "[1]" } } },
        { functionResponse: { name: "web_search", response: { error: "rejected" } } },
      ],
    });
    expect(c).toHaveLength(3);
  });

  it("streams text over SSE when a callback is given", async () => {
    fetchMock.mockResolvedValue(
      sse([
        { candidates: [{ content: { parts: [{ text: "Hel" }] } }] },
        { candidates: [{ content: { parts: [{ text: "lo" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } },
      ]),
    );
    const deltas: string[] = [];
    const r = await lite().generate(req({ onTextDelta: (d) => deltas.push(d) }));
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(r.text).toBe("Hello");
    expect(r.usage).toEqual({ inputTokens: 3, outputTokens: 2, estimated: false });
    expect(sent().url).toBe(`${GEMINI_API_BASE}/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse`);
  });
});

describe("gemini: usage", () => {
  it("5. reports token usage, counting thinking tokens as output", async () => {
    fetchMock.mockResolvedValue(ok([{ text: "x" }]));
    expect((await lite().generate(req())).usage).toEqual({ inputTokens: 40, outputTokens: 10, estimated: false });
  });

  it("6. estimates and flags usage when usageMetadata is missing", async () => {
    fetchMock.mockResolvedValue(json({ candidates: [{ content: { parts: [{ text: "abcdefgh" }] }, finishReason: "STOP" }] }));
    const u = (await lite().generate(req())).usage;
    expect(u).toMatchObject({ outputTokens: 2, estimated: true });
    expect(u.inputTokens).toBeGreaterThan(0);
  });
});

describe("gemini: errors (never retried, never another model)", () => {
  const perDay = [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }];
  const perMinute = [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }] }];
  const billingWording = "You exceeded your current quota, please check your plan and billing details.";
  const cases: [string, () => Response, string, boolean?][] = [
    ["10. HTTP 402", () => errBody(402, "PAYMENT_REQUIRED", "Prepay credits depleted"), "QUOTA_EXHAUSTED", true],
    ["11. billing error text (403)", () => errBody(403, "PERMISSION_DENIED", "This API method requires billing to be enabled"), "QUOTA_EXHAUSTED", true],
    ["11b. billing error text (400)", () => errBody(400, "FAILED_PRECONDITION", "Billing account required: payment required"), "QUOTA_EXHAUSTED", true],
    ["12. daily quota exhausted", () => errBody(429, "RESOURCE_EXHAUSTED", billingWording, perDay), "QUOTA_EXHAUSTED", false],
    ["12b. free tier limit 0", () => errBody(429, "RESOURCE_EXHAUSTED", `${billingWording} Quota exceeded for metric: generate_content_free_tier_requests, limit: 0`), "QUOTA_EXHAUSTED"],
    ["13. per-minute 429 (despite 'billing details' wording)", () => errBody(429, "RESOURCE_EXHAUSTED", billingWording, perMinute), "RATE_LIMITED", false],
    ["13b. plain 429", () => errBody(429, "RESOURCE_EXHAUSTED", "Resource has been exhausted"), "RATE_LIMITED"],
    ["14. HTTP 401", () => errBody(401, "UNAUTHENTICATED", "Request had invalid authentication credentials"), "PROVIDER_UNAVAILABLE"],
    ["14b. invalid key (400 API_KEY_INVALID)", () => errBody(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.", [{ reason: "API_KEY_INVALID" }]), "PROVIDER_UNAVAILABLE"],
    ["15. HTTP 403", () => errBody(403, "PERMISSION_DENIED", "The caller does not have permission"), "PROVIDER_UNAVAILABLE"],
    ["16. HTTP 500", () => errBody(500, "INTERNAL", "Internal error"), "PROVIDER_UNAVAILABLE"],
    ["16b. HTTP 503", () => errBody(503, "UNAVAILABLE", "The model is overloaded"), "PROVIDER_UNAVAILABLE"],
    ["404 model not available", () => errBody(404, "NOT_FOUND", "models/gemini-3.5-flash-lite is not found"), "PROVIDER_UNAVAILABLE"],
    ["unsupported location", () => errBody(400, "FAILED_PRECONDITION", "User location is not supported for the API use."), "PROVIDER_UNAVAILABLE"],
    ["other 400", () => errBody(400, "INVALID_ARGUMENT", "Invalid JSON payload received"), "INVALID_REQUEST"],
  ];
  it.each(cases)("%s", async (_n, res, kind, billing) => {
    fetchMock.mockResolvedValue(res());
    const e = await failure(lite().generate(req()));
    expect(e.kind).toBe(kind);
    if (billing !== undefined) expect(e.billing).toBe(billing);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("gemini-3.5-flash-lite");
  });

  it("17. timeout -> PROVIDER_UNAVAILABLE", async () => {
    fetchMock.mockImplementation((_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))));
    expect((await failure(lite().generate(req({ timeoutMs: 20 })))).kind).toBe("PROVIDER_UNAVAILABLE");
  });

  it("cancellation -> INVALID_REQUEST (no fallback)", async () => {
    const ac = new AbortController();
    fetchMock.mockImplementation((_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))));
    const p = lite().generate(req({ signal: ac.signal }));
    ac.abort();
    expect(await failure(p)).toMatchObject({ kind: "INVALID_REQUEST", message: expect.stringMatching(/cancelled/) });
  });

  it("18. network failure -> PROVIDER_UNAVAILABLE", async () => {
    fetchMock.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }));
    expect((await failure(lite().generate(req()))).kind).toBe("PROVIDER_UNAVAILABLE");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("19. malformed responses -> MODEL_FAILURE", async () => {
    for (const r of [
      () => new Response("<html>oops</html>", { status: 200 }),
      () => json("just a string"),
      () => json({ candidates: [{ content: { parts: "nope" } }] }),
      () => json({ candidates: [{ content: { parts: [{ text: 42 }] } }] }),
      () => json({ error: { message: "backend error" } }),
      () => json({ promptFeedback: { blockReason: "SAFETY" } }),
      () => json({ candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "MALFORMED_FUNCTION_CALL" }] }),
    ]) {
      fetchMock.mockResolvedValueOnce(r());
      expect((await failure(lite().generate(req()))).kind).toBe("MODEL_FAILURE");
    }
    fetchMock.mockResolvedValueOnce(ok([{ text: "not json" }]));
    expect((await failure(lite().generate(req({ json: {} })))).kind).toBe("MODEL_FAILURE");
  });

  it("20. empty responses -> MODEL_FAILURE", async () => {
    for (const r of [() => json({}), () => json({ candidates: [] }), () => ok([{ text: "   " }]), () => json({ candidates: [{ finishReason: "SAFETY" }] })]) {
      fetchMock.mockResolvedValueOnce(r());
      expect((await failure(lite().generate(req()))).kind).toBe("MODEL_FAILURE");
    }
  });

  it("21. invalid tool arguments -> MODEL_FAILURE", async () => {
    for (const fc of [{ name: "db_read", args: "select 1" }, { name: "db_read", args: [1, 2] }, { args: { q: "x" } }, { name: "", args: {} }]) {
      fetchMock.mockResolvedValueOnce(ok([{ functionCall: fc }]));
      expect((await failure(lite().generate(req({ tools: [tool("db_read")] })))).kind).toBe("MODEL_FAILURE");
    }
  });

  it("23. the API key never appears in errors, even when the server echoes it", async () => {
    const leaky = [
      () => errBody(400, "INVALID_ARGUMENT", `Invalid payload for key=${KEY}`),
      () => errBody(500, "INTERNAL", `internal error with ${KEY}`),
      () => json({ error: { message: `bad ${KEY}` } }),
    ];
    for (const r of leaky) {
      fetchMock.mockResolvedValueOnce(r());
      const e = await failure(lite().generate(req()));
      expect(e.message).not.toContain(KEY);
      expect(String(e.stack)).not.toContain(KEY);
      expect(JSON.stringify({ ...e, message: e.message })).not.toContain(KEY);
    }
    fetchMock.mockRejectedValueOnce(new Error(`connect failed for ${KEY}`));
    const e = await failure(lite().generate(req()));
    expect(e.message).not.toContain(KEY);
    expect(e.cause).toBeUndefined();
  });
});

describe("gemini: tools and €0 scope", () => {
  it("25. only the caller-supplied tools are sent; unoffered calls are still refused by tool-guard", async () => {
    fetchMock.mockResolvedValue(ok([{ functionCall: { name: "apply_db_migration", args: { sql: "drop table x" } } }]));
    const offered = [tool("db_read"), tool("save_suggestion")];
    const r = await lite().generate(req({ tools: offered }));
    expect(sent().body.tools).toEqual([{ functionDeclarations: offered.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }]);
    expect(isToolOffered(r.toolCalls[0].name, offeredToolNames(offered))).toBe(false);
  });

  it("24. the adapter source references only the Gemini endpoint — no other AI provider, no fallback, no key creation", () => {
    const src = readFileSync(join(__dirname, "..", "providers", "gemini.ts"), "utf8");
    const urls = src.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
    expect(urls).toEqual(["https://generativelanguage.googleapis.com/v1beta"]);
    const forbidden = new RegExp(["anthro" + "pic", "open" + "ai", "ol" + "lama", "9ro" + "uter", ":20128", "claude", "gpt-"].join("|"), "i");
    expect(src).not.toMatch(forbidden);
    // No paid/pro model ids, and env is read only for the key.
    expect(src).not.toMatch(/gemini-[\d.]+-pro|-pro-preview|ultra/i);
    expect(src.match(/process\.env\.[A-Z_]+/g)?.every((m) => m === "process.env.GEMINI_API_KEY")).toBe(true);
    expect(src).not.toMatch(/createKey|apiKeys\.create|billingAccount|setupPrepay/i);
  });

  it("13/22. the only hosts ever contacted are Google's Generative Language API", async () => {
    fetchMock.mockImplementation(async () => ok([{ text: "x" }]));
    for (const m of Object.keys(GEMINI_FREE_MODELS) as GeminiFreeModel[]) await createGeminiProvider(m).generate(req());
    for (const [u] of fetchMock.mock.calls) expect(new URL(String(u)).host).toBe("generativelanguage.googleapis.com");
  });
});
