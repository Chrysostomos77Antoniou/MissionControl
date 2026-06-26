"use client";
import { Monogram } from "./Monogram";
import { isTechnical } from "../../agents/registry";
import type { AgentSpec } from "../../agents/registry";
import type { AgentLive } from "../../lib/agent-status";

const DOT: Record<AgentLive, string> = { working: "#ff8a1f", done: "#ffd23f", idle: "#4a443a" };
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
      style={{ ...style, ["--acc" as string]: spec.accent } as React.CSSProperties}
      className="agent-room glass rounded-lg p-3 flex flex-col items-center justify-center gap-1.5 text-center"
    >
      <div className="relative mono">
        <Monogram name={spec.name} accent={spec.accent} size={44} />
        <span
          className="absolute bottom-0 right-0 w-3 h-3 rounded-full"
          style={{
            background: DOT[status],
            border: "2px solid var(--bg)",
            boxShadow: status === "working" ? `0 0 8px ${DOT[status]}` : "none",
            animation: status === "working" ? "pulse 1.3s infinite" : "none",
          }}
        />
      </div>
      <span className="font-display text-[11px] mt-1" style={{ color: "var(--text)" }}>
        {spec.name}
      </span>
      <span className="text-[10px]" style={{ color: "var(--text-dim)" }}>
        {LABEL[status]}
      </span>
      <span
        className="text-[8.5px] mt-0.5 px-1.5 py-0.5 rounded font-mono"
        style={{ color: "var(--text-dim)", background: "rgba(255,255,255,0.03)", border: "1px solid var(--border)" }}
        title="Sonnet 4.6: scheduled work · Haiku 4.5: chat · Opus 4.8: code fixes"
      >
        Sonnet · Haiku{isTechnical(spec.id) ? " · Opus" : ""}
      </span>
      <span className="acc-bar" />
    </button>
  );
}
