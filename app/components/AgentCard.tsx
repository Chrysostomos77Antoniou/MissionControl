"use client";
import Link from "next/link";
import type { AgentSpec } from "../../agents/registry";

const CADENCE_LABEL: Record<string, string> = {
  hourly: "every hour",
  "4h": "every 4h",
  daily: "daily",
  "5day": "every 5 days",
  ondemand: "on demand",
};

export function AgentCard({ spec, lastRun }: { spec: AgentSpec; lastRun: string }) {
  return (
    <Link href={`/agents/${spec.id}`} className="block">
      <div
        style={{ borderLeft: `3px solid ${spec.accent}`, background: "var(--surface)", border: "1px solid var(--border)" }}
        className="rounded-lg p-3 mb-2 hover:brightness-125 transition"
      >
        <div className="flex justify-between items-center">
          <span className="font-semibold text-sm" style={{ color: spec.accent }}>
            {spec.name}
          </span>
          <span className="text-[10px] uppercase" style={{ color: "var(--text-dim)" }}>
            {CADENCE_LABEL[spec.cadence]}
          </span>
        </div>
        <div className="text-[10px] mt-1" style={{ color: "var(--text-dim)" }}>
          last run: {lastRun}
        </div>
      </div>
    </Link>
  );
}
