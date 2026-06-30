"use client";
import { useEffect, useState } from "react";
import { AGENTS } from "../../agents/registry";
import { ChatPanel } from "./ChatPanel";
import { Monogram } from "./Monogram";
import { apiGet } from "../../lib/api";
import type { AgentLive } from "../../lib/agent-status";
import type { AgentId } from "../../lib/types";

const DOT: Record<AgentLive, string> = { working: "#ff8a1f", done: "#ffd23f", idle: "#4a443a" };
const LABEL: Record<AgentLive, string> = { working: "Working", done: "Ready", idle: "Idle" };

export function RoomsDashboard() {
  const [status, setStatus] = useState<Record<string, AgentLive>>({});
  const [open, setOpen] = useState<AgentId | null>(null);
  const [orchMsgs, setOrchMsgs] = useState<{ role: "you" | "agent"; text: string }[]>([]);

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
      <div className="flex gap-4" style={{ height: "76vh" }}>
        {/* Agents — left rail. Click one to open a private channel. */}
        <aside className="w-[240px] shrink-0 glass rounded-xl p-3 flex flex-col overflow-y-auto">
          <div
            className="font-display text-[11px] mb-2.5 px-1 uppercase tracking-wider"
            style={{ color: "var(--text-dim)" }}
          >
            Agents · {AGENTS.length}
          </div>
          <div className="space-y-1.5">
            {AGENTS.map((spec) => {
              const st = status[spec.id] ?? "idle";
              return (
                <button
                  key={spec.id}
                  onClick={() => setOpen(spec.id)}
                  className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left transition hover:brightness-125"
                  style={{
                    border: "1px solid var(--border)",
                    background: `color-mix(in srgb, ${spec.accent} 7%, transparent)`,
                  }}
                >
                  <Monogram name={spec.name} accent={spec.accent} size={30} />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold truncate" style={{ color: "var(--text)" }}>
                      {spec.name}
                    </div>
                    <div className="text-[10px] truncate" style={{ color: "var(--text-dim)" }}>
                      {LABEL[st]}
                    </div>
                  </div>
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{
                      background: DOT[st],
                      boxShadow: st === "working" ? `0 0 7px ${DOT[st]}` : "none",
                      animation: st === "working" ? "pulse 1.3s infinite" : "none",
                    }}
                  />
                </button>
              );
            })}
          </div>
        </aside>

        {/* Orchestrator — the main stage. */}
        <main
          className="flex-1 min-w-0 glass rounded-xl p-5 flex flex-col"
          style={{
            borderColor: "rgba(255,174,59,0.28)",
            background: "linear-gradient(180deg, rgba(255,150,40,0.05), var(--surface))",
            boxShadow: "0 0 50px -22px rgba(255,150,40,0.4)",
          }}
        >
          <header
            className="flex items-center gap-3 mb-3 pb-3"
            style={{ borderBottom: "1px solid var(--border)" }}
          >
            <Monogram name="Orchestrator Core" accent="var(--cyan)" size={44} />
            <div className="leading-snug">
              <div className="font-display text-base" style={{ color: "var(--text)" }}>
                Orchestrator
              </div>
              <div className="text-[11px]" style={{ color: "var(--text-dim)" }}>
                Chief of Staff · oversees {AGENTS.length} agents · reports to you · Haiku 4.5
              </div>
            </div>
          </header>
          <div className="flex-1 min-h-0">
            <ChatPanel
              endpoint="/api/chat"
              accent="var(--cyan)"
              agentName="Orchestrator"
              voice
              messages={orchMsgs}
              setMessages={setOrchMsgs}
              placeholder="Ask for a status report or issue a directive — type, or tap 🎤 to speak…"
            />
          </div>
        </main>
      </div>

      {openSpec && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50"
          style={{ background: "rgba(2, 6, 14, 0.78)", backdropFilter: "blur(4px)" }}
          onClick={() => setOpen(null)}
        >
          <div
            className="glass rounded-xl p-4 flex flex-col"
            style={{ width: "min(560px, 94vw)", height: "min(82vh, 640px)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex justify-between items-center mb-4 pb-3"
              style={{ borderBottom: "1px solid var(--border)" }}
            >
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
                voice
                placeholder={`Talk to ${openSpec.name} — type or tap 🎤…`}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
