"use client";
import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

type Msg = { role: "you" | "agent"; text: string };

export function ChatPanel({
  endpoint,
  accent,
  placeholder,
  agentName = "Agent",
  voice = false,
  messages,
  setMessages,
}: {
  endpoint: string;
  accent: string;
  placeholder?: string;
  agentName?: string;
  voice?: boolean;
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
  const [listening, setListening] = useState(false);
  const [speakOut, setSpeakOut] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recRef = useRef<any>(null);
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);

  // Keep the newest message in view (including while the answer streams in).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  // Pick the most natural-sounding voice the browser offers (Edge ships neural
  // "Natural" voices that sound human; Chrome has Google's voices).
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const pick = () => {
      const voices = window.speechSynthesis.getVoices();
      if (!voices.length) return;
      const score = (v: SpeechSynthesisVoice) => {
        const n = v.name.toLowerCase();
        let s = 0;
        if (v.lang.startsWith("en")) s += 5;
        if (v.lang === "en-US" || v.lang === "en-GB") s += 2;
        if (/natural|neural/.test(n)) s += 12; // Edge neural — most human
        if (/google/.test(n)) s += 6; // Chrome's voices
        if (/aria|jenny|guy|libby|sonia|ryan|emma/.test(n)) s += 3; // known-good MS voices
        if (/zira|david|mark|hazel/.test(n)) s -= 2; // older, robotic MS voices
        return s;
      };
      voiceRef.current = [...voices].sort((a, b) => score(b) - score(a))[0] ?? null;
    };
    pick();
    window.speechSynthesis.onvoiceschanged = pick;
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  const speak = (text: string) => {
    if (!speakOut || typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (voiceRef.current) {
      u.voice = voiceRef.current;
      u.lang = voiceRef.current.lang;
    } else {
      u.lang = "en-US";
    }
    u.rate = 1.0;
    u.pitch = 1.0;
    window.speechSynthesis.speak(u);
  };

  const send = async (override?: string) => {
    const q = (override ?? input).trim();
    if (!q || busy) return;
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
      speak(acc);
    } catch {
      setLast("⚠ Could not reach the agent. Check that the app and Anthropic credits are available.");
    } finally {
      setBusy(false);
    }
  };

  const toggleListen = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      alert("Voice input needs Chrome or Edge.");
      return;
    }
    if (listening) {
      recRef.current?.stop();
      setListening(false);
      return;
    }
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (e: any) => {
      let interim = "";
      let final = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      setInput(final || interim);
      if (final) {
        setListening(false);
        rec.stop();
        send(final); // hands-free: speak → auto-send
      }
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    rec.start();
  };

  const btn = "shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-base transition";

  return (
    <div className="flex flex-col h-full">
      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-3 mb-3 min-h-0 pr-1">
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
                style={{ background: "color-mix(in srgb, var(--text) 8%, transparent)", color: "var(--text)" }}
              >
                {m.text}
              </div>
            </div>
          ) : (
            <div key={i} className="flex flex-col gap-1">
              <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: accent }}>
                {agentName}
              </span>
              <div
                className="text-sm leading-relaxed whitespace-pre-wrap rounded-2xl rounded-bl-sm px-3 py-2"
                style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}
              >
                {m.text || "…"}
              </div>
            </div>
          )
        )}
      </div>
      <div className="flex gap-2 items-center">
        {voice && (
          <button
            onClick={toggleListen}
            title={listening ? "Stop listening" : "Speak"}
            className={btn}
            style={{
              border: "1px solid var(--border)",
              background: listening ? "#e0392b" : "color-mix(in srgb, var(--text) 6%, transparent)",
              color: listening ? "#fff" : "var(--text)",
              animation: listening ? "pulse 1.3s infinite" : "none",
            }}
          >
            🎤
          </button>
        )}
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          className="flex-1 text-sm px-3 py-2 rounded-lg"
          style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }}
          placeholder={listening ? "Listening…" : "Type a message…"}
        />
        {voice && (
          <button
            onClick={() =>
              setSpeakOut((s) => {
                const n = !s;
                if (!n && typeof window !== "undefined") window.speechSynthesis?.cancel();
                return n;
              })
            }
            title={speakOut ? "Voice replies on" : "Voice replies off"}
            className={btn}
            style={{
              border: "1px solid var(--border)",
              background: speakOut ? "color-mix(in srgb, var(--cyan) 18%, transparent)" : "transparent",
              color: "var(--text)",
            }}
          >
            {speakOut ? "🔊" : "🔇"}
          </button>
        )}
        <button
          onClick={() => send()}
          disabled={busy}
          className="px-4 py-2 rounded-lg text-sm font-semibold shrink-0"
          style={{ background: accent, color: "#000" }}
        >
          {busy ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}
