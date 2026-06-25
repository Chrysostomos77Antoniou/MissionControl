import { runAgentLoop } from "./run-loop";
import { AGENTS, AGENT_BY_ID, type AgentSpec } from "./registry";
import { toolsFor } from "../tools/registry";
import { recentMemory, writeMemory, logActivity } from "../lib/memory";
import type { AgentId, Cadence } from "../lib/types";

export async function runAgent(spec: AgentSpec): Promise<string> {
  const memory = await recentMemory(spec.id, 5);
  const userMessage = `Recent suggestions you already made (do NOT repeat):\n${
    memory.map((m) => `- ${m.summary}`).join("\n") || "none"
  }\n\nRun your review now and save concrete suggestions.`;

  const summary = await runAgentLoop({
    agent: spec.id,
    system: spec.system,
    userMessage,
    tools: toolsFor(spec.id),
  });
  await writeMemory(spec.id, summary.slice(0, 500));
  return summary;
}

export async function runGroup(cadence: Cadence): Promise<Record<string, string>> {
  const due = AGENTS.filter((a) => a.cadence === cadence);
  await logActivity(due[0]?.id ?? "engineering", "cycle:start", `Running ${cadence} group (${due.length} agents).`);
  const results = await Promise.allSettled(due.map((a) => runAgent(a)));
  const out: Record<string, string> = {};
  due.forEach((a, i) => {
    const r = results[i];
    out[a.id] = r.status === "fulfilled" ? r.value : `Error: ${r.reason}`;
  });
  return out;
}

export async function runOne(id: AgentId): Promise<string> {
  return runAgent(AGENT_BY_ID[id]);
}
