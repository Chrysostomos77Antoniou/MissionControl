"use client";
import { useEffect, useState } from "react";
import { AGENTS } from "../../agents/registry";
import { AgentRoom } from "./AgentRoom";
import { ChatPanel } from "./ChatPanel";
import { Monogram } from "./Monogram";
import { apiGet } from "../../lib/api";
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
  // Orchestrator conversation lives here so it's shared between the inline
  // panel and the expanded window (no lost history when you maximise).
  const [orchMsgs, setOrchMsgs] = useState<{ role: "you" | "agent"; text: string }[]>([]);
  const [orchBig, setOrchBig] = useState(false);

  useEffect(() => {
    const load = () =>
      apiGet<Record<string, AgentLive>>("/api/agent-status").then((d) => {
        if (d) setStatus(d);
      });
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  const openSpec = open ? AGENTS.find((a) => a.id === open) ?? null : null;

  return (
    <>
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(4,1fr)", gridTemplateRows: "repeat(4,168px)" }}>
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
          <div className="flex items-center gap-3 mb-3 pb-3" style={{ borderBottom: "1px solid var(--border)" }}>
            <Monogram name="Orchestrator Core" accent="var(--cyan)" size={40} />
            <div className="leading-snug flex-1 min-w-0">
              <div className="font-display text-sm" style={{ color: "var(--text)" }}>
                Orchestrator
              </div>
              <div className="text-[11px] truncate" style={{ color: "var(--text-dim)" }}>
                Chief of Staff · {AGENTS.length} agents · Haiku 4.5
              </div>
            </div>
            <button
              onClick={() => setOrchBig(true)}
              title="Expand chat"
              className="shrink-0 text-[11px] px-2.5 py-1 rounded-md font-semibold"
              style={{ color: "var(--text)", border: "1px solid var(--border)", background: "color-mix(in srgb, var(--cyan) 14%, transparent)" }}
            >
              ⤢ Expand
            </button>
          </div>
          <div className="flex-1 min-h-0">
            <ChatPanel
              endpoint="/api/chat"
              accent="var(--cyan)"
              agentName="Orchestrator"
              messages={orchMsgs}
              setMessages={setOrchMsgs}
              placeholder="Ask for a full status report, or issue a directive…"
            />
          </div>
        </div>
      </div>

      {orchBig && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50"
          style={{ background: "rgba(2, 6, 14, 0.8)", backdropFilter: "blur(4px)" }}
          onClick={() => setOrchBig(false)}
        >
          <div
            className="glass rounded-xl p-5 flex flex-col"
            style={{ width: "min(820px, 92vw)", height: "min(82vh, 780px)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-4 pb-3" style={{ borderBottom: "1px solid var(--border)" }}>
              <div className="flex items-center gap-3">
                <Monogram name="Orchestrator Core" accent="var(--cyan)" size={36} />
                <div className="leading-tight">
                  <div className="font-display text-sm" style={{ color: "var(--text)" }}>Orchestrator</div>
                  <div className="text-[11px]" style={{ color: "var(--text-dim)" }}>Chief of Staff · {AGENTS.length} agents · Haiku 4.5</div>
                </div>
              </div>
              <button onClick={() => setOrchBig(false)} className="text-[11px]" style={{ color: "var(--text-dim)" }}>
                ✕ Close
              </button>
            </div>
            <div className="flex-1 min-h-0">
              <ChatPanel
                endpoint="/api/chat"
                accent="var(--cyan)"
                agentName="Orchestrator"
                messages={orchMsgs}
                setMessages={setOrchMsgs}
                placeholder="Ask for a full status report, or issue a directive…"
              />
            </div>
          </div>
        </div>
      )}

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
                    Private channel · Haiku 4.5
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
                agentName={openSpec.name}
                placeholder={`Open a private channel with ${openSpec.name}…`}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
