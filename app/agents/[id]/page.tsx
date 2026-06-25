import { recentMemory } from "../../../lib/memory";
import type { AgentId } from "../../../lib/types";

export const dynamic = "force-dynamic";

export default async function AgentDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agent = id as AgentId;
  const memory = await recentMemory(agent, 10);
  return (
    <main className="p-4 max-w-2xl mx-auto">
      <h1 className="font-bold uppercase mb-4">{agent} AGENT</h1>
      {memory.map((m) => (
        <div
          key={m.id}
          className="rounded-lg p-3 mb-2"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
        >
          <div className="text-xs mb-1" style={{ color: "var(--text-dim)" }}>
            {m.cycle_at}
          </div>
          <div className="text-sm whitespace-pre-wrap">{m.summary}</div>
        </div>
      ))}
    </main>
  );
}
