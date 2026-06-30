"use client";
import { useState } from "react";
import { motion } from "framer-motion";
import { TopMenu } from "./TopMenu";
import { RoomsDashboard } from "./RoomsDashboard";
import { SuggestionsFeed } from "./SuggestionsFeed";
import { LiveFeed } from "./LiveFeed";

export type View = "dashboard" | "inbox" | "logs";

const ORDER: View[] = ["dashboard", "inbox", "logs"];

export function Shell() {
  const [view, setView] = useState<View>("dashboard");
  const go = (v: View) => setView(v);
  const index = ORDER.indexOf(view);

  return (
    <main className="p-4 above">
      <TopMenu view={view} onNavigate={go} />
      {/* Every view stays MOUNTED and the track slides horizontally, so a typed
          orchestrator prompt or an in-flight agent task is never lost when you
          switch tabs. We animate `left` (not a transform) so the agent modal's
          `position: fixed` keeps working. */}
      <div className="relative overflow-hidden" style={{ minHeight: "78vh" }}>
        <motion.div
          className="flex items-start"
          style={{ position: "relative", width: "300%" }}
          animate={{ left: `-${index * 100}%` }}
          initial={false}
          transition={{ type: "tween", ease: [0.4, 0, 0.2, 1], duration: 0.45 }}
        >
          <div className="shrink-0" style={{ width: "33.3333%" }}>
            <RoomsDashboard />
          </div>
          <div className="shrink-0" style={{ width: "33.3333%" }}>
            <Panel title="Suggestions Inbox" onBack={() => go("dashboard")}>
              <SuggestionsFeed />
            </Panel>
          </div>
          <div className="shrink-0" style={{ width: "33.3333%" }}>
            <Panel title="System Logs" onBack={() => go("dashboard")}>
              <LiveFeed />
            </Panel>
          </div>
        </motion.div>
      </div>
    </main>
  );
}

function Panel({ title, onBack, children }: { title: string; onBack: () => void; children: React.ReactNode }) {
  return (
    <div className="glass rounded-xl p-5 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-display text-sm" style={{ color: "var(--text)" }}>
          {title}
        </h2>
        <button
          onClick={onBack}
          className="text-[12px] px-3 py-1 rounded"
          style={{ color: "var(--text-dim)", border: "1px solid var(--border)" }}
        >
          ← Back to dashboard
        </button>
      </div>
      {children}
    </div>
  );
}
