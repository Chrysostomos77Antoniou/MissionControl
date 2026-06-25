"use client";
import type { Approval } from "../../lib/types";

const COLUMNS = ["RESEARCHING", "DRAFTING", "QUEUED", "APPROVED", "PUBLISHED", "DONE"];

export function KanbanBoard({ approvals }: { approvals: Approval[] }) {
  const byCol: Record<string, Approval[]> = {
    QUEUED: approvals.filter((a) => a.status === "pending"),
    APPROVED: approvals.filter((a) => a.status === "approved"),
  };
  return (
    <div className="grid grid-cols-6 gap-2">
      {COLUMNS.map((col) => (
        <div
          key={col}
          className="rounded-lg p-2"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
        >
          <div className="text-xs font-semibold mb-2" style={{ color: "var(--text-dim)" }}>
            {col}
          </div>
          {(byCol[col] ?? []).map((a) => (
            <div key={a.id} className="text-xs rounded p-2 mb-1" style={{ background: "var(--bg)" }}>
              {a.preview.slice(0, 80)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
