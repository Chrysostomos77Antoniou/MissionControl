import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../supabase", () => ({ supabaseAdmin: {} })); // the real store is never used here

import {
  createFreeLlmRouter,
  candidatesFor,
  assertAllowedFreeModel,
  isAllowedFreeModel,
  FREE_ALLOWLIST,
  GEMINI_DAILY_CEILING,
  GROQ_DAILY_CEILING,
  MAX_ATTEMPTS_PER_REQUEST,
  type RouterEvent,
  type TaskTier,
} from "../free-llm";
import type { FreeUsageStore } from "../free-usage";
import { quotaDayStart } from "../free-usage";
import { LlmError, FREE_AI_QUOTA_EXHAUSTED } from "../llm-errors";
import type { LlmRequest } from "../llm";
import { tierForAgent } from "../../agents/agent-tiers";

// ---------- fakes ----------
const KEY = ["TESTONLY", "router", "key", "42"].join("-");
const GROQ_KEY = ["TESTONLY", "router", "groq", "key", "77"].join("-");
type Scenario = "ok" | "refused" | "402" | "429day" | "429min" | "500" | "503" | "400" | "badjson" | "hang" | "blocked";
const GROQ = "groq";
const scenario: Record<string, Scenario> = {};
const fetchMock = vi.fn();
const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
function respondGroq(sc: Scenario, init: RequestInit): Promise<Response> {
  const e = (status: number, message: string, extra: Record<string, unknown> = {}) => Promise.resolve(j({ error: { message, type: "invalid_request_error", ...extra } }, status));
  switch (sc) {
    case "ok":
      return Promise.resolve(j({ choices: [{ index: 0, message: { role: "assistant", content: "from groq" }, finish_reason: "stop" }], usage: { prompt_tokens: 15, completion_tokens: 2 } }));
    case "refused":
      return Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    case "402":
      return e(402, "payment required");
    case "blocked":
      return e(400, "API access blocked: organization spending limit reached", { code: "blocked_api_access" });
    case "429day":
      return e(429, "Rate limit reached for model `m` on tokens per day (TPD): Limit 200000, Used 199990, Requested 900.", { type: "tokens", code: "rate_limit_exceeded" });
    case "429min":
      return e(429, "Rate limit reached for model `m` on requests per minute (RPM): Limit 30, Used 30, Requested 1.", { type: "requests", code: "rate_limit_exceeded" });
    case "500":
      return e(500, "internal server error");
    case "503":
      return e(503, "Service Unavailable");
    case "400":
      return e(400, "'messages' must be an array");
    case "badjson":
      return Promise.resolve(new Response("<html>", { status: 200 }));
    case "hang":
      return new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason)));
  }
}
function respond(target: string, init: RequestInit): Promise<Response> {
  const sc = scenario[target] ?? "ok";
  if (target === GROQ) return respondGroq(sc, init);
  const isOllama = target === "ollama";
  switch (sc) {
    case "ok":
      return Promise.resolve(
        isOllama
          ? j({ message: { content: `from ${target}` }, done: true, done_reason: "stop", prompt_eval_count: 10, eval_count: 3 })
          : j({ candidates: [{ content: { parts: [{ text: `from ${target}` }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 4 } }),
      );
    case "refused":
      return Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    case "402":
      return Promise.resolve(j({ error: { code: 402, message: "Prepay credits depleted" } }, 402));
    case "429day":
      return Promise.resolve(j({ error: { code: 429, message: "check your plan and billing details", details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } }, 429));
    case "429min":
      return Promise.resolve(j({ error: { code: 429, message: "check your plan and billing details", details: [{ violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }] }] } }, 429));
    case "500":
      return Promise.resolve(j({ error: { code: 500, message: "internal" } }, 500));
    case "503":
    case "blocked":
      return Promise.resolve(j({ error: { code: 503, message: "This model is currently experiencing high demand.", status: "UNAVAILABLE" } }, 503));
    case "400":
      return Promise.resolve(j({ error: { code: 400, message: "Invalid JSON payload" } }, 400));
    case "badjson":
      return Promise.resolve(new Response("<html>", { status: 200 }));
    case "hang":
      return new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason)));
  }
}
const targetOf = (url: string) =>
  url.startsWith("http://127.0.0.1:11434") ? "ollama" : url.startsWith("https://api.groq.com/") ? GROQ : (/models\/([^:]+):/.exec(url)?.[1] ?? "unknown");

class MemStore implements FreeUsageStore {
  counts = new Map<string, number>();
  exhausted = new Set<string>();
  rows: { id: string; model: string; cost: 0; input_tokens: number; output_tokens: number }[] = [];
  failCount = false;
  failCountOnly = false;
  failReserve = false;
  sinceSeen: Date[] = [];
  async countRequestsSince(key: string, since: Date) {
    this.sinceSeen.push(since);
    if (this.failCount || this.failCountOnly) throw new Error("db down");
    return this.counts.get(key) ?? 0;
  }
  async isExhaustedSince(key: string) {
    if (this.failCount) throw new Error("db down");
    return this.exhausted.has(key);
  }
  async reserve(key: string) {
    if (this.failReserve) throw new Error("insert failed");
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    const id = `row${this.rows.length}`;
    this.rows.push({ id, model: `free:${key}`, cost: 0, input_tokens: 0, output_tokens: 0 });
    return id;
  }
  async complete(id: string, u: { inputTokens: number; outputTokens: number }) {
    const r = this.rows.find((x) => x.id === id)!;
    r.input_tokens = u.inputTokens;
    r.output_tokens = u.outputTokens;
  }
  async markExhausted(key: string) {
    this.exhausted.add(key);
    this.rows.push({ id: `x${this.rows.length}`, model: `free-exhausted:${key}`, cost: 0, input_tokens: 0, output_tokens: 0 });
  }
}

let store: MemStore;
let events: unknown[];
const NOW = new Date("2026-09-26T15:00:00Z");
const router = () => createFreeLlmRouter({ store, now: () => NOW, onEvent: (e) => events.push(e) });
const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({ messages: [{ role: "user", content: "secret prompt about player Maria, maria@example.com" }], maxOutputTokens: 32, ...over });
const called = () => fetchMock.mock.calls.map(([u]) => targetOf(String(u)));
const failure = async (p: Promise<unknown>) => {
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
  process.env.GROQ_API_KEY = GROQ_KEY;
  for (const k of Object.keys(scenario)) delete scenario[k];
  store = new MemStore();
  events = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation((u: string, init: RequestInit) => respond(targetOf(String(u)), init));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  process.env = savedEnv;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------- tests ----------
describe("tier routing", () => {
  it("1. simple + Ollama available -> Ollama", async () => {
    const r = await router().generate("simple", req());
    expect([r.provider, r.model, r.cost, r.tier]).toEqual(["ollama", "qwen3.5:4b", 0, "simple"]);
    expect(called()).toEqual(["ollama"]);
  });

  it("2/9. simple + Ollama unavailable -> Gemini Flash-Lite", async () => {
    scenario.ollama = "refused";
    const r = await router().generate("simple", req());
    expect([r.provider, r.model]).toEqual(["gemini", "gemini-3.5-flash-lite"]);
    expect(r.attempts.map((a) => a.result)).toEqual(["provider_unavailable", "ok"]);
  });

  it("3. medium -> Gemini Flash-Lite first", async () => {
    const r = await router().generate("medium", req());
    expect([r.provider, r.model]).toEqual(["gemini", "gemini-3.5-flash-lite"]);
    expect(called()).toEqual(["gemini-3.5-flash-lite"]);
  });

  it("4. high -> strongest free model (gemini-3.8-flash); never Ollama", async () => {
    const r = await router().generate("high", req());
    expect(r.model).toBe("gemini-3.8-flash");
    expect(candidatesFor("high").some((c) => c.provider === "ollama")).toBe(false);
  });

  it("plans are finite, allowlisted, and never repeat a model", () => {
    for (const t of ["simple", "medium", "high"] as TaskTier[]) {
      const p = candidatesFor(t);
      expect(p.length).toBeLessThanOrEqual(MAX_ATTEMPTS_PER_REQUEST);
      expect(new Set(p.map((c) => `${c.provider}:${c.model}`)).size).toBe(p.length);
      for (const c of p) expect(isAllowedFreeModel(c.provider, c.model)).toBe(true);
    }
    expect(candidatesFor("simple")[0].provider).toBe("ollama");
  });
});

describe("80% quota ceiling (enforced before the request)", () => {
  it("ceilings are 400 / 400 / 16", () => {
    expect(GEMINI_DAILY_CEILING).toEqual({ "gemini-3.5-flash-lite": 400, "gemini-3.1-flash-lite": 400, "gemini-3.8-flash": 16 });
  });

  it("5. under the ceiling -> allowed, and the request is recorded before it is sent", async () => {
    store.counts.set("gemini:gemini-3.5-flash-lite", 399);
    const r = await router().generate("medium", req());
    expect(r.model).toBe("gemini-3.5-flash-lite");
    expect(store.counts.get("gemini:gemini-3.5-flash-lite")).toBe(400);
  });

  it("6/7/29. at (or above) the ceiling -> blocked with no network call, next free option used", async () => {
    store.counts.set("gemini:gemini-3.5-flash-lite", 400);
    store.counts.set("gemini:gemini-3.1-flash-lite", 450);
    const r = await router().generate("medium", req());
    expect(r.provider).toBe("groq");
    expect(called()).toEqual([GROQ]);
    expect(r.attempts.map((a) => a.result)).toEqual(["skipped_ceiling", "skipped_ceiling", "ok"]);
  });

  it("6/7/29b. Gemini and Groq at their ceilings -> medium falls back to local Ollama without remote calls", async () => {
    store.counts.set("gemini:gemini-3.5-flash-lite", 400);
    store.counts.set("gemini:gemini-3.1-flash-lite", 400);
    store.counts.set("groq:openai/gpt-oss-120b", GROQ_DAILY_CEILING);
    const r = await router().generate("medium", req());
    expect(r.provider).toBe("ollama");
    expect(called()).toEqual(["ollama"]);
    expect(r.attempts.map((a) => a.result)).toEqual(["skipped_ceiling", "skipped_ceiling", "skipped_ceiling", "ok"]);
  });

  it("6b. gemini-3.8-flash is blocked at 16/day", async () => {
    store.counts.set("gemini:gemini-3.8-flash", 16);
    const r = await router().generate("high", req());
    expect(r.model).toBe("gemini-3.5-flash-lite");
    expect(called()).not.toContain("gemini-3.8-flash");
  });

  it("8/30. usage cannot be read -> Gemini is never called", async () => {
    store.failCount = true;
    const e = await failure(router().generate("high", req()));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(e.message).toMatch(/^FREE_AI_QUOTA_EXHAUSTED/);
    expect(e.kind).toBe("PROVIDER_UNAVAILABLE");
  });

  it("8/30b. exhaustion state readable but request count not -> Gemini still not called", async () => {
    store.failCountOnly = true;
    const e = await failure(router().generate("high", req()));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(e.message).toMatch(/^FREE_AI_QUOTA_EXHAUSTED/);
    expect(store.rows).toHaveLength(0);
  });

  it("8b. usage cannot be read -> simple tasks still use local Ollama only", async () => {
    store.failCount = true;
    scenario.ollama = "refused";
    await failure(router().generate("simple", req()));
    expect(called()).toEqual(["ollama"]);
  });

  it("8c. the request cannot be recorded -> Gemini is not called", async () => {
    store.failReserve = true;
    await failure(router().generate("high", req()));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a persisted 'exhausted today' marker blocks the model without a call", async () => {
    store.exhausted.add("gemini:gemini-3.8-flash");
    const r = await router().generate("high", req());
    expect(r.model).toBe("gemini-3.5-flash-lite");
    expect(called()).toEqual(["gemini-3.5-flash-lite"]);
  });
});

describe("error handling and fallback (finite, free-only)", () => {
  it("10. Gemini says daily quota exhausted -> marked exhausted, next FREE option", async () => {
    scenario["gemini-3.5-flash-lite"] = "429day";
    const r = await router().generate("medium", req());
    expect(r.model).toBe("gemini-3.1-flash-lite");
    expect(store.exhausted.has("gemini:gemini-3.5-flash-lite")).toBe(true);
  });

  it("10b. an exhausted model is skipped on the next request without a call", async () => {
    scenario["gemini-3.5-flash-lite"] = "429day";
    const rt = router();
    await rt.generate("medium", req());
    fetchMock.mockClear();
    await rt.generate("medium", req());
    expect(called()).toEqual(["gemini-3.1-flash-lite"]);
  });

  it("11. everything exhausted -> FREE_AI_QUOTA_EXHAUSTED and the marker is logged", async () => {
    store.counts.set("gemini:gemini-3.8-flash", 16);
    store.counts.set("gemini:gemini-3.5-flash-lite", 400);
    store.counts.set("gemini:gemini-3.1-flash-lite", 400);
    store.counts.set("groq:openai/gpt-oss-120b", GROQ_DAILY_CEILING);
    const e = await failure(router().generate("high", req()));
    expect(e.kind).toBe("QUOTA_EXHAUSTED");
    expect(e.message).toMatch(/^FREE_AI_QUOTA_EXHAUSTED: .*no paid fallback/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ marker: "FREE_AI_QUOTA_EXHAUSTED", tier: "high" }));
  });

  it("12. 402 on Gemini -> ALL Gemini models blocked for the day; only the next FREE options are tried", async () => {
    scenario["gemini-3.5-flash-lite"] = "402";
    scenario[GROQ] = "503";
    const r = await router().generate("medium", req());
    expect(r.provider).toBe("ollama");
    expect(called()).toEqual(["gemini-3.5-flash-lite", GROQ, "ollama"]);
    for (const m of ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash"]) expect(store.exhausted.has(`gemini:${m}`)).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ result: "quota_exhausted", billing: true }));
  });

  it("12b. 402 on a high task -> stops (no Ollama or Groq for high tasks, no paid model)", async () => {
    scenario["gemini-3.8-flash"] = "402";
    const e = await failure(router().generate("high", req()));
    expect(called()).toEqual(["gemini-3.8-flash"]);
    expect(e.message).toMatch(/^FREE_AI_QUOTA_EXHAUSTED/);
  });

  it("13. per-minute 429 -> finite fallback, short cooldown, no retry of the same model", async () => {
    scenario["gemini-3.5-flash-lite"] = "429min";
    const rt = router();
    const r = await rt.generate("medium", req());
    expect(r.model).toBe("gemini-3.1-flash-lite");
    expect(called()).toEqual(["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);
    expect(store.exhausted.has("gemini:gemini-3.5-flash-lite")).toBe(false);
    fetchMock.mockClear();
    await rt.generate("medium", req());
    expect(called()).toEqual(["gemini-3.1-flash-lite"]); // still cooling down
  });

  it("13b. every candidate rate-limited -> returns RATE_LIMITED after one attempt each", async () => {
    for (const m of ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]) scenario[m] = "429min";
    const e = await failure(router().generate("high", req()));
    expect(e.kind).toBe("RATE_LIMITED");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("14. provider unavailable -> finite fallback", async () => {
    scenario["gemini-3.5-flash-lite"] = "500";
    scenario["gemini-3.1-flash-lite"] = "refused";
    scenario[GROQ] = "503";
    const r = await router().generate("medium", req());
    expect(r.provider).toBe("ollama");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("14b. timeout -> finite fallback", async () => {
    scenario.ollama = "hang";
    const r = await router().generate("simple", req({ timeoutMs: 20 }));
    expect(r.model).toBe("gemini-3.5-flash-lite");
  });

  it("15. invalid request -> returned immediately, no provider switching", async () => {
    scenario["gemini-3.5-flash-lite"] = "400";
    const e = await failure(router().generate("medium", req()));
    expect(e.kind).toBe("INVALID_REQUEST");
    expect(called()).toEqual(["gemini-3.5-flash-lite"]);
  });

  it("15b. cancellation is not treated as an outage", async () => {
    scenario["gemini-3.5-flash-lite"] = "hang";
    const ac = new AbortController();
    const p = router().generate("medium", req({ signal: ac.signal }));
    setTimeout(() => ac.abort(), 5);
    expect((await failure(p)).kind).toBe("INVALID_REQUEST");
    expect(called()).toEqual(["gemini-3.5-flash-lite"]);
  });

  it("16. model failure -> finite fallback", async () => {
    scenario["gemini-3.5-flash-lite"] = "badjson";
    scenario["gemini-3.1-flash-lite"] = "badjson";
    scenario[GROQ] = "badjson";
    scenario.ollama = "badjson";
    const e = await failure(router().generate("medium", req()));
    expect(e.kind).toBe("MODEL_FAILURE");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("17. no provider/model is attempted twice in one request", async () => {
    for (const k of ["ollama", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", GROQ]) scenario[k] = "500";
    await failure(router().generate("simple", req()));
    const c = called();
    expect(new Set(c).size).toBe(c.length);
    expect(c.length).toBeLessThanOrEqual(MAX_ATTEMPTS_PER_REQUEST);
  });

  it("a mid-stream failure is not spliced onto another provider's answer", async () => {
    fetchMock.mockImplementationOnce(async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(JSON.stringify({ message: { content: "partial" }, done: false }) + "\n"));
            c.enqueue(new TextEncoder().encode("garbage\n"));
            c.close();
          },
        }),
      ),
    );
    const e = await failure(router().generate("simple", req({ onTextDelta: () => {} })));
    expect(e.kind).toBe("MODEL_FAILURE");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("Gemini without a key is skipped without a request or a usage row", async () => {
    delete process.env.GEMINI_API_KEY;
    scenario.ollama = "refused";
    const r = await router().generate("simple", req());
    expect(r.provider).toBe("groq");
    expect(called()).toEqual(["ollama", GROQ]);
    expect(store.rows.filter((r) => r.model.startsWith("free:gemini"))).toHaveLength(0);
  });
});

describe("hard allowlist", () => {
  it("allowlist is exactly the five approved free models", () => {
    expect(FREE_ALLOWLIST.map((a) => `${a.provider}:${a.model}`).sort()).toEqual([
      "gemini:gemini-3.1-flash-lite",
      "gemini:gemini-3.5-flash-lite",
      "gemini:gemini-3.8-flash",
      "groq:openai/gpt-oss-120b",
      "ollama:qwen3.5:4b",
    ]);
    expect(Object.isFrozen(FREE_ALLOWLIST)).toBe(true);
  });

  it.each([
    ["18. arbitrary provider", "groq", "llama-3"],
    ["19. arbitrary model", "ollama", "llama3:70b"],
    ["19b. arbitrary gemini model", "gemini", "gemini-3.8-flash-latest"],
    ["20. anthropic", "anthropic", "claude-opus-4-8"],
    ["20b. claude via gemini slot", "gemini", "claude-sonnet-4-6"],
    ["21. openai", "openai", "gpt-5"],
    ["22. 9router", "9router", "claude-opus-55"],
    ["23. paid gemini", "gemini", "gemini-3.1-pro-preview"],
    ["23b. paid gemini 2.5 pro", "gemini", "gemini-2.5-pro"],
    ["other groq model", "groq", "openai/gpt-oss-20b"],
    ["groq model under another provider", "gemini", "openai/gpt-oss-120b"],
    ["cerebras", "cerebras", "gpt-oss-120b"],
    ["xai / grok", "xai", "grok-4"],
    ["openrouter", "openrouter", "openai/gpt-oss-120b"],
  ])("%s is rejected", (_n, provider, model) => {
    expect(isAllowedFreeModel(provider, model)).toBe(false);
    expect(() => assertAllowedFreeModel(provider, model)).toThrow(/not an approved free model/);
  });

  it("unknown tier is rejected before any call", async () => {
    await expect(router().generate("paid" as TaskTier, req())).rejects.toThrow(/unknown task tier/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("callers cannot name a provider/model/base URL through the request", async () => {
    for (const k of ["model", "provider", "baseURL", "apiKey"]) {
      await expect(router().generate("medium", { ...req(), [k]: "anthropic" } as unknown as LlmRequest)).rejects.toThrow(/non-generic field/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("24. environment variables cannot override provider or model", async () => {
    Object.assign(process.env, {
      LLM_PROVIDER: "anthropic", LLM_MODEL: "claude-opus-4-8", FREE_LLM_MODEL: "gemini-3.1-pro-preview", GEMINI_MODEL: "gemini-2.5-pro",
      OLLAMA_HOST: "http://evil.example", OLLAMA_MODEL: "llama3:70b", ANTHROPIC_BASE_URL: "http://localhost:20128/v1", OPENAI_API_KEY: "x",
    });
    await router().generate("simple", req());
    await router().generate("high", req());
    expect(called()).toEqual(["ollama", "gemini-3.8-flash"]);
    for (const [u] of fetchMock.mock.calls) expect(["127.0.0.1:11434", "generativelanguage.googleapis.com", "api.groq.com"]).toContain(new URL(String(u)).host);
  });

  it("the router source has no paid provider, no env-based selection, no retry loop", () => {
    const src = readFileSync(join(__dirname, "..", "free-llm.ts"), "utf8");
    expect(src).not.toMatch(new RegExp(["anthro" + "pic\\.", "open" + "ai", "9ro" + "uter", ":20128", "claude-", "gpt-"].join("|"), "i"));
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/while\s*\(|setTimeout|setInterval/);
  });
});

describe("usage records and privacy", () => {
  it("25/27. free calls are recorded with cost 0, provider/model and tokens only", async () => {
    await router().generate("simple", req());
    await router().generate("medium", req());
    expect(store.rows).toEqual([
      { id: "row0", model: "free:ollama:qwen3.5:4b", cost: 0, input_tokens: 10, output_tokens: 3 },
      { id: "row1", model: "free:gemini:gemini-3.5-flash-lite", cost: 0, input_tokens: 20, output_tokens: 4 },
    ]);
    const all = JSON.stringify(store.rows) + JSON.stringify(events);
    expect(all).not.toMatch(/secret prompt|Maria|maria@example\.com/);
  });

  it("26. API keys never reach usage records or router events", async () => {
    scenario["gemini-3.5-flash-lite"] = "400";
    await failure(router().generate("medium", req()));
    await router().generate("high", req());
    expect(JSON.stringify(store.rows) + JSON.stringify(events)).not.toContain(KEY);
    // Groq too: failing and succeeding calls, error text included.
    for (const m of ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]) scenario[m] = "503";
    scenario[GROQ] = "400";
    const e = await failure(router().generate("medium", req()));
    await router().generate("simple", req());
    expect(JSON.stringify(store.rows) + JSON.stringify(events) + e.message + String(e.stack)).not.toContain(GROQ_KEY);
  });

  it("events carry only tier/provider/model/result (+ counts)", async () => {
    store.counts.set("gemini:gemini-3.8-flash", 16);
    await router().generate("high", req());
    for (const e of events as RouterEvent[]) {
      if ("marker" in (e as object)) continue;
      for (const k of Object.keys(e)) expect(["tier", "provider", "model", "result", "billing", "used", "ceiling"]).toContain(k);
    }
  });

  it("28. quota counting uses the quota-day start for 'now'", async () => {
    await router().generate("medium", req());
    expect(store.sinceSeen[0].toISOString()).toBe(quotaDayStart(NOW).toISOString());
  });
});

describe("result shape", () => {
  it("exposes provider, model, usage (incl. estimated flag) and cost 0", async () => {
    const r = await router().generate("simple", req());
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 3, estimated: false });
    expect(r.cost).toBe(0);
    expect(r.attempts).toEqual([{ provider: "ollama", model: "qwen3.5:4b", result: "ok" }]);
    expect(FREE_AI_QUOTA_EXHAUSTED).toBe("FREE_AI_QUOTA_EXHAUSTED");
  });
});

describe("Groq free-plan fallback", () => {
  const GROQ_ROW = "groq:openai/gpt-oss-120b";

  it("R1. Gemini unavailable (503) -> Groq", async () => {
    scenario["gemini-3.5-flash-lite"] = "503";
    scenario["gemini-3.1-flash-lite"] = "503";
    const r = await router().generate("medium", req());
    expect([r.provider, r.model, r.cost]).toEqual(["groq", "openai/gpt-oss-120b", 0]);
    expect(called()).toEqual(["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", GROQ]);
    expect(r.attempts.map((a) => a.result)).toEqual(["provider_unavailable", "provider_unavailable", "ok"]);
  });

  it("R2/R3. Gemini + Groq unavailable -> Ollama only where the tier permits it", async () => {
    for (const k of ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", GROQ]) scenario[k] = "503";
    const r = await router().generate("medium", req());
    expect(r.provider).toBe("ollama");
    expect(called()).toEqual(["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", GROQ, "ollama"]);
    fetchMock.mockClear();
    scenario["gemini-3.8-flash"] = "503";
    const e = await failure(router().generate("high", req()));
    expect(called()).toEqual(["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);
    expect(e.message).toMatch(/^FREE_AI_QUOTA_EXHAUSTED: .*no paid fallback/);
  });

  it("R4/R5. everything unavailable -> FREE_AI_QUOTA_EXHAUSTED, and only approved free hosts were contacted", async () => {
    Object.assign(process.env, {
      OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "x", XAI_API_KEY: "x", OPENROUTER_API_KEY: "x", CEREBRAS_API_KEY: "x",
    });
    for (const k of ["ollama", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", GROQ]) scenario[k] = "503";
    const e = await failure(router().generate("medium", req()));
    expect(e.message).toMatch(/^FREE_AI_QUOTA_EXHAUSTED/);
    expect(e.kind).toBe("PROVIDER_UNAVAILABLE");
    expect(events).toContainEqual(expect.objectContaining({ marker: "FREE_AI_QUOTA_EXHAUSTED", tier: "medium" }));
    const hosts = new Set(fetchMock.mock.calls.map(([u]) => new URL(String(u)).host));
    expect([...hosts].sort()).toEqual(["127.0.0.1:11434", "api.groq.com", "generativelanguage.googleapis.com"]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("R6. no API keys at all -> Gemini and Groq make no request and no usage row; Ollama still works", async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GROQ_API_KEY;
    const s = await router().generate("simple", req());
    expect(s.provider).toBe("ollama");
    const m = await router().generate("medium", req());
    expect(m.provider).toBe("ollama");
    expect(m.attempts.map((a) => `${a.provider}=${a.result}`)).toEqual([
      "gemini=provider_unavailable", "gemini=provider_unavailable", "groq=provider_unavailable", "ollama=ok",
    ]);
    expect(called()).toEqual(["ollama", "ollama"]);
    expect(store.rows.filter((r) => !r.model.startsWith("free:ollama"))).toHaveLength(0);
    // High tasks never use the local 4B model: with no keys they stop.
    fetchMock.mockClear();
    const e = await failure(router().generate("high", req()));
    expect(e.message).toMatch(/^FREE_AI_QUOTA_EXHAUSTED/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("R8. Groq at its local daily ceiling -> Groq is NOT called", async () => {
    expect(GROQ_DAILY_CEILING).toBe(500);
    scenario["gemini-3.5-flash-lite"] = "503";
    scenario["gemini-3.1-flash-lite"] = "503";
    store.counts.set(GROQ_ROW, GROQ_DAILY_CEILING);
    const r = await router().generate("medium", req());
    expect(r.provider).toBe("ollama");
    expect(called()).not.toContain(GROQ);
    expect(r.attempts).toContainEqual({ provider: "groq", model: "openai/gpt-oss-120b", result: "skipped_ceiling" });
  });

  it("R8b. one below the ceiling -> allowed, and recorded BEFORE the request with cost 0", async () => {
    scenario["gemini-3.5-flash-lite"] = "503";
    scenario["gemini-3.1-flash-lite"] = "503";
    store.counts.set(GROQ_ROW, GROQ_DAILY_CEILING - 1);
    const reserveOrder: string[] = [];
    const origReserve = store.reserve.bind(store);
    store.reserve = async (k: string) => {
      reserveOrder.push(`reserve:${k}:${fetchMock.mock.calls.length}`);
      return origReserve(k);
    };
    const r = await router().generate("medium", req());
    expect(r.provider).toBe("groq");
    expect(store.counts.get(GROQ_ROW)).toBe(GROQ_DAILY_CEILING);
    // Groq was reserved when 2 requests (the two Gemini attempts) had been sent, i.e. before its own.
    expect(reserveOrder).toContain(`reserve:${GROQ_ROW}:2`);
    expect(store.rows.find((x) => x.model === `free:${GROQ_ROW}`)).toEqual(expect.objectContaining({ cost: 0, input_tokens: 15, output_tokens: 2 }));
  });

  it("R8c. a persisted Groq 'exhausted today' marker blocks it without a call", async () => {
    scenario["gemini-3.5-flash-lite"] = "503";
    scenario["gemini-3.1-flash-lite"] = "503";
    store.exhausted.add(GROQ_ROW);
    const r = await router().generate("medium", req());
    expect(r.provider).toBe("ollama");
    expect(called()).not.toContain(GROQ);
  });

  it("R8d. Groq usage cannot be read or recorded -> Groq is not called (fail closed)", async () => {
    scenario["gemini-3.5-flash-lite"] = "503";
    scenario["gemini-3.1-flash-lite"] = "503";
    store.failReserve = true; // Gemini can't be recorded either, so it isn't called
    const r = await router().generate("medium", req());
    expect(r.provider).toBe("ollama");
    expect(called()).toEqual(["ollama"]);
  });

  it("R9. Groq 503 -> classified unavailable, next approved provider", async () => {
    scenario["gemini-3.5-flash-lite"] = "503";
    scenario["gemini-3.1-flash-lite"] = "503";
    scenario[GROQ] = "503";
    const r = await router().generate("medium", req());
    expect(r.attempts.find((a) => a.provider === "groq")?.result).toBe("provider_unavailable");
    expect(r.provider).toBe("ollama");
    expect(store.exhausted.has(GROQ_ROW)).toBe(false);
  });

  it("R10. Groq per-minute 429 -> rate_limited, next provider, short cooldown (existing policy)", async () => {
    scenario["gemini-3.5-flash-lite"] = "503";
    scenario["gemini-3.1-flash-lite"] = "503";
    scenario[GROQ] = "429min";
    const rt = router();
    const r = await rt.generate("medium", req());
    expect(r.attempts.find((a) => a.provider === "groq")?.result).toBe("rate_limited");
    expect(r.provider).toBe("ollama");
    expect(store.exhausted.has(GROQ_ROW)).toBe(false);
    fetchMock.mockClear();
    const r2 = await rt.generate("medium", req());
    expect(r2.attempts.find((a) => a.provider === "groq")?.result).toBe("skipped_cooldown");
    expect(called()).not.toContain(GROQ);
  });

  it("Groq daily-limit 429 -> quota_exhausted and marked exhausted for the day", async () => {
    scenario["gemini-3.5-flash-lite"] = "503";
    scenario["gemini-3.1-flash-lite"] = "503";
    scenario[GROQ] = "429day";
    const rt = router();
    await rt.generate("medium", req());
    expect(store.exhausted.has(GROQ_ROW)).toBe(true);
    fetchMock.mockClear();
    await rt.generate("medium", req());
    expect(called()).not.toContain(GROQ);
  });

  it("Groq billing / spend-limit block -> Groq exhausted for the day; never 'fixed' by paying", async () => {
    for (const sc of ["402", "blocked"] as Scenario[]) {
      store = new MemStore();
      scenario["gemini-3.5-flash-lite"] = "503";
      scenario["gemini-3.1-flash-lite"] = "503";
      scenario[GROQ] = sc;
      const r = await router().generate("medium", req());
      expect(r.provider).toBe("ollama");
      expect(store.exhausted.has(GROQ_ROW)).toBe(true);
      // Gemini was not marked by Groq's billing wall.
      expect(store.exhausted.has("gemini:gemini-3.5-flash-lite")).toBe(false);
    }
    expect(events).toContainEqual(expect.objectContaining({ provider: "groq", result: "quota_exhausted", billing: true }));
  });

  it("Groq invalid request -> returned immediately, no provider switching", async () => {
    scenario["gemini-3.5-flash-lite"] = "503";
    scenario["gemini-3.1-flash-lite"] = "503";
    scenario[GROQ] = "400";
    const e = await failure(router().generate("medium", req()));
    expect(e.kind).toBe("INVALID_REQUEST");
    expect(called()).not.toContain("ollama");
  });

  it("Groq timeout -> unavailable, next provider", async () => {
    scenario["gemini-3.5-flash-lite"] = "503";
    scenario["gemini-3.1-flash-lite"] = "503";
    scenario[GROQ] = "hang";
    const r = await router().generate("medium", req({ timeoutMs: 20 }));
    expect(r.attempts.find((a) => a.provider === "groq")?.result).toBe("provider_unavailable");
    expect(r.provider).toBe("ollama");
  });

  it("tier order: Groq comes after Gemini for simple/medium; Ollama stays last for medium; high is Gemini only", () => {
    const order = (t: TaskTier) => candidatesFor(t).map((c) => `${c.provider}:${c.model}`);
    expect(order("simple")).toEqual(["ollama:qwen3.5:4b", "gemini:gemini-3.5-flash-lite", "gemini:gemini-3.1-flash-lite", "groq:openai/gpt-oss-120b"]);
    expect(order("medium")).toEqual(["gemini:gemini-3.5-flash-lite", "gemini:gemini-3.1-flash-lite", "groq:openai/gpt-oss-120b", "ollama:qwen3.5:4b"]);
    expect(order("high")).toEqual(["gemini:gemini-3.8-flash", "gemini:gemini-3.5-flash-lite", "gemini:gemini-3.1-flash-lite"]);
  });

  it("Cybersecurity stays on the high tier, which never includes the local Qwen model or Groq", () => {
    expect(tierForAgent("cybersecurity")).toBe("high");
    const plan = candidatesFor(tierForAgent("cybersecurity"));
    expect(plan.some((c) => c.provider === "ollama" || /qwen/i.test(c.model))).toBe(false);
    // gpt-oss-120b has not passed the Mission Control security benchmark.
    expect(plan.some((c) => c.provider === "groq" || /gpt-oss/i.test(c.model))).toBe(false);
    expect(plan.every((c) => c.provider === "gemini")).toBe(true);
  });

  it("Cybersecurity can never route to Groq at runtime, even with every Gemini model down and Groq healthy", async () => {
    for (const m of ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]) scenario[m] = "503";
    const e = await failure(router().generate(tierForAgent("cybersecurity"), req()));
    expect(e.message).toMatch(/^FREE_AI_QUOTA_EXHAUSTED/);
    expect(called()).not.toContain(GROQ);
    expect(called()).not.toContain("ollama");
    expect(store.rows.some((r) => r.model.includes("groq"))).toBe(false);
    // Same when Gemini is blocked before any request (ceilings / no key).
    fetchMock.mockClear();
    delete process.env.GEMINI_API_KEY;
    await failure(router().generate(tierForAgent("cybersecurity"), req()));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
