"use client";
import { useState } from "react";

export function QARunButton() {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const run = async () => {
    setBusy(true);
    setDone(false);
    await fetch("/api/qa", { method: "POST" });
    setBusy(false);
    setDone(true);
  };
  return (
    <button
      onClick={run}
      disabled={busy}
      className="px-3 py-1 rounded text-xs"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", color: busy ? "var(--text-dim)" : "#00ff88" }}
    >
      {busy ? "Running QA…" : done ? "QA done ✓ (check suggestions)" : "▶ Run QA (after a feature ships)"}
    </button>
  );
}
