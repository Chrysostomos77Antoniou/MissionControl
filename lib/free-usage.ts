// Free-AI usage tracking (Phase 2, commit 4).
//
// Stores one row per free-provider REQUEST in the existing `usage_log` table
// (columns verified live: id, model, input_tokens, output_tokens, cache_read,
// cache_write, cost, created_at). No schema change.
//
//   model = "free:<provider>:<model>"            one row per attempted request,
//                                                 written BEFORE the call
//   model = "free-exhausted:<provider>:<model>"  marker: provider said the
//                                                 free quota is used up today
//   cost  = 0 always. No prompts, tool results or keys are ever stored.
//
// The legacy Anthropic accounting in lib/usage.ts is untouched; these rows
// have cost 0 so they don't change its dollar totals.

import { supabaseAdmin } from "./supabase";

export interface FreeUsageStore {
  // Throws if the count cannot be determined (callers must fail closed).
  countRequestsSince(key: string, since: Date): Promise<number>;
  // Throws if it cannot be determined.
  isExhaustedSince(key: string, since: Date): Promise<boolean>;
  // Records one request before it is sent. Throws on failure; returns row id.
  reserve(key: string): Promise<string>;
  // Fills in token usage after the call. Best effort.
  complete(id: string, usage: { inputTokens: number; outputTokens: number }): Promise<void>;
  // Persists "free quota exhausted today" for key. Best effort.
  markExhausted(key: string): Promise<void>;
}

export const usageRowModel = (key: string) => `free:${key}`;
export const exhaustedRowModel = (key: string) => `free-exhausted:${key}`;

// Start of the quota "day". Google documents free-tier daily limits as
// resetting at midnight Pacific time; to be safe under either convention we
// count from whichever is EARLIER of Pacific midnight and UTC midnight. That
// can only over-count usage (blocking sooner), never under-count it.
export function quotaDayStart(now: Date = new Date()): Date {
  return new Date(Math.min(zonedMidnight(now, "America/Los_Angeles").getTime(), zonedMidnight(now, "UTC").getTime()));
}

function zonedMidnight(now: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const y = get("year"), m = get("month"), d = get("day");
  // Local midnight = UTC midnight of that date minus the zone's UTC offset then.
  const utcMidnight = Date.UTC(y, m - 1, d);
  const offsetMin = zoneOffsetMinutes(new Date(utcMidnight), timeZone);
  let start = utcMidnight - offsetMin * 60_000;
  // Re-check the offset at the computed instant (DST transition days).
  const offset2 = zoneOffsetMinutes(new Date(start), timeZone);
  if (offset2 !== offsetMin) start = utcMidnight - offset2 * 60_000;
  return new Date(start);
}

function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!m) return 0;
  const mins = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === "-" ? -mins : mins;
}

export const supabaseFreeUsageStore: FreeUsageStore = {
  async countRequestsSince(key, since) {
    const { count, error } = await supabaseAdmin
      .from("usage_log")
      .select("id", { count: "exact", head: true })
      .eq("model", usageRowModel(key))
      .gte("created_at", since.toISOString());
    if (error || typeof count !== "number") throw new Error(`usage count unavailable${error ? `: ${error.message}` : ""}`);
    return count;
  },
  async isExhaustedSince(key, since) {
    const { count, error } = await supabaseAdmin
      .from("usage_log")
      .select("id", { count: "exact", head: true })
      .eq("model", exhaustedRowModel(key))
      .gte("created_at", since.toISOString());
    if (error || typeof count !== "number") throw new Error(`exhaustion state unavailable${error ? `: ${error.message}` : ""}`);
    return count > 0;
  },
  async reserve(key) {
    const { data, error } = await supabaseAdmin
      .from("usage_log")
      .insert({ model: usageRowModel(key), input_tokens: 0, output_tokens: 0, cost: 0 })
      .select("id")
      .single();
    const id = (data as { id?: string } | null)?.id;
    if (error || !id) throw new Error(`usage reservation failed${error ? `: ${error.message}` : ""}`);
    return id;
  },
  async complete(id, usage) {
    await supabaseAdmin
      .from("usage_log")
      .update({ input_tokens: Math.max(0, Math.round(usage.inputTokens)), output_tokens: Math.max(0, Math.round(usage.outputTokens)), cost: 0 })
      .eq("id", id);
  },
  async markExhausted(key) {
    await supabaseAdmin.from("usage_log").insert({ model: exhaustedRowModel(key), cost: 0 });
  },
};
