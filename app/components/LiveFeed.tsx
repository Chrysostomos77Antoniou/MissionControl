"use client";
import { useEffect, useState } from "react";
import { AGENT_BY_ID } from "../../agents/registry";
import type { ActivityEntry } from "../../lib/types";

export function LiveFeed() {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  useEffect(() => {
    const load = () => fetch("/api/feed").then((r) => r.json()).then(setEntries);
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="font-mono text-[11px] space-y-1">
      {entries.map((e) => (
        <div key={e.id}>
          <span style={{ color: AGENT_BY_ID[e.agent]?.accent ?? "var(--text-dim)" }}>
            [{e.agent}]
          </span>{" "}
          {e.action} {e.detail ? `— ${e.detail.slice(0, 80)}` : ""}
        </div>
      ))}
    </div>
  );
}
