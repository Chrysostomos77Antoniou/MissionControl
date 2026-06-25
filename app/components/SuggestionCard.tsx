"use client";
import { useState } from "react";
import { AGENT_BY_ID } from "../../agents/registry";
import type { Suggestion } from "../../lib/types";

const PRIORITY: Record<string, string> = { high: "#ff4d6d", medium: "#ffaa00", low: "#8a8a93" };
const BLUE = "#3b82f6";
const RED = "#e5484d";
const ORANGE = "#ffaa00";
const GREEN = "#00ff88";

export function SuggestionCard({ s, onResolve }: { s: Suggestion; onResolve: () => void }) {
  const accent = AGENT_BY_ID[s.agent]?.accent ?? "var(--text-dim)";
  const [busy, setBusy] = useState<null | "handle" | "finalize">(null);
  const [result, setResult] = useState<string | null>(s.result);
  const [outcome, setOutcome] = useState<"fixed" | "action_needed" | null>(s.outcome);
  const [handled, setHandled] = useState<boolean>(!!s.result);
  const [note, setNote] = useState("");

  const act = async (status: "done" | "dismissed") => {
    await fetch(`/api/suggestions/${s.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    onResolve();
  };

  const handle = async () => {
    setBusy("handle");
    setNote("");
    const res = await fetch(`/api/suggestions/${s.id}/handle`, { method: "POST" });
    const data = (await res.json()) as { result: string; outcome: "fixed" | "action_needed" };
    setBusy(null);
    setResult(data.result);
    setOutcome(data.outcome);
    setHandled(true);
  };

  const finalize = async () => {
    setBusy("finalize");
    setNote("");
    const res = await fetch(`/api/suggestions/${s.id}/finalize`, { method: "POST" });
    const data = (await res.json()) as { ok: boolean; detail: string };
    setBusy(null);
    if (data.ok) onResolve();
    else setNote(`⚠ ${data.detail}`);
  };

  const fixed = outcome === "fixed";

  return (
    <div
      className="rounded-lg p-4 mb-3"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", borderLeft: `3px solid ${accent}` }}
    >
      <div className="flex items-center gap-2 mb-1 text-[11px]">
        <span style={{ color: accent }}>{AGENT_BY_ID[s.agent]?.name ?? s.agent}</span>
        <span style={{ color: "var(--text-dim)" }}>· {s.category}</span>
        <span style={{ color: PRIORITY[s.priority] }}>· {s.priority}</span>
      </div>
      <div className="text-sm font-semibold mb-1">{s.title}</div>
      <div className="text-xs mb-3 whitespace-pre-wrap" style={{ color: "var(--text)" }}>
        {s.body}
      </div>

      <div className="flex gap-2 flex-wrap">
        <button
          onClick={handle}
          disabled={busy !== null}
          className="px-4 py-1 rounded text-xs font-semibold"
          style={{ background: BLUE, color: "#fff" }}
        >
          {busy === "handle" ? "Agent working…" : "✓ Okay — agent handles it"}
        </button>
        <button
          onClick={() => act("done")}
          disabled={busy !== null}
          className="px-3 py-1 rounded text-xs font-semibold"
          style={{ background: ORANGE, color: "#000" }}
        >
          Done
        </button>
        <button
          onClick={() => act("dismissed")}
          disabled={busy !== null}
          className="px-3 py-1 rounded text-xs font-semibold"
          style={{ background: RED, color: "#fff" }}
        >
          Dismiss
        </button>
      </div>

      {result && (
        <div
          className="text-xs mt-3 p-3 rounded whitespace-pre-wrap"
          style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }}
        >
          <div className="font-semibold mb-2" style={{ color: accent }}>
            Agent result
          </div>

          {outcome && (
            <div
              className="text-base font-bold mb-2 px-2 py-1 rounded inline-block"
              style={{
                color: fixed ? "#000" : "#000",
                background: fixed ? GREEN : ORANGE,
              }}
            >
              {fixed ? "✓ FIXED BY AGENT" : "⚠ ACTION NEEDED FROM YOU"}
            </div>
          )}

          <div>{result}</div>

          {s.pr_url && (
            <div className="mt-2">
              <a href={s.pr_url} target="_blank" rel="noreferrer" style={{ color: BLUE }}>
                {s.pr_url}
              </a>
            </div>
          )}
        </div>
      )}

      {handled && fixed && (
        <div className="mt-3">
          <button
            onClick={finalize}
            disabled={busy !== null}
            className="px-4 py-1 rounded text-xs font-semibold"
            style={{ background: GREEN, color: "#000" }}
          >
            {busy === "finalize" ? "Committing & testing…" : "🚀 Commit, push & test"}
          </button>
          {note && (
            <div className="text-xs mt-2" style={{ color: "var(--content)" }}>
              {note}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
