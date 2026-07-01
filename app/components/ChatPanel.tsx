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
  storageKey,
  messages,
  setMessages,
}: {
  endpoint: string;
  accent: string;
  placeholder?: string;
  agentName?: string;
  voice?: boolean;
  storageKey?: string;
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
  const heardRef = useRef("");
  const sentRef = useRef(false);
  const emptyRef = useRef(0);
  const loadedRef = useRef(false);
  const speakOutRef = useRef(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  // Mirror the voice-output toggle into a ref so async reply-speech reads the
  // CURRENT value (not the one captured when send() was created).
  useEffect(() => {
    speakOutRef.current = speakOut;
  }, [speakOut]);

  // Load persisted history AFTER mount (client only) so the first render matches
  // the server's empty render — no hydration mismatch. Controlled chats (the
  // orchestrator) are handled by the parent.
  useEffect(() => {
    if (loadedRef.current || messages || !storageKey || typeof window === "undefined") return;
    loadedRef.current = true;
    try {
      const raw = localStorage.getItem(storageKey);
      const parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed) && parsed.length) setInternal(parsed);
    } catch {
      /* ignore */
    }
  }, [storageKey, messages]);

  // Persist uncontrolled chats; skip empty so we never clobber saved history.
  useEffect(() => {
    if (!storageKey || messages || typeof window === "undefined" || internal.length === 0) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(internal));
    } catch {
      /* ignore */
    }
  }, [internal, storageKey, messages]);

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

  const speakNow = (text: string, onEnd?: () => void) => {
    if (typeof window === "undefined" || !window.speechSynthesis || !text.trim()) {
      onEnd?.();
      return;
    }
    const synth = window.speechSynthesis;
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        onEnd?.();
      }
    };
    const say = (useDefaultVoice: boolean) => {
      const u = new SpeechSynthesisUtterance(text);
      if (!useDefaultVoice && voiceRef.current) {
        u.voice = voiceRef.current;
        u.lang = voiceRef.current.lang;
      } else {
        u.lang = "en-US";
      }
      u.rate = 1;
      u.pitch = 1;
      // Chrome/Edge silently pause long utterances (~15s) — nudge resume.
      const keep = setInterval(() => {
        if (!synth.speaking) clearInterval(keep);
        else synth.resume();
      }, 7000);
      u.onend = () => {
        clearInterval(keep);
        finish();
      };
      u.onerror = () => {
        clearInterval(keep);
        if (!useDefaultVoice) say(true);
        else finish();
      };
      synth.speak(u);
    };
    synth.cancel();
    say(false);
    // If nothing is AUDIBLY speaking a moment later (Edge's neural voice can get
    // stuck 'pending' and fire no error, or a cancel+speak race drops it),
    // force a retry with a guaranteed local voice.
    setTimeout(() => {
      if (!done && !synth.speaking) {
        synth.cancel();
        say(true);
      }
    }, 900);
  };

  const speak = (text: string, onEnd?: () => void) => {
    // Read from a ref so async replies use the CURRENT toggle state, not the
    // value captured when this send() was created.
    if (!speakOutRef.current && !convoRef.current) {
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
      heardRef.current = "";
      sentRef.current = false;
      rec.onstart = () => {
        setListening(true);
        setVoiceErr("");
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rec.onresult = (e: any) => {
        let txt = "";
        for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
        heardRef.current = txt;
        setInput(txt);
        const isFinal = e.results[e.results.length - 1]?.isFinal;
        if (isFinal && txt.trim()) {
          sentRef.current = true;
          emptyRef.current = 0;
          rec.stop();
          send(txt.trim());
        }
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rec.onerror = (e: any) => {
        setListening(false);
        if (e.error === "not-allowed" || e.error === "service-not-allowed") {
          setVoiceErr(
            "Microphone blocked — allow it via the 🔒 icon in the address bar, then reload. (Edge also needs Windows ▸ Settings ▸ Privacy & security ▸ Speech ▸ Online speech recognition = On.)"
          );
          convoRef.current = false;
          setConvo(false);
        } else if (e.error !== "no-speech" && e.error !== "aborted") {
          setVoiceErr("Voice input error: " + e.error);
        }
        // no-speech / aborted fall through to onend, which decides whether to retry.
      };
      rec.onend = () => {
        setListening(false);
        const heard = heardRef.current.trim();
        if (!sentRef.current && heard) {
          // Edge often never flags a result "final" — send what we heard anyway.
          sentRef.current = true;
          emptyRef.current = 0;
          send(heard);
        } else if (!sentRef.current) {
          emptyRef.current += 1;
          if (emptyRef.current >= 3) {
            emptyRef.current = 0;
            convoRef.current = false;
            setConvo(false);
            setVoiceErr(
              "Didn't catch any speech. In Edge, turn ON Windows ▸ Settings ▸ Privacy & security ▸ Speech ▸ Online speech recognition — or use Chrome for voice input."
            );
          } else if (convoRef.current) {
            setTimeout(() => {
              if (convoRef.current) startListening();
            }, 350);
          }
        }
      };
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
    speakOutRef.current = true;
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
              speakOutRef.current = next;
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
