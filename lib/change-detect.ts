// Deterministic change detection for unattended cycles (Commit 6b).
//
// Pure: no I/O, no clock, no environment. The cycle runner (agents/cycle.ts)
// reads the sources and the stored baseline and passes them in.
//
// An agent's fingerprint is one SHA-256 per applicable source:
//   S1 footrank_totals  — all-time totals (users, matches, teams,
//                          behavior_reports, notifications); growth,
//                          marketing, community, devops only. Rolling 7-day
//                          windows are deliberately NOT used: they change
//                          just because time passes.
//   S2 open_suggestions — the agent's own open suggestions exactly as they
//                          feed its prompt (id, status, priority, title);
//                          every agent.
//   S3 maximum age       — a baseline older than MAX_BASELINE_AGE_MS makes
//                          the agent eligible even if nothing changed.
//
// Missing baseline = UNKNOWN -> run. A source that cannot be read = "error"
// -> do not run, never "unchanged".

import { createHash } from "node:crypto";
import type { AgentId } from "./types";

export const MAX_BASELINE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, fixed
export const BASELINE_ACTION = "cycle:baseline";
const FINGERPRINT_VERSION = 1;

export type ChangeSource = "footrank_totals" | "open_suggestions";

export const TOTALS_AGENTS: ReadonlySet<AgentId> = new Set<AgentId>(["growth", "marketing", "community", "devops"]);

export function sourcesFor(agent: AgentId): ChangeSource[] {
  return TOTALS_AGENTS.has(agent) ? ["footrank_totals", "open_suggestions"] : ["open_suggestions"];
}

export interface FootrankTotals {
  users: number;
  matches: number;
  teams: number;
  behavior_reports: number;
  notifications: number;
}
const TOTAL_KEYS: readonly (keyof FootrankTotals)[] = ["behavior_reports", "matches", "notifications", "teams", "users"];

// The fields of an open suggestion that reach the agent's prompt, plus its id.
export interface OpenSuggestionState {
  id: string;
  status: string;
  priority: string;
  title: string;
}

export type SourceHashes = Partial<Record<ChangeSource, string>>;

export interface Baseline {
  v: number;
  agent: AgentId;
  at: string; // ISO time of the pre-run snapshot of the successful run
  sources: SourceHashes;
}

export type Detection =
  | { kind: "missing"; sources: SourceHashes }
  | { kind: "changed"; sources: SourceHashes; changed: ChangeSource[] }
  | { kind: "stale"; sources: SourceHashes; ageMs: number }
  | { kind: "unchanged"; sources: SourceHashes; ageMs: number }
  | { kind: "error"; detail: string };

// Key-order-independent JSON (arrays keep their order; callers sort them).
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

export function hashOf(label: string, v: unknown): string {
  return createHash("sha256").update(`v${FINGERPRINT_VERSION}:${label}:${stableStringify(v)}`).digest("hex");
}

export function fingerprintTotals(t: FootrankTotals): string {
  const clean: Record<string, number> = {};
  for (const k of TOTAL_KEYS) {
    const n = t?.[k];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw new Error(`invalid total "${k}"`);
    clean[k] = n;
  }
  return hashOf("footrank_totals", clean);
}

export function fingerprintSuggestions(rows: readonly OpenSuggestionState[]): string {
  const clean = rows.map((r) => {
    if (!r || typeof r.id !== "string" || !r.id) throw new Error("invalid open suggestion row");
    return { id: r.id, status: String(r.status ?? ""), priority: String(r.priority ?? ""), title: String(r.title ?? "") };
  });
  clean.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return hashOf("open_suggestions", clean);
}

// null means "that source failed to read". A required source that is null
// (or malformed) makes the whole detection an error.
export interface SourceReadings {
  totals?: FootrankTotals | null;
  openSuggestions?: readonly OpenSuggestionState[] | null;
}

export function buildSourceHashes(agent: AgentId, r: SourceReadings): { ok: true; sources: SourceHashes } | { ok: false; detail: string } {
  const out: SourceHashes = {};
  try {
    for (const s of sourcesFor(agent)) {
      if (s === "footrank_totals") {
        if (!r.totals) return { ok: false, detail: "footrank_totals unavailable" };
        out.footrank_totals = fingerprintTotals(r.totals);
      } else {
        if (!r.openSuggestions) return { ok: false, detail: "open_suggestions unavailable" };
        out.open_suggestions = fingerprintSuggestions(r.openSuggestions);
      }
    }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, sources: out };
}

export function classify(agent: AgentId, current: SourceHashes, baseline: Baseline | null, nowMs: number): Detection {
  if (!baseline) return { kind: "missing", sources: current };
  const required = sourcesFor(agent);
  const changed = required.filter((s) => !baseline.sources[s] || baseline.sources[s] !== current[s]);
  if (changed.length) return { kind: "changed", sources: current, changed };
  const ageMs = nowMs - Date.parse(baseline.at);
  if (!(ageMs < MAX_BASELINE_AGE_MS)) return { kind: "stale", sources: current, ageMs };
  return { kind: "unchanged", sources: current, ageMs };
}

// Combines reading results + stored baseline into one decision.
export function detect(
  agent: AgentId,
  readings: SourceReadings,
  baseline: { ok: true; baseline: Baseline | null } | { ok: false; detail: string },
  nowMs: number,
): Detection {
  if (!baseline.ok) return { kind: "error", detail: `baseline unavailable: ${baseline.detail}` };
  const built = buildSourceHashes(agent, readings);
  if (!built.ok) return { kind: "error", detail: built.detail };
  return classify(agent, built.sources, baseline.baseline, nowMs);
}

// Run only for "missing", "changed" or "stale" — never for "unchanged" or "error".
export function shouldRun(d: Detection): boolean {
  return d.kind === "missing" || d.kind === "changed" || d.kind === "stale";
}

export function serializeBaseline(b: Baseline): string {
  return stableStringify(b);
}

// A missing or unreadable row is "no baseline" (=> UNKNOWN -> run), never a
// reason to skip. Only deterministic hashes and a timestamp are accepted.
export function parseBaseline(agent: AgentId, detail: unknown): Baseline | null {
  if (typeof detail !== "string") return null;
  try {
    const o = JSON.parse(detail) as Partial<Baseline>;
    if (o?.v !== FINGERPRINT_VERSION || o.agent !== agent || typeof o.at !== "string" || Number.isNaN(Date.parse(o.at))) return null;
    if (!o.sources || typeof o.sources !== "object") return null;
    const sources: SourceHashes = {};
    for (const [k, h] of Object.entries(o.sources)) {
      if ((k === "footrank_totals" || k === "open_suggestions") && typeof h === "string" && /^[0-9a-f]{64}$/.test(h)) sources[k] = h;
    }
    return { v: FINGERPRINT_VERSION, agent, at: o.at, sources };
  } catch {
    return null;
  }
}

export function makeBaseline(agent: AgentId, sources: SourceHashes, at: Date): Baseline {
  return { v: FINGERPRINT_VERSION, agent, at: at.toISOString(), sources };
}
