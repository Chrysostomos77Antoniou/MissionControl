// Model id constants only — no SDK client, no side effects. Split out from
// lib/anthropic.ts so files shared with client components (e.g.
// agents/registry.ts, imported by the dashboard sidebar) can reference a
// model id without pulling in `new Anthropic()`, which the SDK refuses to
// run in a browser bundle (it would expose the API key).
//
// Model tiers by role (cost vs. capability):
// - OPUS: code fixes / QA loop, where correctness matters most.
// - SONNET: the lighter suggestion-generating agents (cycles).
// - HAIKU: conversational chat, and low-stakes suggestion agents (cheapest).
export const OPUS = "claude-opus-4-8";
export const SONNET = "claude-sonnet-4-6";
export const HAIKU = "claude-haiku-4-5";

// Default model (used where a single constant is still referenced).
export const MODEL = OPUS;
