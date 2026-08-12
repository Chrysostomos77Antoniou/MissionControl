"use client";
import { useEffect, useState } from "react";
import { AGENT_BY_ID } from "../../agents/registry";
import { apiGet } from "../../lib/api";
import type { ActivityEntry } from "../../lib/types";

const ERROR = /error|skipped|down|gave-up|needs-owner/i;
const SUCCESS = /passed|fixed|^live$|approval/i;

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function severityColor(action: string): string | null {
  if (ERROR.test(action)) return "var(--danger)";
  if (SUCCESS.test(action)) return "var(--growth)";
  return null;
}

export function LiveFeed() {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  useEffect(() => {
    const load = () =>
      apiGet<ActivityEntry[]>("/api/feed").then((d) => {
        if (d) setEntries(d);
      });
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="font-mono text-[11px] space-y-1">
      {entries.map((e) => {
        const color = severityColor(e.action);
        return (
          <div key={e.id} className="flex items-baseline gap-1.5">
            <span className="shrink-0" style={{ color: "var(--text-dim)" }}>
              {relativeTime(e.created_at)}
            </span>
            <span style={{ color: AGENT_BY_ID[e.agent]?.accent ?? "var(--text-dim)" }}>[{e.agent}]</span>{" "}
            <span style={color ? { color } : undefined}>
              {e.action} {e.detail ? `— ${e.detail.slice(0, 80)}` : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}
