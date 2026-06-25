"use client";
import { useEffect, useState } from "react";
import { ApprovalCard } from "../components/ApprovalCard";
import type { Approval } from "../../lib/types";

export default function ApprovalsPage() {
  const [items, setItems] = useState<Approval[]>([]);
  const load = () => fetch("/api/approvals").then((r) => r.json()).then(setItems);
  useEffect(() => {
    load();
  }, []);
  return (
    <main className="p-4 max-w-2xl mx-auto">
      <h1 className="font-bold mb-4">APPROVALS QUEUE</h1>
      {items.length === 0 && <p style={{ color: "var(--text-dim)" }}>Nothing pending.</p>}
      {items.map((a) => (
        <ApprovalCard key={a.id} approval={a} onResolve={load} />
      ))}
    </main>
  );
}
