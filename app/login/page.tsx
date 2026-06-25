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
      setError("Wrong password.");
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <form
        onSubmit={submit}
        className="w-80 rounded-lg p-6"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
      >
        <h1 className="font-bold tracking-wide mb-1">FOOTRANK MISSION CONTROL</h1>
        <p className="text-xs mb-4" style={{ color: "var(--text-dim)" }}>
          Owner access
        </p>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full text-sm px-3 py-2 rounded mb-3"
          style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }}
        />
        <button
          type="submit"
          disabled={busy}
          className="w-full px-3 py-2 rounded text-sm font-semibold"
          style={{ background: "#3b82f6", color: "#fff" }}
        >
          {busy ? "…" : "Sign in"}
        </button>
        {error && (
          <div className="text-xs mt-3" style={{ color: "#e5484d" }}>
            {error}
          </div>
        )}
      </form>
    </main>
  );
}
