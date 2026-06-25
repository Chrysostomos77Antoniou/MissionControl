"use client";
import type { AgentSpec } from "../../agents/registry";
import type { AgentLive } from "../../lib/agent-status";

const DOT: Record<AgentLive, string> = { working: "#ff4d6d", done: "#00ff88", idle: "#555" };
const LABEL: Record<AgentLive, string> = { working: "working", done: "done", idle: "idle" };

export function AgentRoom({
  spec,
  status,
  onOpen,
  style,
}: {
  spec: AgentSpec;
  status: AgentLive;
  onOpen: () => void;
  style?: React.CSSProperties;
}) {
  return (
    <button
      onClick={onOpen}
      style={{ ...style, background: "var(--surface)", border: "1px solid var(--border)", borderTop: `3px solid ${spec.accent}` }}
      className="rounded-lg p-3 flex flex-col items-center justify-center gap-2 hover:brightness-125 transition text-center"
    >
      <span
        className="w-6 h-6 rounded-full"
        style={{
          background: DOT[status],
          boxShadow: status === "idle" ? "none" : `0 0 10px ${DOT[status]}`,
          animation: status === "working" ? "pulse 1.2s infinite" : "none",
        }}
      />
      <span className="text-xs font-semibold" style={{ color: spec.accent }}>
        {spec.name}
      </span>
      <span className="text-[10px]" style={{ color: "var(--text-dim)" }}>
        {LABEL[status]}
      </span>
    </button>
  );
}
