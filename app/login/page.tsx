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
      setError("Incorrect password");
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center p-4 above">
      <form onSubmit={submit} className="glass w-96 rounded-xl p-8">
        <h1 className="font-display text-base mb-1" style={{ color: "var(--text)" }}>
          FootRank Mission Control
        </h1>
        <p className="text-xs mb-6" style={{ color: "var(--text-dim)" }}>
          Sign in to continue
        </p>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full text-sm px-3 py-2 rounded mb-4"
          style={{ background: "rgba(0,0,0,0.3)", border: "1px solid var(--border)", color: "var(--text)" }}
        />
        <button
          type="submit"
          disabled={busy}
          className="w-full text-sm px-3 py-2 rounded font-medium"
          style={{ background: "var(--cyan)", color: "#0a0c11" }}
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {error && (
          <div className="text-xs mt-4" style={{ color: "var(--danger)" }}>
            {error}
          </div>
        )}
      </form>
    </main>
  );
}
