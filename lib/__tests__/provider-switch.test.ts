import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../supabase", () => ({ supabaseAdmin: {} })); // the real store is never used here

import { createFreeLlmRouter, candidatesFor } from "../free-llm";
import type { FreeUsageStore } from "../free-usage";
import { LlmError } from "../llm-errors";
import type { LlmMessage, LlmRequest, LlmToolCall, LlmToolSpec } from "../llm";
import { historyForProvider, rememberToolCallProvider, toolCallProvider, SWITCH_RESULTS_HEADER } from "../provider-history";
import { tierForAgent } from "../../agents/agent-tiers";

// ---------- fakes ----------
const GEMINI_KEY = ["TESTONLY", "switch", "gemini", "1"].join("-");
const GROQ_KEY = ["TESTONLY", "switch", "groq", "2"].join("-");
type Mode = "text" | "tool" | "503" | "refused";
const mode: Record<string, Mode> = {};
const fetchMock = vi.fn();
const bodies: { target: string; body: Record<string, unknown> }[] = [];
const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
const SIG = "sig-" + "A".repeat(40);

const targetOf = (url: string) =>
  url.startsWith("http://127.0.0.1:11434") ? "ollama" : url.startsWith("https://api.groq.com/") ? "groq" : (/models\/([^:]+):/.exec(url)?.[1] ?? "unknown");

// Strict Gemini fake: like the real API (HTTP 400 INVALID_ARGUMENT), it rejects
// any functionCall part in the history that has no thought signature.
function gemini(target: string, body: { contents: { role: string; parts: Record<string, unknown>[] }[] }): Response {
  for (const c of body.contents) for (const p of c.parts) {
    if (p.functionCall && !p.thoughtSignature) {
      return j({ error: { code: 400, message: "Function call is missing a thought_signature in functionCall parts.", status: "INVALID_ARGUMENT" } }, 400);
    }
  }
  const m = mode[target] ?? "text";
  if (m === "503") return j({ error: { code: 503, message: "high demand", status: "UNAVAILABLE" } }, 503);
  if (m === "tool") return j({ candidates: [{ content: { parts: [{ functionCall: { name: "list_repo", args: { path: "lib" } }, thoughtSignature: SIG }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 5 } });
  return j({ candidates: [{ content: { parts: [{ text: `answer from ${target}` }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 5 } });
}
function groq(): Response {
  const m = mode.groq ?? "text";
  if (m === "503") return j({ error: { message: "Service Unavailable" } }, 503);
  if (m === "tool") return j({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "fc_abc", type: "function", function: { name: "list_repo", arguments: "{\"path\":\"\"}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 5 } });
  return j({ choices: [{ message: { role: "assistant", content: "answer from groq" }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5 } });
}
function ollama(): Response | Promise<Response> {
  const m = mode.ollama ?? "text";
  if (m === "refused" || m === "503") return Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
  if (m === "tool") return j({ message: { content: "", tool_calls: [{ function: { name: "list_repo", arguments: { path: "" } } }] }, done: true, done_reason: "stop", prompt_eval_count: 10, eval_count: 3 });
  return j({ message: { content: "answer from ollama" }, done: true, done_reason: "stop", prompt_eval_count: 10, eval_count: 3 });
}

class MemStore implements FreeUsageStore {
  counts = new Map<string, number>();
  async countRequestsSince(key: string) { return this.counts.get(key) ?? 0; }
  async isExhaustedSince() { return false; }
  async reserve(key: string) { this.counts.set(key, (this.counts.get(key) ?? 0) + 1); return `r${this.counts.get(key)}`; }
  async complete() {}
  async markExhausted() {}
}

const TOOLS: LlmToolSpec[] = [{ name: "list_repo", description: "List files", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
const RESULT = "README.md\n[dir] lib\n\n[evidence ref: ev1-abc123]";
const router = () => createFreeLlmRouter({ store: new MemStore(), now: () => new Date("2026-09-28T12:00:00Z"), onEvent: () => {} });
const called = () => fetchMock.mock.calls.map(([u]) => targetOf(String(u)));
const lastBody = (target: string) => [...bodies].reverse().find((b) => b.target === target)!.body;
const failure = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { if (e instanceof LlmError) return e; throw e; }
  throw new Error("expected rejection");
};
const base = (): LlmMessage[] => [{ role: "user", content: "List the repo root, then summarize." }];
const req = (messages: LlmMessage[], over: Partial<LlmRequest> = {}): LlmRequest => ({ system: "You are a test.", messages, tools: TOOLS, maxOutputTokens: 64, ...over });

// Runs turn 1 (expects a tool call), executes the "tool", runs turn 2.
async function twoTurns(tier: "simple" | "medium" | "high", before: () => void, between: () => void) {
  const rt = router();
  before();
  const messages = base();
  const r1 = await rt.generate(tier, req(messages));
  expect(r1.toolCalls.length).toBe(1);
  messages.push({ role: "assistant", content: r1.text, toolCalls: r1.toolCalls });
  messages.push({ role: "tool", toolCallId: r1.toolCalls[0].id, name: r1.toolCalls[0].name, content: RESULT });
  fetchMock.mockClear();
  bodies.length = 0;
  between();
  const r2 = await rt.generate(tier, req(messages));
  return { r1, r2, messages };
}

let savedEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  process.env.GEMINI_API_KEY = GEMINI_KEY;
  process.env.GROQ_API_KEY = GROQ_KEY;
  for (const k of Object.keys(mode)) delete mode[k];
  bodies.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (u: string, init: RequestInit) => {
    const target = targetOf(String(u));
    const body = JSON.parse(String(init.body));
    bodies.push({ target, body });
    if (target === "ollama") return ollama();
    if (target === "groq") return groq();
    return gemini(target, body);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  process.env = savedEnv;
  vi.unstubAllGlobals();
});

const geminiParts = (b: Record<string, unknown>): Record<string, unknown>[] =>
  (b.contents as { role: string; parts: Record<string, unknown>[] }[]).flatMap((c) => c.parts.map((p) => ({ role: c.role, ...p })));
const openAiRoles = (b: Record<string, unknown>) => (b.messages as { role: string }[]).map((m) => m.role);

describe("same-provider continuation is unchanged", () => {
  it("A. Groq tool call -> Groq continuation: native tool_calls + tool result", async () => {
    const { r2 } = await twoTurns("medium", () => { mode["gemini-3.5-flash-lite"] = "503"; mode["gemini-3.1-flash-lite"] = "503"; mode.groq = "tool"; }, () => { mode.groq = "text"; });
    expect(r2.provider).toBe("groq");
    const b = lastBody("groq");
    expect(openAiRoles(b)).toEqual(["system", "user", "assistant", "tool"]);
    expect((b.messages as { tool_calls?: unknown[] }[])[2].tool_calls).toHaveLength(1);
    expect(JSON.stringify(b)).not.toContain(SWITCH_RESULTS_HEADER.slice(0, 30));
  });

  it("B. Ollama tool call -> Ollama continuation: native tool_calls + tool result", async () => {
    const { r2 } = await twoTurns("simple", () => { mode.ollama = "tool"; }, () => { mode.ollama = "text"; });
    expect(r2.provider).toBe("ollama");
    const b = lastBody("ollama");
    expect(openAiRoles(b)).toEqual(["system", "user", "assistant", "tool"]);
    expect((b.messages as { tool_calls?: unknown[] }[])[2].tool_calls).toHaveLength(1);
  });

  it("Gemini tool call -> Gemini continuation: native functionCall WITH its thought signature", async () => {
    const { r2 } = await twoTurns("medium", () => { mode["gemini-3.5-flash-lite"] = "tool"; }, () => { mode["gemini-3.5-flash-lite"] = "text"; });
    expect(r2.model).toBe("gemini-3.5-flash-lite");
    const parts = geminiParts(lastBody("gemini-3.5-flash-lite"));
    expect(parts.filter((p) => p.functionCall)).toEqual([expect.objectContaining({ role: "model", thoughtSignature: SIG })]);
    expect(parts.some((p) => p.functionResponse)).toBe(true);
  });

  it("the request object itself is passed through untouched when nothing needs converting", () => {
    const msgs = base();
    expect(historyForProvider("gemini", msgs)).toBe(msgs);
    const calls: LlmToolCall[] = [{ id: "x", name: "list_repo", input: {} }];
    rememberToolCallProvider(calls, "groq");
    const h: LlmMessage[] = [...msgs, { role: "assistant", content: "", toolCalls: calls }, { role: "tool", toolCallId: "x", name: "list_repo", content: "r" }];
    expect(historyForProvider("groq", h)).toBe(h);
  });
});

describe("provider switch after a tool call: provider-neutral history", () => {
  const expectNeutralGemini = (b: Record<string, unknown>) => {
    const parts = geminiParts(b);
    expect(parts.some((p) => p.functionCall || p.functionResponse)).toBe(false);
    const text = parts.map((p) => String(p.text ?? "")).join("\n");
    expect(text).toContain(SWITCH_RESULTS_HEADER);
    expect(text).toContain('Tool call 1: list_repo {"path":""}');
    expect(text).toContain("[evidence ref: ev1-abc123]");
    // Tools are still offered normally.
    expect((b.tools as { functionDeclarations: { name: string }[] }[])[0].functionDeclarations.map((d) => d.name)).toEqual(["list_repo"]);
  };

  it("C. Groq tool call -> Gemini: no Gemini 400; Gemini gets safe provider-neutral context", async () => {
    const { r1, r2 } = await twoTurns(
      "medium",
      () => { mode["gemini-3.5-flash-lite"] = "503"; mode["gemini-3.1-flash-lite"] = "503"; mode.groq = "tool"; },
      () => { delete mode["gemini-3.5-flash-lite"]; },
    );
    expect(r1.provider).toBe("groq");
    expect([r2.provider, r2.model, r2.text]).toEqual(["gemini", "gemini-3.5-flash-lite", "answer from gemini-3.5-flash-lite"]);
    expect(r2.attempts).toEqual([{ provider: "gemini", model: "gemini-3.5-flash-lite", result: "ok" }]);
    expectNeutralGemini(lastBody("gemini-3.5-flash-lite"));
  });

  it("C2. after the switch Gemini can call tools again, and its own call stays native on the next turn", async () => {
    const { r2, messages } = await twoTurns(
      "medium",
      () => { mode["gemini-3.5-flash-lite"] = "503"; mode["gemini-3.1-flash-lite"] = "503"; mode.groq = "tool"; },
      () => { mode["gemini-3.5-flash-lite"] = "tool"; },
    );
    expect(r2.toolCalls.map((c) => c.name)).toEqual(["list_repo"]);
    messages.push({ role: "assistant", content: r2.text, toolCalls: r2.toolCalls }, { role: "tool", toolCallId: r2.toolCalls[0].id, name: "list_repo", content: "lib/main.dart" });
    mode["gemini-3.5-flash-lite"] = "text";
    const r3 = await router().generate("medium", req(messages));
    expect(r3.provider).toBe("gemini");
    const parts = geminiParts(lastBody("gemini-3.5-flash-lite"));
    expect(parts.filter((p) => p.functionCall)).toEqual([expect.objectContaining({ thoughtSignature: SIG })]); // Gemini's own call: native
    expect(parts.map((p) => String(p.text ?? "")).join("\n")).toContain(SWITCH_RESULTS_HEADER); // Groq's call: neutral
  });

  it("D. Ollama tool call -> Gemini: same", async () => {
    const { r1, r2 } = await twoTurns("simple", () => { mode.ollama = "tool"; }, () => { mode.ollama = "refused"; });
    expect(r1.provider).toBe("ollama");
    expect(r2.model).toBe("gemini-3.5-flash-lite");
    expectNeutralGemini(lastBody("gemini-3.5-flash-lite"));
  });

  const expectNeutralOpenAi = (b: Record<string, unknown>) => {
    const msgs = b.messages as { role: string; content: string | null; tool_calls?: unknown }[];
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(msgs.some((m) => m.tool_calls)).toBe(false);
    expect(msgs[3].content).toContain(SWITCH_RESULTS_HEADER);
    expect(msgs[3].content).toContain("[evidence ref: ev1-abc123]");
    expect((b.tools as { function: { name: string } }[]).map((t) => t.function.name)).toEqual(["list_repo"]);
  };

  it("E. Gemini tool call -> Groq: provider-neutral history, no Gemini signatures leak to Groq", async () => {
    const { r2 } = await twoTurns(
      "medium",
      () => { mode["gemini-3.5-flash-lite"] = "tool"; },
      () => { mode["gemini-3.5-flash-lite"] = "503"; mode["gemini-3.1-flash-lite"] = "503"; },
    );
    expect(r2.provider).toBe("groq");
    const b = lastBody("groq");
    expectNeutralOpenAi(b);
    expect(JSON.stringify(b)).not.toContain(SIG);
  });

  it("F. Gemini tool call -> Ollama: same", async () => {
    const { r2 } = await twoTurns(
      "medium",
      () => { mode["gemini-3.5-flash-lite"] = "tool"; },
      () => { mode["gemini-3.5-flash-lite"] = "503"; mode["gemini-3.1-flash-lite"] = "503"; mode.groq = "503"; },
    );
    expect(r2.provider).toBe("ollama");
    const b = lastBody("ollama");
    expectNeutralOpenAi(b);
    expect(JSON.stringify(b)).not.toContain(SIG);
  });

  it("an error result keeps its error flag in the neutral text", () => {
    const calls: LlmToolCall[] = [{ id: "c1", name: "db_read", input: { sql: "select 1" } }];
    rememberToolCallProvider(calls, "groq");
    const h = historyForProvider("gemini", [...base(), { role: "assistant", content: "checking", toolCalls: calls }, { role: "tool", toolCallId: "c1", name: "db_read", content: "denied", isError: true }])!;
    expect(h.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(h[1].content).toMatch(/^checking\n\n\[Mission Control\] In this turn the assistant called 1 tool: db_read\./);
    expect(h[2].content).toContain('--- Tool call 1: db_read {"sql":"select 1"} (error) ---\ndenied');
  });
});

describe("unchanged behaviour and fail-closed", () => {
  it("G. provider switch without any tool call: identical history, no conversion", async () => {
    const rt = router();
    mode["gemini-3.5-flash-lite"] = "503";
    mode["gemini-3.1-flash-lite"] = "503";
    const msgs: LlmMessage[] = [...base(), { role: "assistant", content: "Sure." }, { role: "user", content: "Go on." }];
    const r1 = await rt.generate("medium", req(msgs));
    expect(r1.provider).toBe("groq");
    delete mode["gemini-3.5-flash-lite"];
    const r2 = await rt.generate("medium", req(msgs));
    expect(r2.provider).toBe("gemini");
    const parts = geminiParts(lastBody("gemini-3.5-flash-lite"));
    expect(parts.map((p) => `${p.role}:${p.text}`)).toEqual(["user:List the repo root, then summarize.", "model:Sure.", "user:Go on."]);
    expect(historyForProvider("gemini", msgs)).toBe(msgs);
  });

  it("H. a foreign tool call that cannot be converted faithfully -> fail closed, nothing sent", async () => {
    const orphanCall: LlmToolCall[] = [{ id: "u1", name: "list_repo", input: {} }]; // unknown provenance
    const noResult: LlmMessage[] = [...base(), { role: "assistant", content: "", toolCalls: orphanCall }, { role: "user", content: "and?" }];
    const e = await failure(router().generate("medium", req(noResult)));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(e.message).toMatch(/^FREE_AI_QUOTA_EXHAUSTED/);
    expect(e.message).toContain("skipped_incompatible_history");
    for (const bad of [
      // result for a call that isn't in the block
      [...base(), { role: "assistant", content: "", toolCalls: orphanCall }, { role: "tool", toolCallId: "zz", name: "list_repo", content: "x" }],
      // duplicate result
      [...base(), { role: "assistant", content: "", toolCalls: orphanCall }, { role: "tool", toolCallId: "u1", name: "list_repo", content: "x" }, { role: "tool", toolCallId: "u1", name: "list_repo", content: "y" }],
      // stray tool result with no call at all
      [...base(), { role: "tool", toolCallId: "u1", name: "list_repo", content: "x" }, { role: "assistant", content: "", toolCalls: orphanCall }, { role: "tool", toolCallId: "u1", name: "list_repo", content: "x" }],
    ] as LlmMessage[][]) {
      for (const p of ["gemini", "groq", "ollama"] as const) expect(historyForProvider(p, bad)).toBeNull();
    }
  });

  it("H2. unknown-provenance tool calls are treated as foreign (converted), Gemini-encoded ids as Gemini's", () => {
    const unknown: LlmToolCall = { id: "u9", name: "list_repo", input: {} };
    const gem: LlmToolCall = { id: `gc~0~~${SIG}`, name: "list_repo", input: {} };
    expect(toolCallProvider(unknown)).toBeUndefined();
    expect(toolCallProvider(gem)).toBe("gemini");
    const h: LlmMessage[] = [...base(), { role: "assistant", content: "", toolCalls: [unknown] }, { role: "tool", toolCallId: "u9", name: "list_repo", content: "r" }];
    for (const p of ["gemini", "groq", "ollama"] as const) expect(historyForProvider(p, h)!.some((m) => m.role === "tool")).toBe(false);
    const g: LlmMessage[] = [...base(), { role: "assistant", content: "", toolCalls: [gem] }, { role: "tool", toolCallId: gem.id, name: "list_repo", content: "r" }];
    expect(historyForProvider("gemini", g)).toBe(g);
  });

  it("I. Cybersecurity/high tier stays Gemini-only, also after another provider's tool call", async () => {
    expect(candidatesFor(tierForAgent("cybersecurity")).every((c) => c.provider === "gemini")).toBe(true);
    const calls: LlmToolCall[] = [{ id: "fc_1", name: "list_repo", input: { path: "" } }];
    rememberToolCallProvider(calls, "groq");
    const msgs: LlmMessage[] = [...base(), { role: "assistant", content: "", toolCalls: calls }, { role: "tool", toolCallId: "fc_1", name: "list_repo", content: RESULT }];
    const r = await router().generate(tierForAgent("cybersecurity"), req(msgs));
    expect(r.model).toBe("gemini-3.8-flash");
    expect(called()).toEqual(["gemini-3.8-flash"]);
    for (const m of ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]) mode[m] = "503";
    fetchMock.mockClear();
    await failure(router().generate("high", req(msgs)));
    expect(called()).not.toContain("groq");
    expect(called()).not.toContain("ollama");
  });

  it("J. no paid or other provider is ever reached across switches", async () => {
    Object.assign(process.env, { OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "x", XAI_API_KEY: "x", OPENROUTER_API_KEY: "x", CEREBRAS_API_KEY: "x" });
    await twoTurns("medium", () => { mode["gemini-3.5-flash-lite"] = "503"; mode["gemini-3.1-flash-lite"] = "503"; mode.groq = "tool"; }, () => { delete mode["gemini-3.5-flash-lite"]; });
    mode["gemini-3.5-flash-lite"] = "503";
    mode.groq = "503";
    await router().generate("medium", req(base()));
    const hosts = new Set(fetchMock.mock.calls.map(([u]) => new URL(String(u)).host));
    for (const h of hosts) expect(["generativelanguage.googleapis.com", "api.groq.com", "127.0.0.1:11434"]).toContain(h);
  });

  it("the router never sends a signature-less foreign call to Gemini (the strict fake would return 400)", async () => {
    const calls: LlmToolCall[] = [{ id: "ollama-call-0", name: "list_repo", input: { path: "" } }];
    rememberToolCallProvider(calls, "ollama");
    const msgs: LlmMessage[] = [...base(), { role: "assistant", content: "", toolCalls: calls }, { role: "tool", toolCallId: "ollama-call-0", name: "list_repo", content: RESULT }];
    const r = await router().generate("medium", req(msgs));
    expect(r.provider).toBe("gemini");
    expect(r.attempts.map((a) => a.result)).toEqual(["ok"]);
  });
});
