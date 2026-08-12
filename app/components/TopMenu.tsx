"use client";
import { QARunButton } from "./QARunButton";
import { LogoutButton } from "./LogoutButton";
import { InstallButton } from "./InstallButton";
import { SpendMeter } from "./SpendMeter";
import { HealthPill } from "./HealthPill";
import type { View } from "./Shell";

export function TopMenu({ view, onNavigate }: { view: View; onNavigate: (v: View) => void }) {
  const NavBtn = ({ to, label }: { to: View; label: string }) => (
    <button
      onClick={() => onNavigate(to)}
      className="font-display text-[11px] px-3 py-1 rounded transition"
      style={{
        color: view === to ? "#04070f" : "var(--amber)",
        background: view === to ? "var(--amber)" : "transparent",
        border: "1px solid var(--border)",
        boxShadow: view === to ? "0 0 14px var(--amber)" : "none",
      }}
    >
      {label}
    </button>
  );

  return (
    <header className="flex justify-between items-center mb-5 above">
      <div className="flex items-center gap-5">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: "var(--growth)" }} />
          <h1 className="font-display text-sm" style={{ color: "var(--text)" }}>
            FootRank Mission Control
          </h1>
        </div>
        <nav className="flex gap-1">
          <NavBtn to="dashboard" label="Dashboard" />
          <NavBtn to="inbox" label="Inbox" />
          <NavBtn to="logs" label="Logs" />
        </nav>
      </div>
      <div className="flex items-center gap-3">
        <HealthPill />
        <SpendMeter />
        <InstallButton />
        <QARunButton />
        <LogoutButton />
      </div>
    </header>
  );
}
