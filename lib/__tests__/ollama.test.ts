import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ollamaProvider, OLLAMA_ENDPOINT, OLLAMA_MODEL } from "../providers/ollama";
import { LlmError } from "../llm-errors";
import { offeredToolNames, isToolOffered } from "../tool-guard";
import type { LlmRequest, LlmToolSpec } from "../llm";

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const done = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  json({ model: OLLAMA_MODEL, message: { role: "assistant", content: "", ...message }, done: true, done_reason: "stop", prompt_eval_count: 12, eval_count: 5, ...extra });
const ndjson = (lines: unknown[]) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const l of lines) c.enqueue(new TextEncoder().encode(JSON.stringify(l) + "\n"));
        c.close();
      },
    }),
    { status: 200 },
  );
const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({ messages: [{ role: "user", content: "hello" }], maxOutputTokens: 64, ...over });
const sentBody = (i = 0) => JSON.parse(fetchMock.mock.calls[i][1].body as string);
const tool = (name: string): LlmToolSpec => ({ name, description: name, parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } });
const kindOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return e instanceof LlmError ? e.kind : `non-LlmError: ${String(e)}`;
  }
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("ollama provider: identity and fixed configuration", () => {
  it("identifies itself with the fixed provider/model and cannot be mutated", () => {
    expect(ollamaProvider.id).toBe("ollama");
    expect(ollamaProvider.model).toBe("qwen3.5:4b");
    expect(OLLAMA_ENDPOINT).toBe("http://127.0.0.1:11434");
    expect(Object.isFrozen(ollamaProvider)).toBe(true);
    expect(() => {
      (ollamaProvider as { model: string }).model = "llama3:70b";
    }).toThrow();
  });

  it("ignores environment variables that would normally redirect Ollama", async () => {
    const saved = { ...process.env };
    Object.assign(process.env, { OLLAMA_HOST: "http://evil.example:11434", OLLAMA_BASE_URL: "https://api.example.com", OLLAMA_MODEL: "llama3:70b", LLM_BASE_URL: "https://api.openai.com/v1" });
    try {
      fetchMock.mockResolvedValue(done({ content: "hi" }));
      await ollamaProvider.generate(req());
      expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:11434/api/chat");
      expect(sentBody().model).toBe("qwen3.5:4b");
    } finally {
      process.env = saved;
    }
  });

  it.each(["model", "baseURL", "apiKey", "provider", "think", "options", "format", "keep_alive"])(
    "rejects a %s field before any network call",
    async (key) => {
      const r = { ...req(), [key]: "x" } as unknown as LlmRequest;
      await expect(ollamaProvider.generate(r)).rejects.toThrow(/non-generic field/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects otherwise invalid generic requests before any network call", async () => {
    await expect(ollamaProvider.generate(req({ maxOutputTokens: 0 }))).rejects.toThrow();
    await expect(ollamaProvider.generate(req({ messages: [] }))).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ollama provider: generation", () => {
  it("1. generates text and sends the fixed model with thinking off", async () => {
    fetchMock.mockResolvedValue(done({ content: "Hello there" }));
    const r = await ollamaProvider.generate(req({ system: "be brief", temperature: 0.2 }));
    expect(r).toMatchObject({ text: "Hello there", toolCalls: [], stopReason: "end", provider: "ollama", model: "qwen3.5:4b" });
    const b = sentBody();
    expect(b.model).toBe("qwen3.5:4b");
    expect(b.stream).toBe(false);
    expect(b.think).toBe(false);
    expect(b.messages[0]).toEqual({ role: "system", content: "be brief" });
    expect(b.options).toMatchObject({ num_predict: 64, temperature: 0.2 });
    expect(b.options.num_ctx).toBeGreaterThanOrEqual(4096);
  });

  it("reports max_tokens when Ollama stops on length", async () => {
    fetchMock.mockResolvedValue(done({ content: "partial" }, { done_reason: "length" }));
    expect((await ollamaProvider.generate(req())).stopReason).toBe("max_tokens");
  });

  it("2. generates JSON with a schema and validates it", async () => {
    const schema = { type: "object" as const, properties: { score: { type: "integer" } }, required: ["score"] };
    fetchMock.mockResolvedValue(done({ content: '{"score":4}' }));
    const r = await ollamaProvider.generate(req({ json: { schema } }));
    expect(JSON.parse(r.text)).toEqual({ score: 4 });
    expect(sentBody().format).toEqual(schema);
  });

  it("2b. plain JSON mode uses format=json", async () => {
    fetchMock.mockResolvedValue(done({ content: '{"a":1}' }));
    await ollamaProvider.generate(req({ json: {} }));
    expect(sentBody().format).toBe("json");
  });

  it("3. returns tool calls with ids and parsed arguments", async () => {
    fetchMock.mockResolvedValue(done({ tool_calls: [{ function: { name: "db_read", arguments: { q: "select 1" } } }, { function: { name: "web_search", arguments: '{"q":"x"}' } }] }));
    const r = await ollamaProvider.generate(req({ tools: [tool("db_read"), tool("web_search")] }));
    expect(r.stopReason).toBe("tool_calls");
    expect(r.toolCalls).toEqual([
      { id: "ollama-call-0", name: "db_read", input: { q: "select 1" } },
      { id: "ollama-call-1", name: "web_search", input: { q: "x" } },
    ]);
  });

  it("4. continues a conversation with a tool result (including error results)", async () => {
    fetchMock.mockResolvedValue(done({ content: "There are 19 users." }));
    const r = await ollamaProvider.generate(
      req({
        tools: [tool("db_read")],
        messages: [
          { role: "user", content: "how many users?" },
          { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "db_read", input: { q: "select count(*)" } }] },
          { role: "tool", toolCallId: "c1", name: "db_read", content: '[{"count":19}]' },
          { role: "tool", toolCallId: "c2", name: "db_read", content: "rejected", isError: true },
        ],
      }),
    );
    expect(r.text).toBe("There are 19 users.");
    const m = sentBody().messages;
    expect(m[1]).toEqual({ role: "assistant", content: "", tool_calls: [{ function: { name: "db_read", arguments: { q: "select count(*)" } } }] });
    expect(m[2]).toEqual({ role: "tool", tool_name: "db_read", content: '[{"count":19}]' });
    expect(m[3]).toEqual({ role: "tool", tool_name: "db_read", content: "ERROR: rejected" });
  });

  it("streams text deltas when a callback is given", async () => {
    fetchMock.mockResolvedValue(
      ndjson([
        { message: { content: "Hel" }, done: false },
        { message: { content: "lo" }, done: false },
        { message: { content: "" }, done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 2 },
      ]),
    );
    const deltas: string[] = [];
    const r = await ollamaProvider.generate(req({ onTextDelta: (d) => deltas.push(d) }));
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(r.text).toBe("Hello");
    expect(sentBody().stream).toBe(true);
  });
});

describe("ollama provider: usage", () => {
  it("5. uses Ollama's reported token counts", async () => {
    fetchMock.mockResolvedValue(done({ content: "ok" }, { prompt_eval_count: 321, eval_count: 7 }));
    expect((await ollamaProvider.generate(req())).usage).toEqual({ inputTokens: 321, outputTokens: 7, estimated: false });
  });

  it("6. estimates and flags usage when counts are missing (e.g. cached prompt)", async () => {
    fetchMock.mockResolvedValue(json({ message: { content: "abcdefgh" }, done: true, done_reason: "stop" }));
    const u = (await ollamaProvider.generate(req())).usage;
    expect(u.estimated).toBe(true);
    expect(u.inputTokens).toBeGreaterThan(0);
    expect(u.outputTokens).toBe(2);
  });
});

describe("ollama provider: failures", () => {
  it("7. timeout -> PROVIDER_UNAVAILABLE", async () => {
    fetchMock.mockImplementation((_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))));
    expect(await kindOf(ollamaProvider.generate(req({ timeoutMs: 20 })))).toBe("PROVIDER_UNAVAILABLE");
  });

  it("8. connection refused -> PROVIDER_UNAVAILABLE, with no retry", async () => {
    fetchMock.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    expect(await kindOf(ollamaProvider.generate(req()))).toBe("PROVIDER_UNAVAILABLE");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("9. malformed responses -> MODEL_FAILURE", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>not json</html>", { status: 200 }));
    expect(await kindOf(ollamaProvider.generate(req()))).toBe("MODEL_FAILURE");
    fetchMock.mockResolvedValueOnce(json({ message: { content: "no done flag" } }));
    expect(await kindOf(ollamaProvider.generate(req()))).toBe("MODEL_FAILURE");
    fetchMock.mockResolvedValueOnce(done({ content: "" }));
    expect(await kindOf(ollamaProvider.generate(req()))).toBe("MODEL_FAILURE");
    fetchMock.mockResolvedValueOnce(done({ tool_calls: [{ function: { name: "db_read", arguments: "{not json" } }] }));
    expect(await kindOf(ollamaProvider.generate(req({ tools: [tool("db_read")] })))).toBe("MODEL_FAILURE");
    fetchMock.mockResolvedValueOnce(done({ tool_calls: [{ function: { arguments: {} } }] }));
    expect(await kindOf(ollamaProvider.generate(req({ tools: [tool("db_read")] })))).toBe("MODEL_FAILURE");
    fetchMock.mockResolvedValueOnce(done({ content: "not json at all" }));
    expect(await kindOf(ollamaProvider.generate(req({ json: {} })))).toBe("MODEL_FAILURE");
    fetchMock.mockResolvedValueOnce(json({ error: "model runner crashed", done: true }));
    expect(await kindOf(ollamaProvider.generate(req()))).toBe("MODEL_FAILURE");
  });

  it("maps HTTP errors: missing model and 5xx are PROVIDER_UNAVAILABLE, 400 is INVALID_REQUEST", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'model "qwen3.5:4b" not found, try pulling it first' }, 404));
    expect(await kindOf(ollamaProvider.generate(req()))).toBe("PROVIDER_UNAVAILABLE");
    fetchMock.mockResolvedValueOnce(json({ error: "out of memory" }, 500));
    expect(await kindOf(ollamaProvider.generate(req()))).toBe("PROVIDER_UNAVAILABLE");
    fetchMock.mockResolvedValueOnce(json({ error: "invalid options" }, 400));
    expect(await kindOf(ollamaProvider.generate(req()))).toBe("INVALID_REQUEST");
  });

  it("a request too large for the local context is PROVIDER_UNAVAILABLE without calling Ollama", async () => {
    expect(await kindOf(ollamaProvider.generate(req({ messages: [{ role: "user", content: "x".repeat(80_000) }] })))).toBe("PROVIDER_UNAVAILABLE");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("15. caller cancellation rejects as a cancellation, not a provider outage", async () => {
    const ac = new AbortController();
    fetchMock.mockImplementation((_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))));
    const p = ollamaProvider.generate(req({ signal: ac.signal }));
    ac.abort();
    await expect(p).rejects.toMatchObject({ kind: "INVALID_REQUEST", message: expect.stringMatching(/cancelled/) });
  });
});

describe("ollama provider: availability", () => {
  it("10. available only when running AND the fixed model is installed", async () => {
    fetchMock.mockResolvedValueOnce(json({ models: [{ name: "qwen3.5:4b" }, { name: "qwen3:0.6b" }] }));
    expect(await ollamaProvider.isAvailable()).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:11434/api/tags");
    fetchMock.mockResolvedValueOnce(json({ models: [{ name: "qwen3:0.6b" }] }));
    expect(await ollamaProvider.isAvailable()).toBe(false);
  });

  it("10b. not running -> false, never throws, single attempt", async () => {
    fetchMock.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    await expect(ollamaProvider.isAvailable()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(new Response("oops", { status: 500 }));
    await expect(ollamaProvider.isAvailable()).resolves.toBe(false);
  });
});

describe("ollama provider: no external services, offered tools only", () => {
  it("13. every request goes to 127.0.0.1:11434 and nowhere else", async () => {
    fetchMock.mockImplementation(async (url: string) => (url.endsWith("/api/tags") ? json({ models: [] }) : done({ content: "x" })));
    await ollamaProvider.generate(req());
    await ollamaProvider.generate(req({ onTextDelta: () => {} })).catch(() => {});
    await ollamaProvider.isAvailable();
    for (const [url] of fetchMock.mock.calls) expect(String(url).startsWith("http://127.0.0.1:11434/")).toBe(true);
  });

  it("13b. the adapter source contains no other host or AI SDK", () => {
    const src = readFileSync(join(__dirname, "..", "providers", "ollama.ts"), "utf8");
    const urls = src.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
    expect(urls.every((u) => u.startsWith("http://127.0.0.1:11434"))).toBe(true);
    expect(src).not.toMatch(/anthropic|openai|generativelanguage|gemini|9router|:20128|process\.env/i);
  });

  it("14. only the caller's tools are sent; an unoffered tool call is still refused by tool-guard", async () => {
    fetchMock.mockResolvedValue(done({ tool_calls: [{ function: { name: "apply_db_migration", arguments: { sql: "drop table x" } } }] }));
    const offeredTools = [tool("db_read")];
    const r = await ollamaProvider.generate(req({ tools: offeredTools }));
    expect(sentBody().tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(["db_read"]);
    // The provider only reports what the model said; it never executes anything.
    expect(r.toolCalls[0].name).toBe("apply_db_migration");
    expect(isToolOffered(r.toolCalls[0].name, offeredToolNames(offeredTools))).toBe(false);
  });

  it("14b. with no tools supplied, no tools are sent", async () => {
    fetchMock.mockResolvedValue(done({ content: "x" }));
    await ollamaProvider.generate(req());
    expect(sentBody().tools).toBeUndefined();
  });
});
