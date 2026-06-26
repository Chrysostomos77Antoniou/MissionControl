"use client";
import { QARunButton } from "./QARunButton";
import { LogoutButton } from "./LogoutButton";
import { InstallButton } from "./InstallButton";
import { SpendMeter } from "./SpendMeter";
import type { View } from "./Shell";

export function TopMenu({ view, onNavigate }: { view: View; onNavigate: (v: View) => void }) {
  const NavBtn = ({ to, label }: { to: View; label: string }) => (
    <button
      onClick={() => onNavigate(to)}
      className="font-display text-[11px] px-3 py-1 rounded transition"
      style={{
        color: view === to ? "#04070f" : "var(--cyan)",
        background: view === to ? "var(--cyan)" : "transparent",
        border: "1px solid var(--border)",
        boxShadow: view === to ? "0 0 14px var(--cyan)" : "none",
      }}
    >
      {label}
    </button>
  );

  return (
    <header className="flex justify-between items-center mb-5 above">
      <div className="flex items-center gap-5">
        <div className="flex items-center gap-2">
          <span
            className="w-3 h-3 rounded-full"
            style={{ background: "var(--growth)", boxShadow: "0 0 12px var(--growth)", animation: "pulse 2s infinite" }}
          />
          <h1 className="font-display font-black tracking-[0.2em] text-sm glow-text" style={{ color: "var(--cyan)" }}>
            FOOTRANK · MISSION CONTROL
          </h1>
        </div>
        <nav className="flex gap-2">
          <NavBtn to="dashboard" label="DECK" />
          <NavBtn to="inbox" label="INBOX" />
          <NavBtn to="logs" label="LOGS" />
        </nav>
      </div>
      <div className="flex items-center gap-3">
        <SpendMeter />
        <InstallButton />
        <QARunButton />
        <LogoutButton />
      </div>
    </header>
  );
}
