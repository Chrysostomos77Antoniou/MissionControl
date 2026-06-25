"use client";
import { useState } from "react";

export function InstallButton() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const install = async () => {
    setBusy(true);
    setNote("");
    const r = await fetch("/api/install-app", { method: "POST" });
    const d = (await r.json()) as { ok: boolean; detail: string };
    setBusy(false);
    setNote(d.ok ? "✓ Installed on phone" : `⚠ ${(d.detail || "failed").slice(-200)}`);
  };
  return (
    <div className="relative">
      <button
        onClick={install}
        disabled={busy}
        className="px-3 py-1 rounded text-xs font-semibold"
        style={{ background: "var(--content)", color: "#000" }}
      >
        {busy ? "Installing…" : "📱 Install on phone"}
      </button>
      {note && (
        <div
          className="absolute right-0 top-8 text-[10px] w-72 whitespace-pre-wrap p-2 rounded z-50"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}
        >
          {note}
        </div>
      )}
    </div>
  );
}
