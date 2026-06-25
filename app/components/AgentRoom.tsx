"use client";
import type { AgentSpec } from "../../agents/registry";
import type { AgentLive } from "../../lib/agent-status";

const RING: Record<AgentLive, string> = { working: "#ff3b6b", done: "#00ff9d", idle: "#3a4a63" };
const LABEL: Record<AgentLive, string> = { working: "● WORKING", done: "● READY", idle: "○ IDLE" };

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
  const ring = RING[status];
  const avatar = `https://api.dicebear.com/9.x/bottts/svg?seed=${encodeURIComponent(spec.id)}&backgroundColor=0a1120`;
  return (
    <button
      onClick={onOpen}
      style={{ ...style, borderTop: `2px solid ${spec.accent}` }}
      className="glass bracket rounded-lg p-2 flex flex-col items-center justify-center gap-1 hover:brightness-125 transition-all hover:-translate-y-0.5 text-center group"
    >
      <div className="relative">
        {/* glowing status ring */}
        <span
          className="absolute -inset-1 rounded-full"
          style={{
            border: `2px solid ${ring}`,
            boxShadow: status === "idle" ? "none" : `0 0 14px ${ring}, inset 0 0 8px ${ring}`,
            animation: status === "working" ? "ringspin 2.5s linear infinite" : "none",
            borderTopColor: status === "working" ? "transparent" : ring,
          }}
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={avatar}
          alt={spec.name}
          width={52}
          height={52}
          className="rounded-full"
          style={{ background: "#0a1120", boxShadow: `0 0 18px ${spec.accent}55` }}
        />
      </div>
      <span className="font-display text-[10px] font-bold glow-text" style={{ color: spec.accent }}>
        {spec.name.toUpperCase()}
      </span>
      <span className="text-[9px] font-mono" style={{ color: ring }}>
        {LABEL[status]}
      </span>
    </button>
  );
}
