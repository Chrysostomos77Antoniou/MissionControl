"use client";
import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

type Msg = { role: "you" | "agent"; text: string };

// Agent replies may still slip in markdown or dash-joined clauses despite the
// system prompt telling them not to — clean it up defensively so the chat
// bubble never shows literal "**"/"—" and the TTS voice never reads stray
// punctuation out as words or pauses awkwardly on a dash.
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/\s+[-–—]{1,2}\s+/g, ", ")
    .replace(/,\s*,/g, ",")
    .trim();
}

function normalizedWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean);
}

// Barge-in listens through the speaker's own output, so on a setup without
// headphones the mic can pick up the assistant's own voice as if it were an
// interruption. This compares what was just heard against what the assistant
// is currently saying — if most of the words match, it's almost certainly an
// echo of its own speech, not you talking over it.
function looksLikeEcho(heard: string, currentlySpeaking: string): boolean {
  const heardWords = normalizedWords(heard);
  if (heardWords.length < 2) return true; // too short/noisy to trust either way
  const speakingWords = new Set(normalizedWords(currentlySpeaking));
  if (speakingWords.size === 0) return false;
  const overlap = heardWords.filter((w) => speakingWords.has(w)).length;
  return overlap / heardWords.length > 0.6;
}

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
  const heardRef = useRef("");
  const sentRef = useRef(false);
  const emptyRef = useRef(0);
  const loadedRef = useRef(false);
  const speakOutRef = useRef(false);
  // Mirrors `listening` synchronously so speakNow (which may fire from a
  // click handler, not just conversation flow) can tell whether the mic is
  // currently open before starting audio output.
  const listeningRef = useRef(false);
  // Bumped every time speech is intentionally cancelled (mute button, mic
  // opening, stopping conversation mode) or superseded by a newer speakNow
  // call. The in-flight retry logic checks this so a cancelled/muted
  // utterance never falls back to reading itself out in a different (often
  // male) voice — only a genuine synthesis failure should trigger that.
  const speechGenRef = useRef(0);
  // Holds the recognition session that quietly listens for you to start
  // talking while the assistant is mid-reply (see startBargeInListener).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bargeInRecRef = useRef<any>(null);

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

  // Pick a female voice, preferring the most natural-sounding one available
  // (Edge/Windows neural voices sound human). We keep the whole sorted list
  // of female candidates, not just the top pick, so that if the chosen voice
  // fails to start we can fall back to another female voice instead of
  // whatever the OS's own default happens to be (often male).
  const femaleVoicesRef = useRef<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const FEMALE =
      /female|\b(aria|jenny|jane|nancy|sara|michelle|ana|ashley|cora|elizabeth|monica|amber|libby|sonia|hazel|zira|susan|maisie|olivia|emma)\b/i;
    const MALE =
      /\bmale\b|\b(guy|davis|jason|tony|eric|brandon|christopher|ryan|thomas|david|mark|william|alfie)\b/i;
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
        if (FEMALE.test(n)) s += 25;
        if (MALE.test(n)) s -= 30;
        return s;
      };
      const sorted = [...voices].sort((a, b) => score(b) - score(a));
      const female = sorted.filter((v) => FEMALE.test(v.name.toLowerCase()));
      // Fall back to the overall best-scored voice if no female voice is
      // installed at all, so there's still a consistent single voice rather
      // than an unset OS default.
      femaleVoicesRef.current = female.length ? female : sorted.slice(0, 1);
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
    // Never let the assistant's voice play while the mic is open — that's
    // what causes it to "hear itself" and talk over you. Whatever triggered
    // this speech (the 🔊 button, a reply landing) wins; the mic yields.
    if (listeningRef.current) {
      try {
        recRef.current?.abort?.();
      } catch {
        /* ignore */
      }
      listeningRef.current = false;
      setListening(false);
    }
    const synth = window.speechSynthesis;
    // Claims this speech as the current generation — any older in-flight
    // utterance's retry logic (below) will see it's been superseded and
    // stop instead of falling back to a different voice.
    const myGen = ++speechGenRef.current;
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        onEnd?.();
      }
    };
    // voiceIndex walks femaleVoicesRef: 0..length-1 are female candidates in
    // preference order; voiceIndex === length is one last-resort attempt with
    // no voice set (whatever the OS default is) if every female voice failed.
    const say = (voiceIndex: number) => {
      const u = new SpeechSynthesisUtterance(text);
      const v = femaleVoicesRef.current[voiceIndex];
      if (v) {
        u.voice = v;
        u.lang = v.lang;
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
        // Superseded by a mute, a mic open, or a newer reply — stop cleanly,
        // don't retry into a different (possibly male) voice.
        if (speechGenRef.current !== myGen) {
          finish();
          return;
        }
        if (voiceIndex < femaleVoicesRef.current.length) {
          say(voiceIndex + 1);
        } else {
          finish();
        }
      };
      synth.speak(u);
    };
    synth.cancel();
    say(0);
    // If nothing is AUDIBLY speaking a moment later (Edge's neural voice can get
    // stuck 'pending' and fire no error, or a cancel+speak race drops it),
    // force a retry with the next female candidate — unless this call has
    // since been superseded (muted, mic opened, a newer reply started).
    setTimeout(() => {
      if (speechGenRef.current !== myGen) return;
      if (!done && !synth.speaking) {
        synth.cancel();
        say(1);
      }
    }, 900);
  };

  // Stops the barge-in listener and resolves once its recognition session has
  // actually finished tearing down — not just "we called abort". Starting a
  // new recognition session (the real listening turn) before the browser has
  // released the previous one is what made the second voice turn silently
  // fail: the speech service was still busy with the barge-in session.
  const stopBargeInListener = (): Promise<void> => {
    const rec = bargeInRecRef.current;
    bargeInRecRef.current = null;
    if (!rec) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      rec.onend = finish;
      rec.onerror = finish;
      try {
        rec.abort();
      } catch {
        finish();
      }
      // Safety net in case neither event fires for some reason.
      setTimeout(finish, 300);
    });
  };

  // Quietly listens in the background while the assistant is talking. If you
  // start talking — genuinely, not just the mic picking up the speaker's own
  // output — it fires onInterrupt so the caller can stop the assistant and
  // switch to properly listening to you, like a real conversation instead of
  // a strict turn-by-turn queue. Best-effort: works better with headphones,
  // since without them the echo check below is doing real work every time.
  const startBargeInListener = (myGen: number, getSpokenSoFar: () => string, onInterrupt: () => void) => {
    if (typeof window === "undefined" || speechGenRef.current !== myGen) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    let interrupted = false;
    try {
      const rec = new SR();
      rec.lang = "en-US";
      rec.interimResults = true;
      rec.continuous = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rec.onresult = (e: any) => {
        if (interrupted || speechGenRef.current !== myGen) return;
        let txt = "";
        for (let i = e.resultIndex; i < e.results.length; i++) txt += e.results[i][0].transcript;
        if (!txt.trim() || looksLikeEcho(txt, getSpokenSoFar())) return;
        interrupted = true;
        stopBargeInListener().then(onInterrupt);
      };
      rec.onerror = () => {
        /* best-effort — normal turn-taking listening still works either way */
      };
      rec.onend = () => {
        // Recognition sessions can end on their own (silence, browser
        // limits); keep it alive for as long as this speech turn still is.
        if (!interrupted && bargeInRecRef.current === rec && speechGenRef.current === myGen) {
          startBargeInListener(myGen, getSpokenSoFar, onInterrupt);
        }
      };
      bargeInRecRef.current = rec;
      rec.start();
    } catch {
      /* ignore — barge-in is a nice-to-have, not required for the turn to work */
    }
  };

  // Starts a "speech turn": a sequence of sentence-sized chunks spoken back
  // to back as they're enqueued, instead of waiting for the whole reply to
  // finish streaming before saying anything. This is the difference between
  // the voice feeling instant (starts talking as soon as the first sentence
  // is ready) versus making you sit through the entire response in silence.
  // Only the very first chunk goes through the cancel-then-speak race that
  // can silently get stuck (a known Edge neural-voice quirk); later chunks
  // are plain queued speak() calls and play naturally back to back.
  const beginSpeechTurn = () => {
    if (listeningRef.current) {
      try {
        recRef.current?.abort?.();
      } catch {
        /* ignore */
      }
      listeningRef.current = false;
      setListening(false);
    }
    const synth = window.speechSynthesis;
    const myGen = ++speechGenRef.current;
    synth.cancel(); // clear anything left over from a superseded turn
    let pending = 0;
    let streamDone = false;
    let finishedTurn = false;
    let turnText = ""; // everything spoken so far this turn, for the echo check
    const maybeFinishTurn = () => {
      if (finishedTurn || !streamDone || pending > 0) return;
      finishedTurn = true;
      // Wait for the barge-in session to actually finish tearing down before
      // opening the real mic again — starting it too early is what made the
      // second voice turn silently fail.
      stopBargeInListener().then(() => listenAfterSpeaking());
    };
    // Give the just-finished listening session a moment to actually release
    // before requesting a new recognition stream for barge-in — starting one
    // immediately after aborting another is the other half of that same race.
    if (convoRef.current) {
      setTimeout(() => {
        if (speechGenRef.current !== myGen) return;
        startBargeInListener(myGen, () => turnText, () => {
          speechGenRef.current++; // supersedes this turn's TTS retries too
          synth.cancel();
          startListening();
        });
      }, 400);
    }
    let chunkIndex = 0;
    const enqueue = (text: string) => {
      turnText += " " + text;
      const isFirstChunk = chunkIndex === 0;
      chunkIndex++;
      pending++;
      let doneChunk = false;
      const finishChunk = () => {
        if (doneChunk) return;
        doneChunk = true;
        pending--;
        maybeFinishTurn();
      };
      const attempt = (voiceIndex: number) => {
        if (speechGenRef.current !== myGen) {
          finishChunk();
          return;
        }
        const u = new SpeechSynthesisUtterance(text);
        const v = femaleVoicesRef.current[voiceIndex];
        if (v) {
          u.voice = v;
          u.lang = v.lang;
        } else {
          u.lang = "en-US";
        }
        u.rate = 1;
        u.pitch = 1;
        const keep = setInterval(() => {
          if (!synth.speaking) clearInterval(keep);
          else synth.resume();
        }, 7000);
        u.onend = () => {
          clearInterval(keep);
          finishChunk();
        };
        u.onerror = () => {
          clearInterval(keep);
          if (speechGenRef.current !== myGen) {
            finishChunk();
            return;
          }
          if (voiceIndex < femaleVoicesRef.current.length) attempt(voiceIndex + 1);
          else finishChunk();
        };
        synth.speak(u);
        if (isFirstChunk) {
          setTimeout(() => {
            if (speechGenRef.current !== myGen || doneChunk) return;
            if (!synth.speaking) {
              synth.cancel();
              if (voiceIndex < femaleVoicesRef.current.length) attempt(voiceIndex + 1);
              else finishChunk();
            }
          }, 900);
        }
      };
      attempt(0);
    };
    return {
      enqueue,
      noMoreChunks() {
        streamDone = true;
        maybeFinishTurn();
      },
    };
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

    const wantsVoice = typeof window !== "undefined" && (speakOutRef.current || convoRef.current);
    const turn = wantsVoice ? beginSpeechTurn() : null;
    let spokenUpTo = 0;
    // Speaks any complete sentence(s) newly available in `fullAcc` since the
    // last check. `flushAll` speaks whatever's left even without a trailing
    // ./!/? — used once the stream ends, since the last sentence in a reply
    // sometimes has no terminator by the time the model stops.
    const maybeSpeak = (fullAcc: string, flushAll: boolean) => {
      if (!turn) return;
      const unspoken = fullAcc.slice(spokenUpTo);
      if (flushAll) {
        const chunk = stripMarkdown(unspoken).trim();
        if (chunk) turn.enqueue(chunk);
        spokenUpTo = fullAcc.length;
        turn.noMoreChunks();
        return;
      }
      const re = /[^.!?\n]*[.!?\n]+/g;
      let consumed = 0;
      while (re.exec(unspoken)) consumed = re.lastIndex;
      if (consumed > 0) {
        const chunk = stripMarkdown(unspoken.slice(0, consumed)).trim();
        if (chunk) turn.enqueue(chunk);
        spokenUpTo += consumed;
      }
    };

    let acc = "";
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: q }),
      });
      if (!res.ok || !res.body) throw new Error(`server ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += dec.decode(value);
        setLast(acc);
        maybeSpeak(acc, false);
      }
    } catch {
      setLast("⚠ Could not reach the agent. Check that the app and Anthropic credits are available.");
    } finally {
      maybeSpeak(acc, true);
      if (!turn) listenAfterSpeaking();
      setBusy(false);
    }
  };

  const startListening = () => {
    // Don't stack a second recognition session on top of an active one — that
    // produces exactly the confused "doesn't listen" behavior (two sessions
    // racing to report results).
    if (listeningRef.current) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setVoiceErr("Voice input needs Chrome or Edge.");
      return;
    }
    // Belt-and-suspenders: make sure the assistant isn't still mid-utterance
    // (its own voice bleeding into the mic through the speaker is the other
    // half of the "hears itself" problem). Bump the generation first so this
    // cancellation doesn't trigger speakNow's own retry-into-another-voice.
    if (typeof window !== "undefined") {
      speechGenRef.current++;
      window.speechSynthesis?.cancel();
    }
    try {
      const rec = new SR();
      rec.lang = "en-US";
      rec.interimResults = true;
      // continuous: true — a plain single-utterance session (continuous:
      // false) ends the moment the engine detects ANY pause, which is far
      // too aggressive for natural speech (a breath, a "let me think") and
      // is why it was cutting you off mid-sentence. We manage our own
      // "you've actually gone quiet" timer below instead.
      rec.continuous = true;
      heardRef.current = "";
      sentRef.current = false;
      let silenceTimer: ReturnType<typeof setTimeout> | null = null;
      const clearSilenceTimer = () => {
        if (silenceTimer) {
          clearTimeout(silenceTimer);
          silenceTimer = null;
        }
      };
      const finishAndSend = () => {
        if (sentRef.current) return;
        const heard = heardRef.current.trim();
        if (!heard) return;
        sentRef.current = true;
        emptyRef.current = 0;
        clearSilenceTimer();
        try {
          rec.stop();
        } catch {
          /* ignore */
        }
        send(heard);
      };
      rec.onstart = () => {
        listeningRef.current = true;
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
          finishAndSend();
          return;
        }
        // Still going — push the "you've gone quiet" deadline out so a
        // mid-sentence pause doesn't end the turn early. Only real silence
        // (no new words for 1.8s) counts as done.
        clearSilenceTimer();
        silenceTimer = setTimeout(finishAndSend, 1800);
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rec.onerror = (e: any) => {
        clearSilenceTimer();
        listeningRef.current = false;
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
        clearSilenceTimer();
        listeningRef.current = false;
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
    listeningRef.current = false;
    setListening(false);
    stopBargeInListener();
    try {
      recRef.current?.abort?.();
    } catch {
      /* ignore */
    }
    if (typeof window !== "undefined") {
      speechGenRef.current++;
      window.speechSynthesis?.cancel();
    }
  };

  // Wait a beat after the assistant stops talking before opening the mic —
  // without this gap, the tail of its own voice (still resonating out of the
  // speaker) is the first thing the mic hears, which either produces a
  // garbage transcript or ends the session before you get a word in.
  const listenAfterSpeaking = () => {
    setTimeout(() => {
      if (convoRef.current) startListening();
    }, 500);
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
    speakNow("I'm listening.", listenAfterSpeaking);
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
                {stripMarkdown(m.text) || "…"}
              </div>
            </div>
          )
        )}
      </div>

      {voice && (voiceErr || convo) && (
        <div className="text-[11px] mb-2 px-1" style={{ color: voiceErr ? "#ff6b6b" : accent }}>
          {voiceErr ||
            (listening ? "🎙️ Listening — speak now…" : busy ? "Thinking…" : "🔊 Speaking — talk anytime to interrupt…")}
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
                speakNow(last ? stripMarkdown(last.text) : "Voice on.");
              } else {
                // Muting must mean silence — bump the generation first so
                // this cancellation can't trigger a fallback retry into a
                // different voice speaking right as you mute it.
                speechGenRef.current++;
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
