"use client";
import { useEffect, useState } from "react";
import type { ActivityEntry, AgentId } from "../../lib/types";

const ACCENT: Record<AgentId, string> = {
  marketing: "var(--marketing)",
  growth: "var(--growth)",
  content: "var(--content)",
};

export function LiveFeed() {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  useEffect(() => {
    const load = () => fetch("/api/feed").then((r) => r.json()).then(setEntries);
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="font-mono text-xs space-y-1">
      {entries.map((e) => (
        <div key={e.id}>
          <span style={{ color: ACCENT[e.agent] }}>[{e.agent}]</span> {e.action}{" "}
          {e.detail ? `— ${e.detail}` : ""}
        </div>
      ))}
    </div>
  );
}
