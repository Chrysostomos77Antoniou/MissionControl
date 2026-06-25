"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setBusy(false);
    if (res.ok) {
      router.push("/");
      router.refresh();
    } else {
      setError("ACCESS DENIED");
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center p-4 above">
      <form onSubmit={submit} className="glass bracket w-96 rounded-xl p-8">
        <div className="flex items-center gap-2 mb-1">
          <span
            className="w-3 h-3 rounded-full"
            style={{ background: "var(--cyan)", boxShadow: "0 0 12px var(--cyan)", animation: "pulse 2s infinite" }}
          />
          <h1 className="font-display font-black tracking-[0.2em] text-sm glow-text" style={{ color: "var(--cyan)" }}>
            MISSION CONTROL
          </h1>
        </div>
        <p className="font-mono text-[10px] mb-6" style={{ color: "var(--text-dim)" }}>
          // OWNER AUTHENTICATION REQUIRED
        </p>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="ACCESS KEY"
          className="w-full font-mono text-sm px-3 py-2 rounded mb-4 tracking-widest"
          style={{ background: "rgba(0,0,0,0.4)", border: "1px solid var(--border)", color: "var(--cyan)" }}
        />
        <button
          type="submit"
          disabled={busy}
          className="w-full font-display tracking-widest text-xs px-3 py-2 rounded font-bold"
          style={{ background: "var(--cyan)", color: "#04070f", boxShadow: "0 0 18px var(--cyan)" }}
        >
          {busy ? "AUTHENTICATING…" : "▶ ENGAGE"}
        </button>
        {error && (
          <div className="font-mono text-xs mt-4 glow-text" style={{ color: "var(--danger)" }}>
            ✕ {error}
          </div>
        )}
      </form>
    </main>
  );
}
