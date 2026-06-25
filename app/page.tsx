import { listPending } from "../lib/approvals";
import { recentMemory } from "../lib/memory";
import { AgentCard } from "./components/AgentCard";
import { KanbanBoard } from "./components/KanbanBoard";
import { LiveFeed } from "./components/LiveFeed";
import { ChatBubble } from "./components/ChatBubble";
import type { AgentId } from "../lib/types";

export const dynamic = "force-dynamic";

export default async function Home() {
  const approvals = await listPending();
  const agents: AgentId[] = ["marketing", "growth", "content"];
  const lastRuns = await Promise.all(
    agents.map(async (a) => (await recentMemory(a, 1))[0]?.cycle_at ?? "never"),
  );

  return (
    <main className="p-4">
      <header className="flex justify-between items-center mb-4">
        <h1 className="font-bold tracking-wide">FOOTRANK MISSION CONTROL</h1>
        <span className="text-xs" style={{ color: "var(--growth)" }}>
          ● SYSTEMS OPERATIONAL
        </span>
      </header>
      <div className="grid grid-cols-[240px_1fr_320px] gap-4">
        <aside>
          {agents.map((a, i) => (
            <AgentCard key={a} agent={a} status="IDLE" lastRun={lastRuns[i]} tasksToday={0} />
          ))}
        </aside>
        <section>
          <KanbanBoard approvals={approvals} />
        </section>
        <aside>
          <div className="text-xs font-semibold mb-2" style={{ color: "var(--text-dim)" }}>
            LIVE FEED
          </div>
          <LiveFeed />
        </aside>
      </div>
      <ChatBubble />
    </main>
  );
}
