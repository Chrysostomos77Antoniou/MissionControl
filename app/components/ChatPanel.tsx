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
  messages?: Msg[];
  setMessages?: Dispatch<SetStateAction<Msg[]>>;
}) {
  const [internal, setInternal] = useState<Msg[]>([]);
  const msgs = messages ?? internal;
  const setMsgs = setMessages ?? setInternal;
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [convo, setConvo] = useState(false); // hands-free conversation mode
  const [speakOut, setSpeakOut] = useState(false);
  const [voiceErr, setVoiceErr] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recRef = useRef<any>(null);
  const convoRef = useRef(false);
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  // Pick the most natural-sounding voice (Edge neural voices sound human).
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
        if (/natural|neural/.test(n)) s += 12;
        if (/google/.test(n)) s += 6;
        if (/aria|jenny|guy|libby|sonia|ryan|emma/.test(n)) s += 3;
        if (/zira|david|mark|hazel/.test(n)) s -= 2;
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

  const buildUtterance = (text: string) => {
    const u = new SpeechSynthesisUtterance(text);
    if (voiceRef.current) {
      u.voice = voiceRef.current;
      u.lang = voiceRef.current.lang;
    } else {
      u.lang = "en-US";
    }
    u.rate = 1.0;
    u.pitch = 1.0;
    return u;
  };

  const speakNow = (text: string, onEnd?: () => void) => {
    if (typeof window === "undefined" || !window.speechSynthesis) {
      onEnd?.();
      return;
    }
    const synth = window.speechSynthesis;
    synth.cancel();
    const u = buildUtterance(text);
    const keep = setInterval(() => {
      if (!synth.speaking) {
        clearInterval(keep);
        return;
      }
      synth.resume();
    }, 8000);
    u.onend = () => {
      clearInterval(keep);
      onEnd?.();
    };
    u.onerror = () => {
      clearInterval(keep);
      onEnd?.();
    };
    synth.speak(u);
  };

  const speak = (text: string, onEnd?: () => void) => {
    if (!speakOut && !convoRef.current) {
      onEnd?.();
      return;
    }
    speakNow(text, onEnd);
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
      // Speak the reply; in conversation mode, listen again once it finishes.
      speak(acc, () => {
        if (convoRef.current) startListening();
      });
    } catch {
      setLast("⚠ Could not reach the agent. Check that the app and Anthropic credits are available.");
    } finally {
      setBusy(false);
    }
  };

  const startListening = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setVoiceErr("Voice input needs Chrome or Edge.");
      return;
    }
    try {
      const rec = new SR();
      rec.lang = "en-US";
      rec.interimResults = true;
      rec.continuous = false;
      rec.onstart = () => {
        setListening(true);
        setVoiceErr("");
      };
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
        if (final.trim()) {
          rec.stop();
          send(final.trim());
        }
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rec.onerror = (e: any) => {
        setListening(false);
        if (e.error === "not-allowed" || e.error === "service-not-allowed") {
          setVoiceErr("Microphone blocked — click the 🔒/mic icon in the address bar, allow the microphone, then try again.");
          convoRef.current = false;
          setConvo(false);
        } else if (e.error === "no-speech") {
          if (convoRef.current) startListening(); // keep waiting for speech
        } else if (e.error !== "aborted") {
          setVoiceErr("Voice error: " + e.error);
        }
      };
      rec.onend = () => setListening(false);
      recRef.current = rec;
      rec.start();
    } catch {
      setVoiceErr("Could not start the microphone (already running?). Try again.");
    }
  };

  const stopConvo = () => {
    convoRef.current = false;
    setConvo(false);
    setListening(false);
    try {
      recRef.current?.abort?.();
    } catch {
      /* ignore */
    }
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
  };

  const toggleConvo = () => {
    if (convo) {
      stopConvo();
      return;
    }
    setVoiceErr("");
    setConvo(true);
    convoRef.current = true;
    setSpeakOut(true);
    // Greeting primes the audio inside the click gesture, then we start listening.
    speakNow("I'm listening.", () => {
      if (convoRef.current) startListening();
    });
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

      {voice && (voiceErr || convo) && (
        <div className="text-[11px] mb-2 px-1" style={{ color: voiceErr ? "#ff6b6b" : accent }}>
          {voiceErr || (listening ? "🎙️ Listening — speak now…" : busy ? "Thinking…" : "🔊 Speaking…")}
        </div>
      )}

      <div className="flex gap-2 items-center">
        {voice && (
          <button
            onClick={toggleConvo}
            title={convo ? "Stop voice conversation" : "Start voice conversation (hands-free)"}
            className={btn}
            style={{
              border: "1px solid var(--border)",
              background: convo ? "#e0392b" : "color-mix(in srgb, var(--text) 6%, transparent)",
              color: convo ? "#fff" : "var(--text)",
              animation: listening ? "pulse 1.3s infinite" : "none",
            }}
          >
            {convo ? "⏹" : "🎤"}
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
            onClick={() => {
              const next = !speakOut;
              setSpeakOut(next);
              if (typeof window === "undefined" || !window.speechSynthesis) return;
              if (next) {
                const last = [...msgs].reverse().find((m) => m.role === "agent" && m.text.trim());
                speakNow(last ? last.text : "Voice on.");
              } else {
                window.speechSynthesis.cancel();
              }
            }}
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
