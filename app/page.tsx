import { AGENTS } from "../agents/registry";
import { recentMemory } from "../lib/memory";
import { AgentCard } from "./components/AgentCard";
import { SuggestionsFeed } from "./components/SuggestionsFeed";
import { LiveFeed } from "./components/LiveFeed";
import { ChatBubble } from "./components/ChatBubble";
import { QARunButton } from "./components/QARunButton";
import { LogoutButton } from "./components/LogoutButton";

export const dynamic = "force-dynamic";

export default async function Home() {
  const lastRuns = Object.fromEntries(
    await Promise.all(
      AGENTS.map(async (a) => [a.id, (await recentMemory(a.id, 1))[0]?.cycle_at ?? "never"] as const),
    ),
  );

  return (
    <main className="p-4">
      <header className="flex justify-between items-center mb-4">
        <h1 className="font-bold tracking-wide">FOOTRANK MISSION CONTROL</h1>
        <div className="flex items-center gap-4">
          <QARunButton />
          <span className="text-xs" style={{ color: "var(--growth)" }}>● SYSTEMS OPERATIONAL</span>
          <LogoutButton />
        </div>
      </header>
      <div className="grid grid-cols-[240px_1fr_320px] gap-4">
        <aside className="max-h-[85vh] overflow-y-auto pr-1">
          <div className="text-[10px] font-semibold mb-2" style={{ color: "var(--text-dim)" }}>
            AGENTS ({AGENTS.length})
          </div>
          {AGENTS.map((a) => (
            <AgentCard key={a.id} spec={a} lastRun={lastRuns[a.id]} />
          ))}
        </aside>
        <section className="max-h-[85vh] overflow-y-auto pr-1">
          <div className="text-[10px] font-semibold mb-2" style={{ color: "var(--text-dim)" }}>
            SUGGESTIONS INBOX
          </div>
          <SuggestionsFeed />
        </section>
        <aside>
          <div className="text-[10px] font-semibold mb-2" style={{ color: "var(--text-dim)" }}>
            LIVE FEED
          </div>
          <LiveFeed />
        </aside>
      </div>
      <ChatBubble />
    </main>
  );
}
