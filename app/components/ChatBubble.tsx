"use client";
import { useState } from "react";

export function ChatBubble() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [reply, setReply] = useState("");
  const send = async () => {
    setReply("");
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: input }),
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      setReply((r) => r + decoder.decode(value));
    }
  };
  return (
    <div className="fixed bottom-4 right-4">
      {open && (
        <div
          className="w-80 rounded-lg p-3 mb-2"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
        >
          <div className="text-xs mb-2 whitespace-pre-wrap min-h-16">
            {reply || "Message the orchestrator…"}
          </div>
          <div className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              className="flex-1 text-sm px-2 py-1 rounded"
              style={{ background: "var(--bg)", border: "1px solid var(--border)" }}
            />
            <button
              onClick={send}
              className="px-3 py-1 rounded text-sm"
              style={{ background: "var(--marketing)", color: "#000" }}
            >
              Send
            </button>
          </div>
        </div>
      )}
      <button
        onClick={() => setOpen(!open)}
        className="px-4 py-2 rounded-full"
        style={{ background: "var(--marketing)", color: "#000" }}
      >
        Orchestrator
      </button>
    </div>
  );
}
