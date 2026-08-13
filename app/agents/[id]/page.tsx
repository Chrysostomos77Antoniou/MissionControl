import Link from "next/link";
import { recentMemory } from "../../../lib/memory";
import { agentApprovalStats } from "../../../lib/suggestions";
import { recentEvals } from "../../../lib/evals";
import type { AgentId } from "../../../lib/types";

export const dynamic = "force-dynamic";

export default async function AgentDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agent = id as AgentId;
  // eslint-disable-next-line react-hooks/purity
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [memory, stats, evals] = await Promise.all([
    recentMemory(agent, 10),
    agentApprovalStats(agent, thirtyDaysAgo),
    recentEvals(agent, 10),
  ]);

  return (
    <main className="p-4 max-w-2xl mx-auto">
      <Link
        href="/"
        className="inline-block text-xs mb-3 transition hover:brightness-125"
        style={{ color: "var(--text-dim)" }}
      >
        ← Back
      </Link>
      <h1 className="font-bold uppercase mb-4">{agent} AGENT</h1>

      <div
        className="rounded-lg p-3 mb-4"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
      >
        <div className="text-xs uppercase mb-2" style={{ color: "var(--text-dim)" }}>
          Last 30 days
        </div>
        <div className="text-sm">
          {stats.rate === null
            ? "No decided suggestions yet."
            : `${Math.round(stats.rate * 100)}% approval rate (${stats.done} approved, ${stats.dismissed} dismissed)`}
        </div>
      </div>

      <div
        className="rounded-lg p-3 mb-4"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
      >
        <div className="text-xs uppercase mb-2" style={{ color: "var(--text-dim)" }}>
          Recent quality grades
        </div>
        {evals.length === 0 ? (
          <div className="text-sm" style={{ color: "var(--text-dim)" }}>
            No graded runs yet.
          </div>
        ) : (
          evals.map((e) => (
            <div key={e.id} className="text-sm mb-1">
              <span className="font-bold">{e.score}/5</span> — {e.reasoning}
            </div>
          ))
        )}
      </div>

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
