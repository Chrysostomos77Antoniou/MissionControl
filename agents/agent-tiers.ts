// Task tier for every AI call site (Phase 2, commit 5).
//
// Callers never choose a provider or model — they pick a tier and the
// free-only router (lib/free-llm.ts) decides. Recap of the router's plans:
//   simple: local Qwen 3.5 4B first, then Gemini Flash-Lite
//   medium: Gemini Flash-Lite first, local Qwen last resort
//   high:   Gemini 3.8 Flash, then Flash-Lite — NEVER the local 4B model
//
// "high" is used only where a weak model is a real risk: security review and
// writing code/migrations. Everything else that reasons over evidence is
// "medium"; grading, duplicate checks and short chat are "simple".

import type { TaskTier } from "../lib/free-llm";
import type { AgentId } from "../lib/types";

export const AGENT_TIER: Readonly<Record<AgentId, TaskTier>> = Object.freeze({
  // Security review of RLS/auth/dependencies: the 4B benchmark produced false
  // security claims, so this never runs on it.
  cybersecurity: "high",
  engineering: "medium",
  developer: "medium",
  qa: "medium",
  uxdesign: "medium",
  marketing: "medium",
  growth: "medium",
  community: "medium",
  competitive: "medium",
  devops: "medium",
  copywriter: "medium",
  legal: "medium",
});

// "Okay" fix loop: writes full source files / migration files for a PR.
export const FIX_TIER: TaskTier = "high";
// Orchestrator + per-agent chat: short replies + one dispatch tool.
export const CHAT_TIER: TaskTier = "simple";
// Cycle grader and cross-agent duplicate check.
export const GRADER_TIER: TaskTier = "simple";
export const CONSENSUS_TIER: TaskTier = "simple";

export function tierForAgent(agent: AgentId): TaskTier {
  const t = AGENT_TIER[agent];
  if (!t) throw new Error(`no task tier for agent ${String(agent)}`);
  return t;
}
