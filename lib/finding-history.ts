// Finding history for deterministic duplicate detection (7b).
//
// Read-only queries over the tables Mission Control already has — no new
// table, no migration:
//   - suggestions still open (status "new"), any agent;
//   - suggestions dismissed or done in the last HISTORY_DAYS days;
//   - findings the evidence gate rejected in the last HISTORY_DAYS days,
//     remembered as compact "finding:rejected" rows in activity_log (written
//     by lib/finding-submit.ts through the existing logActivity).
// Fails closed: a query error throws, and the caller saves nothing.

import { supabaseAdmin } from "./supabase";
import { fingerprintStored, type FindingPrint } from "./finding-fingerprint";
import type { FindingClass, GateCode } from "./finding-gate";

export const HISTORY_DAYS = 90;
export const REJECTED_ACTION = "finding:rejected";

export type HistorySource = "open" | "dismissed" | "done" | "rejected";

export interface HistoryEntry {
  id: string | null;
  source: HistorySource;
  agent: string;
  title: string;
  createdAt: string;
  print: FindingPrint;
  rejectCode?: GateCode;
}

export interface FindingHistory {
  entries: HistoryEntry[];
}

export const emptyHistory = (): FindingHistory => ({ entries: [] });

interface SuggestionRow {
  id: string;
  agent: string;
  title: string;
  body: string | null;
  category: string | null;
  status: string;
  created_at: string;
}

const LIST = /^[A-Za-z0-9_.:+-]+$/;
const cleanList = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && LIST.test(x)).slice(0, max) : []);
const GATE_CODES: GateCode[] = ["invalid_input", "invalid_evidence", "contradicted", "unsupported_absence", "insufficient"];
const CLASSES: FindingClass[] = ["verified_bug", "plausible_risk", "product_idea"];

// Compact, bounded record of one rejected finding (stored in activity_log.detail).
export function rejectedDetail(r: { code: GateCode; cls?: FindingClass; title: string; print: FindingPrint }): string {
  const p = r.print;
  return JSON.stringify({
    v: 1,
    code: r.code,
    ...(r.cls ? { cls: r.cls } : {}),
    title: r.title.slice(0, 120),
    print: { family: p.family, fp: p.fp, symbol: p.symbol.slice(0, 60), files: p.files.slice(0, 8), anchors: p.anchors.slice(0, 12), terms: p.terms.slice(0, 30) },
  });
}

export function parseRejectedDetail(detail: string | null): { code: GateCode; cls?: FindingClass; title: string; print: FindingPrint } | null {
  if (!detail) return null;
  try {
    const o = JSON.parse(detail) as Record<string, unknown>;
    const p = (o.print ?? {}) as Record<string, unknown>;
    if (o.v !== 1 || !GATE_CODES.includes(o.code as GateCode) || (p.family !== "defect" && p.family !== "idea")) return null;
    const cls = CLASSES.includes(o.cls as FindingClass) ? (o.cls as FindingClass) : undefined;
    return {
      code: o.code as GateCode,
      ...(cls ? { cls } : {}),
      title: typeof o.title === "string" ? o.title.slice(0, 120) : "",
      print: {
        family: p.family,
        ...(cls ? { cls } : {}),
        fp: typeof p.fp === "string" && /^[0-9a-f]{16}$/.test(p.fp) ? p.fp : null,
        symbol: typeof p.symbol === "string" && LIST.test(p.symbol) ? p.symbol : "",
        files: cleanList(p.files, 8),
        anchors: cleanList(p.anchors, 12),
        terms: cleanList(p.terms, 30),
      },
    };
  } catch {
    return null;
  }
}

export async function loadFindingHistory(now: Date = new Date()): Promise<FindingHistory> {
  const since = new Date(now.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const cols = "id, agent, title, body, category, status, created_at";
  const [open, closed, rejected] = await Promise.all([
    supabaseAdmin.from("suggestions").select(cols).eq("status", "new").order("created_at", { ascending: false }).limit(200),
    supabaseAdmin.from("suggestions").select(cols).in("status", ["dismissed", "done"]).gte("created_at", since).order("created_at", { ascending: false }).limit(300),
    supabaseAdmin.from("activity_log").select("id, agent, detail, created_at").eq("action", REJECTED_ACTION).gte("created_at", since).order("created_at", { ascending: false }).limit(300),
  ]);
  for (const r of [open, closed, rejected]) if (r.error) throw new Error(`finding history unavailable (${String(r.error.message ?? r.error).slice(0, 120)})`);

  const entries: HistoryEntry[] = [];
  for (const row of [...((open.data ?? []) as SuggestionRow[]), ...((closed.data ?? []) as SuggestionRow[])]) {
    const source: HistorySource = row.status === "new" ? "open" : row.status === "done" ? "done" : "dismissed";
    entries.push({ id: row.id, source, agent: row.agent, title: row.title, createdAt: row.created_at, print: fingerprintStored({ title: row.title, body: row.body ?? "", category: row.category }) });
  }
  for (const row of (rejected.data ?? []) as { id: string; agent: string; detail: string | null; created_at: string }[]) {
    const d = parseRejectedDetail(row.detail);
    if (d) entries.push({ id: row.id, source: "rejected", agent: row.agent, title: d.title, createdAt: row.created_at, print: d.print, rejectCode: d.code });
  }
  return { entries };
}

// Compact list for the agent prompt: what the owner dismissed or the gate
// rejected recently, so the same weak finding is not submitted again.
export function historyDigest(h: FindingHistory, limit = 12): string {
  const lines = h.entries
    .filter((e) => e.source !== "open")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit)
    .map((e) => {
      const tag = e.source === "rejected" ? `rejected by the evidence gate: ${e.rejectCode}` : e.source === "done" ? "done" : "dismissed by the owner";
      const where = e.print.files.length ? ` (${e.print.files.slice(0, 3).join(", ")}${e.print.symbol ? ` › ${e.print.symbol}` : ""})` : "";
      return `- [${tag}] ${e.title.replace(/\s+/g, " ").slice(0, 120)}${where}`;
    });
  return lines.join("\n");
}
