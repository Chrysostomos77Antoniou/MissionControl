"use client";
import { useState } from "react";
import type { Approval } from "../../lib/types";

export function ApprovalCard({ approval, onResolve }: { approval: Approval; onResolve: () => void }) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const resolve = async (status: "approved" | "rejected") => {
    const res = await fetch(`/api/approvals/${approval.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, reason: status === "rejected" ? reason : undefined }),
    });
    const data = (await res.json()) as { execution?: { ok: boolean; detail: string } | null };
    if (data.execution && !data.execution.ok) {
      setNote(`⚠ ${data.execution.detail}`);
      return; // keep the card visible so the failure detail is readable
    }
    onResolve();
  };
  return (
    <div
      className="rounded-lg p-4 mb-3"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
    >
      <div className="text-xs uppercase mb-1" style={{ color: "var(--text-dim)" }}>
        {approval.agent} · {approval.action_type}
      </div>
      <div className="text-sm mb-3 whitespace-pre-wrap">{approval.preview}</div>
      <div className="flex gap-2 items-center">
        <button
          onClick={() => resolve("approved")}
          className="px-3 py-1 rounded text-sm"
          style={{ background: "var(--growth)", color: "#000" }}
        >
          Approve
        </button>
        <button
          onClick={() => resolve("rejected")}
          className="px-3 py-1 rounded text-sm"
          style={{ background: "#ff4444", color: "#fff" }}
        >
          Reject
        </button>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="reason"
          className="text-xs px-2 py-1 rounded flex-1"
          style={{ background: "var(--bg)", border: "1px solid var(--border)" }}
        />
      </div>
      {note && (
        <div className="text-xs mt-2" style={{ color: "var(--content)" }}>
          {note}
        </div>
      )}
    </div>
  );
}
