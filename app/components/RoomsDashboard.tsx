"use client";
import { useEffect, useState } from "react";
import { AGENTS } from "../../agents/registry";
import { AgentRoom } from "./AgentRoom";
import { ChatPanel } from "./ChatPanel";
import { Monogram } from "./Monogram";
import type { AgentLive } from "../../lib/agent-status";
import type { AgentId } from "../../lib/types";

// All 12 perimeter cells of a 4x4 grid; the centre 2x2 holds the orchestrator.
const POS: [number, number][] = [
  [1, 1], [1, 2], [1, 3], [1, 4],
  [2, 1], [2, 4],
  [3, 1], [3, 4],
  [4, 1], [4, 2], [4, 3], [4, 4],
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
        <div
          className="glass rounded-xl p-5 flex flex-col"
          style={{
            gridRow: "2 / 4",
            gridColumn: "2 / 4",
            borderColor: "rgba(255,174,59,0.28)",
            background: "linear-gradient(180deg, rgba(255,150,40,0.06), var(--surface))",
            boxShadow: "0 0 50px -18px rgba(255,150,40,0.4)",
          }}
        >
          <div className="flex items-center gap-3 mb-4 pb-4" style={{ borderBottom: "1px solid var(--border)" }}>
            <Monogram name="Orchestrator Core" accent="var(--cyan)" size={44} />
            <div className="leading-snug">
              <div className="font-display text-sm" style={{ color: "var(--text)" }}>
                Orchestrator
              </div>
              <div className="text-[11px]" style={{ color: "var(--text-dim)" }}>
                Chief of Staff · overseeing {AGENTS.length} agents · reports to you
              </div>
            </div>
          </div>
          <div className="flex-1 min-h-0">
            <ChatPanel endpoint="/api/chat" accent="var(--cyan)" placeholder="Ask for a full status report, or issue a directive…" />
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
            className="glass w-[500px] h-[540px] rounded-xl p-4 flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-4 pb-3" style={{ borderBottom: "1px solid var(--border)" }}>
              <div className="flex items-center gap-3">
                <Monogram name={openSpec.name} accent={openSpec.accent} size={34} />
                <div className="leading-tight">
                  <div className="font-display text-sm" style={{ color: "var(--text)" }}>
                    {openSpec.name}
                  </div>
                  <div className="text-[11px]" style={{ color: "var(--text-dim)" }}>
                    Private channel
                  </div>
                </div>
              </div>
              <button onClick={() => setOpen(null)} className="text-[11px]" style={{ color: "var(--text-dim)" }}>
                ✕ Close
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
