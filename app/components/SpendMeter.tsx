"use client";
import { useEffect, useState } from "react";
import { AreaChart, Area } from "recharts";

interface Spend {
  today: number;
  total: number;
  budget: number | null;
  remaining: number | null;
  dailyCap: number | null;
  accountEmpty: boolean;
}

interface DailySpend {
  day: string;
  cost: number;
}

export function SpendMeter() {
  const [s, setS] = useState<Spend | null>(null);
  const [history, setHistory] = useState<DailySpend[] | null>(null);
  useEffect(() => {
    const load = () => {
      fetch("/api/spend").then((r) => r.json()).then(setS).catch(() => {});
      fetch("/api/spend/history").then((r) => r.json()).then(setHistory).catch(() => {});
    };
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);
  if (!s) return null;

  const low = s.remaining !== null && s.budget !== null && s.remaining < s.budget * 0.15;
  const fmt = (n: number) => `$${n.toFixed(2)}`;

  return (
    <div
      className="glass rounded px-3 py-1 flex items-center gap-3 font-mono text-[10px]"
      style={{ border: "1px solid var(--border)" }}
      title="Anthropic API spend (computed from token usage)"
    >
      <span style={{ color: "var(--text-dim)" }}>◈ CREDITS</span>
      {s.accountEmpty ? (
        <span style={{ color: "var(--danger)" }} className="glow-text">
          ⚠ ACCOUNT EMPTY — top up
        </span>
      ) : s.remaining !== null ? (
        <span style={{ color: low ? "var(--danger)" : "var(--growth)" }} className="glow-text">
          {fmt(s.remaining)} left
        </span>
      ) : (
        <span style={{ color: "var(--growth)" }}>no cap</span>
      )}
      <span style={{ color: "var(--text-dim)" }}>·</span>
      <span style={{ color: "var(--content)" }}>spent {fmt(s.total)}</span>
      <span style={{ color: "var(--text-dim)" }}>·</span>
      <span style={{ color: "var(--amber)" }}>today {fmt(s.today)}</span>
      {s.dailyCap !== null && s.today >= s.dailyCap && (
        <span style={{ color: "var(--danger)" }} className="glow-text">
          ⛔ CAP
        </span>
      )}
      {/* 14-day trend — the meter previously only ever showed point-in-time
          totals, with no way to see whether spend is climbing or flat. */}
      {history && history.some((d) => d.cost > 0) && (
        <div title={`Last 14 days: ${fmt(history.reduce((a, d) => a + d.cost, 0))}`}>
          <AreaChart width={56} height={18} data={history}>
            <Area type="monotone" dataKey="cost" stroke="var(--amber)" fill="var(--amber)" fillOpacity={0.25} strokeWidth={1.25} isAnimationActive={false} />
          </AreaChart>
        </div>
      )}
    </div>
  );
}
