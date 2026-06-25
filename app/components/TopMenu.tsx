import { QARunButton } from "./QARunButton";
import { LogoutButton } from "./LogoutButton";
import { InstallButton } from "./InstallButton";

export function TopMenu() {
  return (
    <header className="flex justify-between items-center mb-4">
      <div className="flex items-center gap-5">
        <h1 className="font-bold tracking-wide">FOOTRANK MISSION CONTROL</h1>
        <nav className="flex gap-4 text-xs">
          <a href="/suggestions" target="_blank" rel="noreferrer" className="hover:underline" style={{ color: "var(--text-dim)" }}>
            Inbox ↗
          </a>
          <a href="/logs" target="_blank" rel="noreferrer" className="hover:underline" style={{ color: "var(--text-dim)" }}>
            Logs ↗
          </a>
        </nav>
      </div>
      <div className="flex items-center gap-4">
        <InstallButton />
        <QARunButton />
        <span className="text-xs" style={{ color: "var(--growth)" }}>● OPERATIONAL</span>
        <LogoutButton />
      </div>
    </header>
  );
}
