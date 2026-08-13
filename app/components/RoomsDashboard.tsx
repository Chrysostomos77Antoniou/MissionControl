"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AGENTS } from "../../agents/registry";
import { ChatPanel } from "./ChatPanel";
import { Monogram } from "./Monogram";
import { AgentDeck } from "./AgentDeck";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogClose } from "./ui/dialog";
import { apiGet, apiPost } from "../../lib/api";
import type { AgentStatusInfo, AgentLive } from "../../lib/agent-status";
import type { AgentId } from "../../lib/types";
import { TOOL_VISUAL, DEFAULT_TOOL_VISUAL } from "../../lib/tool-visual";

const DOT: Record<AgentLive, string> = { working: "#ff8a1f", done: "#ffd23f", idle: "#4a443a" };
const LABEL: Record<AgentLive, string> = { working: "Working", done: "Ready", idle: "Idle" };

export function RoomsDashboard() {
  const [status, setStatus] = useState<Record<string, AgentStatusInfo>>({});
  const [open, setOpen] = useState<AgentId | null>(null);
  const [orchOpen, setOrchOpen] = useState(false);
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
      // One-time sync from an external system (localStorage) after mount —
      // matches the identical pattern in ChatPanel.tsx's own history load.
      // eslint-disable-next-line react-hooks/set-state-in-effect
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

  const workingCount = AGENTS.reduce((n, a) => n + (status[a.id]?.live === "working" ? 1 : 0), 0);
  const tickerItems = AGENTS.filter((a) => status[a.id]?.live === "working").map((a) => {
    const info = status[a.id];
    const visual = (info?.tool && TOOL_VISUAL[info.tool]) || DEFAULT_TOOL_VISUAL;
    return { id: a.id, name: a.name, accent: a.accent, label: visual.label.toUpperCase() };
  });

  return (
    <>
      {/* The office is now the full stage — roster and the Orchestrator
          trigger float on top of it instead of eating fixed side columns,
          so the 3D scene gets the whole screen. */}
      <div className="relative h-full w-full rounded-xl overflow-hidden">
        <AgentDeck statuses={status} selected={selected} onToggleSelect={toggleSelected} onOpen={setOpen} />

        {/* HUD header — badge / title / Orchestrator credit-slot, mirroring
            the reference office's top bar, then a live activity ticker. */}
        <div className="absolute top-0 left-0 right-0 pt-3 px-4 flex items-start justify-between pointer-events-none z-10">
          <div
            className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 glass"
            style={{ borderColor: workingCount > 0 ? "rgba(255,174,59,0.4)" : "var(--border)" }}
          >
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{
                background: workingCount > 0 ? "var(--amber)" : "var(--text-dim)",
                animation: workingCount > 0 ? "pulse 1.3s linear infinite" : "none",
              }}
            />
            <span
              className="text-[9px] font-display tracking-wider"
              style={{ color: workingCount > 0 ? "var(--amber)" : "var(--text-dim)" }}
            >
              {workingCount > 0 ? `${workingCount} AGENT${workingCount > 1 ? "S" : ""} WORKING` : "ALL IDLE"}
            </span>
          </div>

          <div className="text-center pointer-events-none select-none">
            <div className="font-display text-lg tracking-[0.15em]" style={{ color: "var(--text)" }}>
              MISSION <span style={{ color: "var(--amber)" }}>CONTROL</span>
            </div>
            <div className="text-[9px] tracking-[0.35em] mt-0.5" style={{ color: "var(--text-dim)" }}>
              WHERE YOUR AGENTS WORK
            </div>
          </div>

          <button onClick={() => setOrchOpen(true)} className="pointer-events-auto flex items-center gap-2 group">
            <div className="leading-tight text-right">
              <div className="text-[8px] tracking-widest" style={{ color: "var(--text-dim)" }}>
                ORCHESTRATOR
              </div>
              <div className="text-[10px] font-display transition group-hover:brightness-125" style={{ color: "var(--amber)" }}>
                Tap to chat →
              </div>
            </div>
            <Monogram name="Orchestrator Core" accent="var(--amber)" size={26} />
          </button>
        </div>

        <div
          className="absolute top-14 left-4 right-4 rounded-md pointer-events-auto overflow-x-auto z-10"
          style={{ background: "rgba(7,7,7,0.55)", border: "1px solid var(--border)" }}
        >
          <div className="flex gap-6 px-3 py-1.5 whitespace-nowrap text-[9px] tracking-wider font-display">
            {tickerItems.length === 0 ? (
              <span style={{ color: "var(--text-dim)" }}>● ALL SYSTEMS IDLE</span>
            ) : (
              tickerItems.map((t) => (
                <span key={t.id} className="inline-flex items-center gap-1.5" style={{ color: "var(--text-dim)" }}>
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: t.accent }} />
                  <span style={{ color: t.accent }}>{t.name.toUpperCase()}</span> {t.label}
                </span>
              ))
            )}
          </div>
        </div>

        {/* Roster — floating top-left, below the header. Click a row to
            open a private channel; click its checkbox to select it for a
            manual Run. */}
        <aside className="absolute top-24 left-3 bottom-14 w-[190px] glass rounded-xl p-3 flex flex-col overflow-y-auto">
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
                  <Link
                    href={`/agents/${spec.id}`}
                    className="shrink-0 text-[9px] px-1 rounded transition hover:brightness-125"
                    style={{ color: "var(--text-dim)" }}
                    title={`View ${spec.name} approval rate and quality grades`}
                  >
                    Stats
                  </Link>
                </div>
              );
            })}
          </div>
        </aside>

        {/* Legend — floating bottom bar, dot + name for every agent, mirroring the reference office's footer key. */}
        <div
          className="absolute bottom-0 left-0 right-0 px-4 py-2 flex items-center justify-center gap-x-5 gap-y-1 flex-wrap pointer-events-none z-10"
          style={{ background: "linear-gradient(0deg, rgba(7,7,7,0.75), transparent)" }}
        >
          {AGENTS.map((a) => (
            <span key={a.id} className="text-[9px] tracking-wider font-display flex items-center gap-1.5" style={{ color: "var(--text-dim)" }}>
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: a.accent }} />
              {a.id.toUpperCase()}
            </span>
          ))}
        </div>
      </div>

      {/* Orchestrator chat — Dialog, same pattern as the per-agent chat below. */}
      <Dialog open={orchOpen} onOpenChange={setOrchOpen}>
        <DialogContent style={{ width: "min(560px, 94vw)", height: "min(82vh, 640px)" }}>
          <DialogHeader>
            <div className="flex items-center gap-3">
              <Monogram name="Orchestrator Core" accent="var(--amber)" size={34} />
              <div className="leading-tight">
                <DialogTitle>Orchestrator</DialogTitle>
                <DialogDescription>Chief of Staff · Haiku 4.5</DialogDescription>
              </div>
            </div>
            <DialogClose className="text-[11px]" style={{ color: "var(--text-dim)" }}>
              ✕ Close
            </DialogClose>
          </DialogHeader>
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
        </DialogContent>
      </Dialog>

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
                <div className="flex items-center gap-3">
                  <Link href={`/agents/${openSpec.id}`} className="text-[11px]" style={{ color: "var(--text-dim)" }}>
                    Stats →
                  </Link>
                  <DialogClose className="text-[11px]" style={{ color: "var(--text-dim)" }}>
                    ✕ Close
                  </DialogClose>
                </div>
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
