import { supabaseAdmin } from "./supabase";

// Price per 1M tokens: [input, output].
const PRICE: Record<string, [number, number]> = {
  "claude-opus-4-8": [5, 25],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5": [1, 5],
};

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export async function recordUsage(model: string, usage: Usage | undefined): Promise<void> {
  if (!usage) return;
  const [pin, pout] = PRICE[model] ?? [5, 25];
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cost =
    (input * pin + output * pout + cacheRead * pin * 0.1 + cacheWrite * pin * 1.25) / 1_000_000;
  await supabaseAdmin.from("usage_log").insert({
    model,
    input_tokens: input,
    output_tokens: output,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    cost,
  });
}

const LOW_CREDIT = "__low_credit__";

// Record that an API call failed because the real Anthropic balance is empty,
// so the meter can show the truth (it otherwise only knows the budget you set).
export async function flagApiError(message: string): Promise<void> {
  if (!/credit balance/i.test(message)) return;
  await supabaseAdmin.from("usage_log").insert({ model: LOW_CREDIT, cost: 0 });
}

export interface SpendSummary {
  today: number;
  total: number;
  budget: number | null;
  remaining: number | null;
  dailyCap: number | null;
  accountEmpty: boolean;
}

export async function spendSummary(): Promise<SpendSummary> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const [all, todayRows, lastLow, lastOk] = await Promise.all([
    supabaseAdmin.from("usage_log").select("cost").neq("model", LOW_CREDIT),
    supabaseAdmin.from("usage_log").select("cost").neq("model", LOW_CREDIT).gte("created_at", startOfDay.toISOString()),
    supabaseAdmin.from("usage_log").select("created_at").eq("model", LOW_CREDIT).order("created_at", { ascending: false }).limit(1),
    supabaseAdmin.from("usage_log").select("created_at").neq("model", LOW_CREDIT).order("created_at", { ascending: false }).limit(1),
  ]);
  const sum = (rows: { cost: number }[] | null) => (rows ?? []).reduce((a, r) => a + Number(r.cost), 0);
  const total = sum(all.data as { cost: number }[] | null);
  const today = sum(todayRows.data as { cost: number }[] | null);
  const budget = process.env.ANTHROPIC_BUDGET ? Number(process.env.ANTHROPIC_BUDGET) : null;
  const dailyCap = process.env.ANTHROPIC_DAILY_CAP ? Number(process.env.ANTHROPIC_DAILY_CAP) : null;

  // Empty only if the latest failure is recent AND no successful call since.
  const lowAt = lastLow.data?.[0]?.created_at as string | undefined;
  const okAt = lastOk.data?.[0]?.created_at as string | undefined;
  const accountEmpty =
    !!lowAt && lowAt >= tenMinAgo && (!okAt || okAt < lowAt);

  return {
    today,
    total,
    budget,
    remaining: budget !== null ? Math.max(0, budget - total) : null,
    dailyCap,
    accountEmpty,
  };
}

// Budget guard: true means agents may run. Stops spend once the daily cap or
// total budget is reached.
export async function withinBudget(): Promise<{ ok: boolean; detail: string }> {
  const s = await spendSummary();
  if (s.budget !== null && s.total >= s.budget) {
    return { ok: false, detail: `Total budget of $${s.budget.toFixed(2)} reached — top up and raise ANTHROPIC_BUDGET.` };
  }
  if (s.dailyCap !== null && s.today >= s.dailyCap) {
    return { ok: false, detail: `Daily cap of $${s.dailyCap.toFixed(2)} reached — resets at midnight.` };
  }
  return { ok: true, detail: "" };
}
