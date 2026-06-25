"use client";
import type { AgentId } from "../../lib/types";

const ACCENT: Record<AgentId, string> = {
  marketing: "var(--marketing)",
  growth: "var(--growth)",
  content: "var(--content)",
};

export function AgentCard({
  agent,
  status,
  lastRun,
  tasksToday,
}: {
  agent: AgentId;
  status: string;
  lastRun: string;
  tasksToday: number;
}) {
  return (
    <div
      style={{ borderLeft: `3px solid ${ACCENT[agent]}`, background: "var(--surface)", border: "1px solid var(--border)" }}
      className="rounded-lg p-3 mb-2"
    >
      <div className="flex justify-between items-center">
        <span className="font-semibold uppercase" style={{ color: ACCENT[agent] }}>
          {agent}
        </span>
        <span className="text-xs" style={{ color: "var(--text-dim)" }}>
          {status}
        </span>
      </div>
      <div className="text-xs mt-1" style={{ color: "var(--text-dim)" }}>
        Last run: {lastRun} · {tasksToday} today
      </div>
    </div>
  );
}
