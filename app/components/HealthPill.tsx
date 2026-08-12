"use client";
import { useEffect, useState } from "react";

interface Health {
  github: { ok: boolean; detail: string };
  supabase: { ok: boolean; detail: string };
}

export function HealthPill() {
  const [h, setH] = useState<Health | null>(null);
  useEffect(() => {
    const load = () => fetch("/api/health").then((r) => r.json()).then(setH).catch(() => {});
    load();
    // Credential checks are cheap (2 HTTP calls, no LLM spend) so a slower
    // poll than the spend meter's is plenty — this only needs to catch a
    // dead token before the owner would otherwise notice.
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, []);
  if (!h) return null;

  const broken = [!h.github.ok && "GitHub", !h.supabase.ok && "Supabase"].filter(Boolean) as string[];
  if (broken.length === 0) {
    return (
      <div
        className="glass rounded px-3 py-1 flex items-center gap-2 font-mono text-[10px]"
        style={{ border: "1px solid var(--border)" }}
        title="GitHub + Supabase Management API credentials"
      >
        <span style={{ color: "var(--text-dim)" }}>◈ CREDS</span>
        <span style={{ color: "var(--growth)" }}>OK</span>
      </div>
    );
  }

  const detail = [!h.github.ok && `GitHub: ${h.github.detail}`, !h.supabase.ok && `Supabase: ${h.supabase.detail}`]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className="glass rounded px-3 py-1 flex items-center gap-2 font-mono text-[10px]"
      style={{ border: "1px solid var(--danger)" }}
      title={detail}
    >
      <span style={{ color: "var(--text-dim)" }}>◈ CREDS</span>
      <span style={{ color: "var(--danger)" }} className="glow-text">
        ⚠ {broken.join(" + ")} broken
      </span>
    </div>
  );
}
