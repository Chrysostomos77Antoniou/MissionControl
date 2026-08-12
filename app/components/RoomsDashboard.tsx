"use client";
import { useEffect, useRef, useState } from "react";
import { AGENTS } from "../../agents/registry";
import { ChatPanel } from "./ChatPanel";
import { Monogram } from "./Monogram";
import { AgentDeck } from "./AgentDeck";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogClose } from "./ui/dialog";
import { apiGet, apiPost } from "../../lib/api";
import type { AgentStatusInfo, AgentLive } from "../../lib/agent-status";
import type { AgentId } from "../../lib/types";

const DOT: Record<AgentLive, string> = { working: "#ff8a1f", done: "#ffd23f", idle: "#4a443a" };
const LABEL: Record<AgentLive, string> = { working: "Working", done: "Ready", idle: "Idle" };

export function RoomsDashboard() {
  const [status, setStatus] = useState<Record<string, AgentStatusInfo>>({});
  const [open, setOpen] = useState<AgentId | null>(null);
  const [selected, setSelected] = useState<Set<AgentId>>(new Set());
  const [running, setRunning] = useState(false);
  const [orchMsgs, setOrchMsgs] = useState<{ role: "you" | "agent"; text: string }[]>([]);
  const orchLoadedRef = useRef(false);

  const toggleSelected = (id: AgentId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runSelected = async () => {
    if (selected.size === 0 || running) return;
    setRunning(true);
    await apiPost("/api/agents/run", { ids: Array.from(selected) });
    setRunning(false);
    setSelected(new Set());
    apiGet<Record<string, AgentStatusInfo>>("/api/agent-status").then((d) => {
      if (d) setStatus(d);
    });
  };

  useEffect(() => {
    const load = () =>
      apiGet<Record<string, AgentStatusInfo>>("/api/agent-status").then((d) => {
        if (d) setStatus(d);
      });
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  // Load the saved orchestrator conversation after mount (client only —
  // avoids the SSR hydration mismatch that reading localStorage during
  // render would cause).
  useEffect(() => {
    if (orchLoadedRef.current) return;
    orchLoadedRef.current = true;
    try {
      const raw = localStorage.getItem("mc_chat_orchestrator");
      const parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed) && parsed.length) setOrchMsgs(parsed);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (orchMsgs.length === 0) return;
    try {
      localStorage.setItem("mc_chat_orchestrator", JSON.stringify(orchMsgs));
    } catch {
      /* ignore */
    }
  }, [orchMsgs]);

  const openSpec = open ? AGENTS.find((a) => a.id === open) ?? null : null;

  return (
    <>
      <div className="flex gap-3 h-full">
        {/* Roster — compact left rail. Click a row to open a private
            channel; click its checkbox to select it for a manual Run. */}
        <aside className="w-[190px] shrink-0 glass rounded-xl p-3 flex flex-col overflow-y-auto">
          <div className="flex items-center justify-between mb-2.5 px-1">
            <div className="font-display text-[11px] uppercase tracking-wider" style={{ color: "var(--text-dim)" }}>
              Agents · {AGENTS.length}
            </div>
          </div>
          <button
            onClick={runSelected}
            disabled={selected.size === 0 || running}
            className="text-[10px] px-2 py-1 mb-2 rounded font-display"
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              color: selected.size === 0 || running ? "var(--text-dim)" : "#00ff88",
            }}
          >
            {running ? "Running…" : `▶ Run (${selected.size})`}
          </button>
          <div className="space-y-1">
            {AGENTS.map((spec) => {
              const st = status[spec.id]?.live ?? "idle";
              const checked = selected.has(spec.id);
              return (
                <div
                  key={spec.id}
                  className="w-full flex items-center gap-1.5 px-1.5 py-1.5 rounded-lg transition hover:brightness-125"
                  style={{
                    border: "1px solid var(--border)",
                    background: `color-mix(in srgb, ${spec.accent} 7%, transparent)`,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleSelected(spec.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="shrink-0 w-3 h-3"
                    title={`Select ${spec.name} to run manually`}
                  />
                  <button onClick={() => setOpen(spec.id)} className="flex-1 min-w-0 flex items-center gap-1.5 text-left">
                    <Monogram name={spec.name} accent={spec.accent} size={22} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[10px] font-semibold truncate" style={{ color: "var(--text)" }}>
                        {spec.name}
                      </div>
                      <div className="text-[9px] truncate" style={{ color: "var(--text-dim)" }}>
                        {LABEL[st]}
                      </div>
                    </div>
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{
                        background: DOT[st],
                        boxShadow: st === "working" ? `0 0 6px ${DOT[st]}` : "none",
                        animation: st === "working" ? "pulse 1.3s linear infinite" : "none",
                      }}
                    />
                  </button>
                </div>
              );
            })}
          </div>
        </aside>

        {/* The office — the main stage. */}
        <div className="flex-1 min-w-0 rounded-xl overflow-hidden">
          <AgentDeck statuses={status} selected={selected} onToggleSelect={toggleSelected} onOpen={setOpen} />
        </div>

        {/* Orchestrator — right rail. */}
        <main
          className="w-[360px] shrink-0 glass rounded-xl p-4 flex flex-col"
          style={{
            borderColor: "rgba(255,174,59,0.28)",
            background: "linear-gradient(180deg, rgba(255,150,40,0.05), var(--surface))",
            boxShadow: "0 0 50px -22px rgba(255,150,40,0.4)",
          }}
        >
          <header className="flex items-center gap-3 mb-3 pb-3" style={{ borderBottom: "1px solid var(--border)" }}>
            <Monogram name="Orchestrator Core" accent="var(--amber)" size={38} />
            <div className="leading-snug">
              <div className="font-display text-sm" style={{ color: "var(--text)" }}>
                Orchestrator
              </div>
              <div className="text-[10px]" style={{ color: "var(--text-dim)" }}>
                Chief of Staff · Haiku 4.5
              </div>
            </div>
          </header>
          <div className="flex-1 min-h-0">
            <ChatPanel
              endpoint="/api/chat"
              accent="var(--amber)"
              agentName="Orchestrator"
              voice
              messages={orchMsgs}
              setMessages={setOrchMsgs}
              placeholder="Ask for a status report or issue a directive…"
            />
          </div>
        </main>
      </div>

      {/* Radix Dialog (shadcn/ui pattern) instead of the old hand-rolled
          `fixed inset-0` overlay — gets real focus-trapping, Escape-to-close,
          aria-modal, and focus restored to the triggering row on close, none
          of which the manual version had. */}
      <Dialog open={!!openSpec} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent style={{ width: "min(560px, 94vw)", height: "min(82vh, 640px)" }}>
          {openSpec && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <Monogram name={openSpec.name} accent={openSpec.accent} size={34} />
                  <div className="leading-tight">
                    <DialogTitle>{openSpec.name}</DialogTitle>
                    <DialogDescription>Private channel · Haiku 4.5</DialogDescription>
                  </div>
                </div>
                <DialogClose className="text-[11px]" style={{ color: "var(--text-dim)" }}>
                  ✕ Close
                </DialogClose>
              </DialogHeader>
              <div className="flex-1 min-h-0">
                <ChatPanel
                  endpoint={`/api/agent-chat/${openSpec.id}`}
                  accent={openSpec.accent}
                  agentName={openSpec.name}
                  voice
                  storageKey={`mc_chat_${openSpec.id}`}
                  placeholder={`Talk to ${openSpec.name} — type or tap 🎤…`}
                />
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
