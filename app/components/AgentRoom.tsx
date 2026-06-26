"use client";
import { Monogram } from "./Monogram";
import type { AgentSpec } from "../../agents/registry";
import type { AgentLive } from "../../lib/agent-status";

const DOT: Record<AgentLive, string> = { working: "#f0b54a", done: "#3ddc97", idle: "#3a4253" };
const LABEL: Record<AgentLive, string> = { working: "Working", done: "Ready", idle: "Idle" };

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
      style={style}
      className="glass rounded-lg p-3 flex flex-col items-center justify-center gap-2 transition-colors text-center"
    >
      <div className="relative">
        <Monogram name={spec.name} accent={spec.accent} size={44} />
        <span
          className="absolute bottom-0 right-0 w-3 h-3 rounded-full"
          style={{
            background: DOT[status],
            border: "2px solid var(--bg)",
            boxShadow: status === "working" ? `0 0 6px ${DOT[status]}` : "none",
            animation: status === "working" ? "pulse 1.4s infinite" : "none",
          }}
        />
      </div>
      <span className="font-display text-[11px]" style={{ color: "var(--text)" }}>
        {spec.name}
      </span>
      <span className="text-[10px]" style={{ color: "var(--text-dim)" }}>
        {LABEL[status]}
      </span>
    </button>
  );
}
