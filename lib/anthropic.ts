import Anthropic from "@anthropic-ai/sdk";

// Model tiers by role (cost vs. capability):
// - OPUS: code fixes / QA loop, where correctness matters most.
// - SONNET: the lighter suggestion-generating agents (cycles).
// - HAIKU: conversational chat (orchestrator + per-agent), cheapest.
export const OPUS = "claude-opus-4-8";
export const SONNET = "claude-sonnet-4-6";
export const HAIKU = "claude-haiku-4-5";

// Default model (used where a single constant is still referenced).
export const MODEL = OPUS;

export const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY
