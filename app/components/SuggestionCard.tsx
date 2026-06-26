"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { AGENT_BY_ID } from "../../agents/registry";
import type { Suggestion } from "../../lib/types";

const PRIORITY: Record<string, string> = { high: "#ff4d6d", medium: "#ffaa00", low: "#8a8a93" };
const BLUE = "#3b82f6";
const RED = "#e5484d";
const ORANGE = "#ffaa00";
const GREEN = "#00ff88";

type QaStatus = "testing" | "fixing" | "passed" | "needs_owner" | null;

export function SuggestionCard({ s, onResolve }: { s: Suggestion; onResolve: () => void }) {
  const accent = AGENT_BY_ID[s.agent]?.accent ?? "var(--text-dim)";
  const [busy, setBusy] = useState<null | "handle" | "finalize">(null);
  const [result, setResult] = useState<string | null>(s.result);
  const [qa, setQa] = useState<QaStatus>(s.qa_status);
  const [qaLog, setQaLog] = useState<string | null>(s.qa_log);
  const [note, setNote] = useState("");
  const [diff, setDiff] = useState<{ filename: string; additions: number; deletions: number; patch: string }[] | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const polling = useRef(false);

  const loadDiff = async () => {
    setShowDiff((v) => !v);
    if (diff) return;
    const r = await fetch(`/api/suggestions/${s.id}/diff`);
    const d = (await r.json()) as { files: typeof diff };
    setDiff(d.files ?? []);
  };

  const poll = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    const res = await fetch(`/api/suggestions/${s.id}/qa-tick`, { method: "POST" });
    const d = (await res.json().catch(() => null)) as { qa_status: QaStatus; qa_log?: string | null } | null;
    polling.current = false;
    if (!d) return;
    setQa(d.qa_status);
    if (d.qa_log) setQaLog(d.qa_log);
  }, [s.id]);

  // Poll while QA is running (testing/fixing).
  useEffect(() => {
    if (qa !== "testing" && qa !== "fixing") return;
    const t = setInterval(poll, 30000);
    return () => clearInterval(t);
  }, [qa, poll]);

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
    try {
      const res = await fetch(`/api/suggestions/${s.id}/handle`, { method: "POST" });
      const d = (await res.json().catch(() => null)) as { qa_status: QaStatus; result: string } | null;
      if (!res.ok || !d) throw new Error("bad response");
      setResult(d.result);
      setQa(d.qa_status);
    } catch {
      setResult("⚠ Could not start the agent. Check Anthropic credits and that the app is running.");
    } finally {
      setBusy(null);
    }
  };

  const pushLive = async () => {
    setBusy("finalize");
    setNote("");
    const res = await fetch(`/api/suggestions/${s.id}/finalize`, { method: "POST" });
    const d = (await res.json().catch(() => null)) as { ok: boolean; detail: string } | null;
    setBusy(null);
    if (d?.ok) onResolve();
    else setNote(`⚠ ${d?.detail ?? "Push failed — try again."}`);
  };

  const banner = (() => {
    if (qa === "testing" || qa === "fixing")
      return { text: "🧪 QA TESTING ON EMULATOR…", bg: BLUE, fg: "#fff" };
    if (qa === "passed") return { text: "✓ QA PASSED — READY TO PUSH LIVE", bg: GREEN, fg: "#000" };
    if (qa === "needs_owner") return { text: "⚠ ACTION NEEDED FROM YOU", bg: ORANGE, fg: "#000" };
    return null;
  })();

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
          disabled={busy !== null || qa === "testing" || qa === "fixing"}
          className="px-4 py-1 rounded text-xs font-semibold"
          style={{ background: BLUE, color: "#fff", opacity: qa === "testing" || qa === "fixing" ? 0.5 : 1 }}
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

      {(result || banner) && (
        <div
          className="text-xs mt-3 p-3 rounded whitespace-pre-wrap"
          style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }}
        >
          <div className="font-semibold mb-2" style={{ color: accent }}>
            Agent result
          </div>
          {banner && (
            <div
              className="text-base font-bold mb-2 px-2 py-1 rounded inline-block"
              style={{ background: banner.bg, color: banner.fg }}
            >
              {banner.text}
              {(qa === "testing" || qa === "fixing") && s.qa_attempts > 1 ? ` (attempt ${s.qa_attempts})` : ""}
            </div>
          )}
          {result && <div>{result}</div>}
          {qaLog && (
            <div className="mt-2 opacity-80" style={{ color: ORANGE }}>
              Last test failure:{"\n"}
              {qaLog.slice(-1500)}
            </div>
          )}
        </div>
      )}

      {qa === "passed" && (
        <div className="mt-3">
          <button
            onClick={loadDiff}
            className="px-3 py-1 mr-2 rounded text-xs"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--cyan)" }}
          >
            {showDiff ? "▾ Hide diff" : "▸ View diff"}
          </button>
          <button
            onClick={pushLive}
            disabled={busy !== null}
            className="px-4 py-1 rounded text-xs font-semibold"
            style={{ background: GREEN, color: "#000" }}
          >
            {busy === "finalize" ? "Pushing live…" : "🚀 Push live (merge to master)"}
          </button>
          {showDiff && (
            <div className="mt-2 text-[10px] font-mono rounded p-2 max-h-72 overflow-y-auto" style={{ background: "#04070f", border: "1px solid var(--border)" }}>
              {diff === null && <div style={{ color: "var(--text-dim)" }}>Loading diff…</div>}
              {diff?.length === 0 && <div style={{ color: "var(--text-dim)" }}>No changes found.</div>}
              {diff?.map((f) => (
                <div key={f.filename} className="mb-3">
                  <div style={{ color: "var(--cyan)" }}>
                    {f.filename} <span style={{ color: "var(--growth)" }}>+{f.additions}</span>{" "}
                    <span style={{ color: "var(--danger)" }}>-{f.deletions}</span>
                  </div>
                  <pre className="whitespace-pre-wrap">
                    {f.patch.split("\n").map((line, i) => (
                      <div
                        key={i}
                        style={{
                          color: line.startsWith("+") ? "#6ee7a8" : line.startsWith("-") ? "#ff8aa8" : "var(--text-dim)",
                        }}
                      >
                        {line}
                      </div>
                    ))}
                  </pre>
                </div>
              ))}
            </div>
          )}
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
