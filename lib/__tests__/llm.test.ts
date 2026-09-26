import { describe, it, expect } from "vitest";
import { assertGenericRequest, estimateRequestTokens, estimateTokens, toLlmToolSpec, type LlmRequest } from "../llm";
import { classifyHttpError, classifyNetworkError, canTryNextFreeProvider, LlmError, FREE_AI_QUOTA_EXHAUSTED } from "../llm-errors";
import { offeredToolNames, isToolOffered } from "../tool-guard";

const base: LlmRequest = { messages: [{ role: "user", content: "hi" }], maxOutputTokens: 100 };

describe("assertGenericRequest: no provider-specific fields leak into the generic interface", () => {
  it("accepts a plain request", () => {
    expect(assertGenericRequest(base)).toBe(base);
  });
  it.each(["model", "baseURL", "provider", "apiKey", "thinking", "cache_control", "output_config", "safetySettings", "extra_body"])(
    "rejects %s",
    (key) => {
      expect(() => assertGenericRequest({ ...base, [key]: "x" } as unknown as LlmRequest)).toThrow(/non-generic field/);
    },
  );
  it("validates messages, output limit and temperature", () => {
    expect(() => assertGenericRequest({ ...base, messages: [] })).toThrow();
    expect(() => assertGenericRequest({ ...base, maxOutputTokens: 0 })).toThrow();
    expect(() => assertGenericRequest({ ...base, maxOutputTokens: 100000 })).toThrow();
    expect(() => assertGenericRequest({ ...base, temperature: 5 })).toThrow();
  });
  it("validates tools and forbids mixing tools with JSON mode", () => {
    const t = { name: "db_read", description: "d", parameters: { type: "object" as const, properties: {} } };
    expect(() => assertGenericRequest({ ...base, tools: [t, t] })).toThrow(/duplicate/);
    expect(() => assertGenericRequest({ ...base, tools: [{ ...t, name: "bad name!" }] })).toThrow(/invalid tool name/);
    expect(() => assertGenericRequest({ ...base, tools: [t], json: {} })).toThrow(/tools or JSON/);
  });
});

describe("tool specs stay compatible with Phase 1 tool-offering enforcement", () => {
  it("converts registry-style tools and still feeds tool-guard", () => {
    const spec = toLlmToolSpec({ name: "save_suggestion", description: "Save", input_schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } });
    expect(spec).toEqual({ name: "save_suggestion", description: "Save", parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } });
    const offered = offeredToolNames([spec]);
    expect(isToolOffered("save_suggestion", offered)).toBe(true);
    expect(isToolOffered("apply_db_migration", offered)).toBe(false);
  });
});

describe("token estimates", () => {
  it("rounds up and counts system, messages, tool calls and tools", () => {
    expect(estimateTokens("abcde")).toBe(2);
    const n = estimateRequestTokens({
      system: "x".repeat(40),
      messages: [{ role: "user", content: "y".repeat(40) }, { role: "assistant", content: "", toolCalls: [{ id: "1", name: "t", input: {} }] }],
    });
    expect(n).toBeGreaterThan(20);
  });
});

describe("classifyHttpError", () => {
  it("402 is QUOTA_EXHAUSTED with the billing flag — never a reason to pay", () => {
    const e = classifyHttpError("gemini", 402, "Payment Required");
    expect(e.kind).toBe("QUOTA_EXHAUSTED");
    expect(e.billing).toBe(true);
  });
  it("billing wording is QUOTA_EXHAUSTED regardless of status", () => {
    expect(classifyHttpError("gemini", 403, "This API requires billing to be enabled").kind).toBe("QUOTA_EXHAUSTED");
    expect(classifyHttpError("gemini", 400, "insufficient_quota").kind).toBe("QUOTA_EXHAUSTED");
    expect(classifyHttpError("gemini", 400, "Your credit balance is too low").billing).toBe(true);
  });
  it("429 with a daily/quota signal is QUOTA_EXHAUSTED; plain 429 is RATE_LIMITED", () => {
    expect(classifyHttpError("gemini", 429, "RESOURCE_EXHAUSTED: Quota exceeded for GenerateRequestsPerDayPerProjectPerModel-FreeTier").kind).toBe("QUOTA_EXHAUSTED");
    expect(classifyHttpError("gemini", 429, "You exceeded your current quota").kind).toBe("QUOTA_EXHAUSTED");
    expect(classifyHttpError("gemini", 429, "Too many requests, slow down").kind).toBe("RATE_LIMITED");
  });
  it("auth, timeouts and 5xx are PROVIDER_UNAVAILABLE", () => {
    expect(classifyHttpError("gemini", 401, "API key not valid").kind).toBe("PROVIDER_UNAVAILABLE");
    expect(classifyHttpError("gemini", 408).kind).toBe("PROVIDER_UNAVAILABLE");
    expect(classifyHttpError("ollama", 503, "overloaded").kind).toBe("PROVIDER_UNAVAILABLE");
  });
  it("other 4xx are INVALID_REQUEST", () => {
    expect(classifyHttpError("gemini", 400, "Invalid JSON payload").kind).toBe("INVALID_REQUEST");
    expect(classifyHttpError("ollama", 404, "model not found").kind).toBe("INVALID_REQUEST");
  });
  it("keeps error messages short", () => {
    expect(classifyHttpError("gemini", 500, "z".repeat(5000)).message.length).toBeLessThan(300);
  });
});

describe("classifyNetworkError", () => {
  it("connection refused and timeouts are PROVIDER_UNAVAILABLE", () => {
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    expect(classifyNetworkError("ollama", refused).kind).toBe("PROVIDER_UNAVAILABLE");
    expect(classifyNetworkError("ollama", refused).message).toMatch(/ECONNREFUSED/);
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    expect(classifyNetworkError("gemini", timeout).kind).toBe("PROVIDER_UNAVAILABLE");
  });
  it("passes an existing LlmError through unchanged", () => {
    const e = new LlmError("RATE_LIMITED", "x", { provider: "gemini" });
    expect(classifyNetworkError("gemini", e)).toBe(e);
  });
});

describe("fallback eligibility", () => {
  it("free-quota, rate-limit, unavailability and model failures may move to the next FREE provider", () => {
    for (const k of ["QUOTA_EXHAUSTED", "RATE_LIMITED", "PROVIDER_UNAVAILABLE", "MODEL_FAILURE"] as const) {
      expect(canTryNextFreeProvider(new LlmError(k, "x", { provider: "gemini" }))).toBe(true);
    }
  });
  it("an invalid request is not retried elsewhere", () => {
    expect(canTryNextFreeProvider(new LlmError("INVALID_REQUEST", "x", { provider: "gemini" }))).toBe(false);
  });
  it("exports the hard-stop marker", () => {
    expect(FREE_AI_QUOTA_EXHAUSTED).toBe("FREE_AI_QUOTA_EXHAUSTED");
  });
});
