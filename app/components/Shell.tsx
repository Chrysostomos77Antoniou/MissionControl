"use client";
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { TopMenu } from "./TopMenu";
import { RoomsDashboard } from "./RoomsDashboard";
import { SuggestionsFeed } from "./SuggestionsFeed";
import { LiveFeed } from "./LiveFeed";

export type View = "dashboard" | "inbox" | "logs";

const variants = {
  enter: (dir: number) => ({ x: dir > 0 ? "100%" : "-100%", opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir > 0 ? "-100%" : "100%", opacity: 0 }),
};

export function Shell() {
  const [view, setView] = useState<View>("dashboard");
  const [dir, setDir] = useState(1);

  const go = (v: View) => {
    setDir(v === "dashboard" ? -1 : 1);
    setView(v);
  };

  return (
    <main className="p-4 above">
      <TopMenu view={view} onNavigate={go} />
      <div className="relative overflow-hidden" style={{ minHeight: "78vh" }}>
        <AnimatePresence custom={dir} mode="popLayout" initial={false}>
          <motion.div
            key={view}
            custom={dir}
            variants={variants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ type: "tween", ease: [0.4, 0, 0.2, 1], duration: 0.45 }}
            className="w-full"
          >
            {view === "dashboard" && <RoomsDashboard />}
            {view === "inbox" && (
              <Panel title="SUGGESTIONS INBOX" onBack={() => go("dashboard")}>
                <SuggestionsFeed />
              </Panel>
            )}
            {view === "logs" && (
              <Panel title="SYSTEM LOGS" onBack={() => go("dashboard")}>
                <LiveFeed />
              </Panel>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </main>
  );
}

function Panel({ title, onBack, children }: { title: string; onBack: () => void; children: React.ReactNode }) {
  return (
    <div className="glass bracket rounded-xl p-5 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-display text-sm font-bold glow-text" style={{ color: "var(--cyan)" }}>
          {title}
        </h2>
        <button
          onClick={onBack}
          className="font-display text-[11px] px-3 py-1 rounded glow-text"
          style={{ color: "var(--cyan)", border: "1px solid var(--border)" }}
        >
          ◄ BACK TO DECK
        </button>
      </div>
      {children}
    </div>
  );
}
