"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SuggestionCard } from "./SuggestionCard";
import { apiGet } from "../../lib/api";
import { AGENTS } from "../../agents/registry";
import type { AgentId, Suggestion } from "../../lib/types";

export function SuggestionsFeed() {
  const [items, setItems] = useState<Suggestion[]>([]);
  const [filter, setFilter] = useState<AgentId | "all">("all");
  const load = useCallback(() => {
    apiGet<Suggestion[]>("/api/suggestions").then((d) => {
      if (d) setItems(d);
    });
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  // how many new suggestions each agent has, so we only show chips that matter
  const counts = useMemo(() => {
    const m = new Map<AgentId, number>();
    for (const s of items) m.set(s.agent, (m.get(s.agent) ?? 0) + 1);
    return m;
  }, [items]);

  const present = AGENTS.filter((a) => counts.has(a.id));
  const shown =
    filter === "all" ? items : items.filter((s) => s.agent === filter);

  return (
    <div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 18,
        }}
      >
        <FilterChip
          label={`All (${items.length})`}
          active={filter === "all"}
          color="var(--text)"
          onClick={() => setFilter("all")}
        />
        {present.map((a) => (
          <FilterChip
            key={a.id}
            label={`${a.name} (${counts.get(a.id)})`}
            active={filter === a.id}
            color={a.accent}
            onClick={() => setFilter(a.id)}
          />
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>
          {items.length === 0
            ? "No new suggestions yet. Run a cycle."
            : "No suggestions from this agent right now."}
        </p>
      ) : (
        shown.map((s) => <SuggestionCard key={s.id} s={s} onResolve={load} />)
      )}
    </div>
  );
}

function FilterChip({
  label,
  active,
  color,
  onClick,
}: {
  label: string;
  active: boolean;
  color: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "5px 13px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer",
        whiteSpace: "nowrap",
        border: `1px solid ${active ? color : "var(--border)"}`,
        background: active ? color : "transparent",
        color: active ? "#0a0a0a" : "var(--text-dim)",
        transition: "background 0.15s, color 0.15s, border-color 0.15s",
      }}
    >
      {label}
    </button>
  );
}
