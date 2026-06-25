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
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(4,1fr)", gridTemplateRows: "repeat(4,120px)" }}>
        {AGENTS.map((spec, i) => (
          <AgentRoom
            key={spec.id}
            spec={spec}
            status={status[spec.id] ?? "idle"}
            onOpen={() => setOpen(spec.id)}
            style={{ gridRow: POS[i][0], gridColumn: POS[i][1] }}
          />
        ))}
        <div
          style={{ gridRow: "2 / 4", gridColumn: "2 / 4", background: "var(--surface)", border: "1px solid var(--border)" }}
          className="rounded-lg p-3 flex flex-col"
        >
          <div className="text-xs font-semibold mb-2" style={{ color: "var(--marketing)" }}>
            ⬢ ORCHESTRATOR
          </div>
          <div className="flex-1 min-h-0">
            <ChatPanel endpoint="/api/chat" accent="var(--marketing)" placeholder="Direct the team or ask for status…" />
          </div>
        </div>
      </div>

      {openSpec && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50"
          style={{ background: "rgba(0,0,0,0.6)" }}
          onClick={() => setOpen(null)}
        >
          <div
            className="w-[480px] h-[520px] rounded-lg p-4 flex flex-col"
            style={{ background: "var(--bg)", border: "1px solid var(--border)", borderTop: `3px solid ${openSpec.accent}` }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-2">
              <span className="font-semibold" style={{ color: openSpec.accent }}>
                {openSpec.name} — private chat
              </span>
              <button onClick={() => setOpen(null)} className="text-xs" style={{ color: "var(--text-dim)" }}>
                ✕ close
              </button>
            </div>
            <div className="flex-1 min-h-0">
              <ChatPanel
                endpoint={`/api/agent-chat/${openSpec.id}`}
                accent={openSpec.accent}
                placeholder={`Ask ${openSpec.name} anything in its area…`}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
