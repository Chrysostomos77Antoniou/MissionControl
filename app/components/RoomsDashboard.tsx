"use client";
import { useEffect, useState } from "react";
import { AGENTS } from "../../agents/registry";
import { AgentRoom } from "./AgentRoom";
import { ChatPanel } from "./ChatPanel";
import type { AgentLive } from "../../lib/agent-status";
import type { AgentId } from "../../lib/types";

// Perimeter cells of a 4x4 grid; the centre 2x2 holds the orchestrator.
const POS: [number, number][] = [
  [1, 1], [1, 2], [1, 3], [1, 4],
  [2, 1], [2, 4],
  [3, 1], [3, 4],
  [4, 1], [4, 2], [4, 3],
];

export function RoomsDashboard() {
  const [status, setStatus] = useState<Record<string, AgentLive>>({});
  const [open, setOpen] = useState<AgentId | null>(null);

  useEffect(() => {
    const load = () => fetch("/api/agent-status").then((r) => r.json()).then(setStatus);
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  const openSpec = open ? AGENTS.find((a) => a.id === open) ?? null : null;

  return (
    <>
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(4,1fr)", gridTemplateRows: "repeat(4,130px)" }}>
        {AGENTS.map((spec, i) => (
          <AgentRoom
            key={spec.id}
            spec={spec}
            status={status[spec.id] ?? "idle"}
            onOpen={() => setOpen(spec.id)}
            style={{ gridRow: POS[i][0], gridColumn: POS[i][1] }}
          />
        ))}
        <div className="glass bracket rounded-xl p-4 flex flex-col" style={{ gridRow: "2 / 4", gridColumn: "2 / 4" }}>
          <div className="flex items-center gap-2 mb-3">
            <span
              className="w-2.5 h-2.5 rounded-full"
              style={{ background: "var(--cyan)", boxShadow: "0 0 12px var(--cyan)", animation: "pulse 1.8s infinite" }}
            />
            <span className="font-display text-xs font-bold glow-text tracking-widest" style={{ color: "var(--cyan)" }}>
              ORCHESTRATOR CORE
            </span>
          </div>
          <div className="flex-1 min-h-0">
            <ChatPanel endpoint="/api/chat" accent="var(--cyan)" placeholder="Issue a directive to the fleet…" />
          </div>
        </div>
      </div>

      {openSpec && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50"
          style={{ background: "rgba(2, 6, 14, 0.78)", backdropFilter: "blur(4px)" }}
          onClick={() => setOpen(null)}
        >
          <div
            className="glass bracket w-[500px] h-[540px] rounded-xl p-4 flex flex-col"
            style={{ borderTop: `2px solid ${openSpec.accent}` }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-3">
              <div className="flex items-center gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`https://api.dicebear.com/9.x/bottts/svg?seed=${encodeURIComponent(openSpec.id)}&backgroundColor=0a1120`}
                  alt={openSpec.name}
                  width={30}
                  height={30}
                  className="rounded-full"
                  style={{ boxShadow: `0 0 14px ${openSpec.accent}` }}
                />
                <span className="font-display text-xs font-bold glow-text" style={{ color: openSpec.accent }}>
                  {openSpec.name.toUpperCase()} · SECURE CHANNEL
                </span>
              </div>
              <button onClick={() => setOpen(null)} className="font-mono text-[11px]" style={{ color: "var(--text-dim)" }}>
                ✕ CLOSE
              </button>
            </div>
            <div className="flex-1 min-h-0">
              <ChatPanel
                endpoint={`/api/agent-chat/${openSpec.id}`}
                accent={openSpec.accent}
                placeholder={`Open a private channel with ${openSpec.name}…`}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
