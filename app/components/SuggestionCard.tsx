"use client";
import { useState } from "react";
import { AGENT_BY_ID } from "../../agents/registry";
import type { Suggestion } from "../../lib/types";

const PRIORITY: Record<string, string> = { high: "#ff4d6d", medium: "#ffaa00", low: "#8a8a93" };

export function SuggestionCard({ s, onResolve }: { s: Suggestion; onResolve: () => void }) {
  const accent = AGENT_BY_ID[s.agent]?.accent ?? "var(--text-dim)";
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const act = async (status: "done" | "dismissed") => {
    await fetch(`/api/suggestions/${s.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    onResolve();
  };

  const publish = async () => {
    setBusy(true);
    setNote("");
    const res = await fetch(`/api/suggestions/${s.id}/publish`, { method: "POST" });
    const data = (await res.json()) as { ok: boolean; detail: string };
    setBusy(false);
    if (data.ok) onResolve();
    else setNote(`⚠ ${data.detail}`);
  };

  const canPublish = s.publishable && s.platform === "facebook" && s.post_text;

  return (
    <div
      className="rounded-lg p-4 mb-3"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", borderLeft: `3px solid ${accent}` }}
    >
      <div className="flex items-center gap-2 mb-1 text-[11px]">
        <span style={{ color: accent }}>{AGENT_BY_ID[s.agent]?.name ?? s.agent}</span>
        <span style={{ color: "var(--text-dim)" }}>· {s.category}</span>
        <span style={{ color: PRIORITY[s.priority] }}>· {s.priority}</span>
        {canPublish && <span style={{ color: "var(--marketing)" }}>· ready to publish</span>}
      </div>
      <div className="text-sm font-semibold mb-1">{s.title}</div>

      {canPublish && (
        <div className="text-xs rounded p-2 mb-2 whitespace-pre-wrap" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
          {s.post_text}
        </div>
      )}

      <div className="text-xs mb-3 whitespace-pre-wrap" style={{ color: "var(--text)" }}>
        {s.body}
      </div>

      <div className="flex gap-2 flex-wrap">
        {canPublish && (
          <button
            onClick={publish}
            disabled={busy}
            className="px-3 py-1 rounded text-xs font-semibold"
            style={{ background: "var(--marketing)", color: "#000" }}
          >
            {busy ? "Publishing…" : "✓ Okay — Publish to Facebook"}
          </button>
        )}
        <button
          onClick={() => act("done")}
          className="px-3 py-1 rounded text-xs"
          style={{ background: "var(--growth)", color: "#000" }}
        >
          Mark done
        </button>
        <button
          onClick={() => act("dismissed")}
          className="px-3 py-1 rounded text-xs"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-dim)" }}
        >
          Dismiss
        </button>
      </div>
      {note && (
        <div className="text-xs mt-2" style={{ color: "var(--content)" }}>
          {note}
        </div>
      )}
    </div>
  );
}
