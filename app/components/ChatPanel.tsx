"use client";
import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

type Msg = { role: "you" | "agent"; text: string };

export function ChatPanel({
  endpoint,
  accent,
  placeholder,
  agentName = "Agent",
  messages,
  setMessages,
}: {
  endpoint: string;
  accent: string;
  placeholder?: string;
  agentName?: string;
  // Optional controlled state, so the same conversation can be shared between
  // the inline panel and an expanded window.
  messages?: Msg[];
  setMessages?: Dispatch<SetStateAction<Msg[]>>;
}) {
  const [internal, setInternal] = useState<Msg[]>([]);
  const msgs = messages ?? internal;
  const setMsgs = setMessages ?? setInternal;
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the newest message in view (including while the answer streams in).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  const send = async () => {
    if (!input.trim() || busy) return;
    const q = input;
    setInput("");
    setBusy(true);
    setMsgs((m) => [...m, { role: "you", text: q }, { role: "agent", text: "" }]);
    const setLast = (text: string) =>
      setMsgs((m) => {
        const c = [...m];
        c[c.length - 1] = { role: "agent", text };
        return c;
      });
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: q }),
      });
      if (!res.ok || !res.body) throw new Error(`server ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let acc = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += dec.decode(value);
        setLast(acc);
      }
    } catch {
      setLast("⚠ Could not reach the agent. Check that the app and Anthropic credits are available.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto space-y-3 mb-3 min-h-0 pr-1"
      >
        {msgs.length === 0 && (
          <div className="text-sm leading-relaxed" style={{ color: "var(--text-dim)" }}>
            {placeholder ?? "Ask a question…"}
          </div>
        )}
        {msgs.map((m, i) =>
          m.role === "you" ? (
            <div key={i} className="flex justify-end">
              <div
                className="text-sm rounded-2xl rounded-br-sm px-3 py-2 max-w-[85%] whitespace-pre-wrap leading-relaxed"
                style={{
                  background: "color-mix(in srgb, var(--text) 8%, transparent)",
                  color: "var(--text)",
                }}
              >
                {m.text}
              </div>
            </div>
          ) : (
            <div key={i} className="flex flex-col gap-1">
              <span
                className="text-[10px] font-bold uppercase tracking-wider"
                style={{ color: accent }}
              >
                {agentName}
              </span>
              <div
                className="text-sm leading-relaxed whitespace-pre-wrap rounded-2xl rounded-bl-sm px-3 py-2"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  color: "var(--text)",
                }}
              >
                {m.text || "…"}
              </div>
            </div>
          )
        )}
      </div>
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          className="flex-1 text-sm px-3 py-2 rounded-lg"
          style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }}
          placeholder="Type a message…"
        />
        <button
          onClick={send}
          disabled={busy}
          className="px-4 py-2 rounded-lg text-sm font-semibold"
          style={{ background: accent, color: "#000" }}
        >
          {busy ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}
