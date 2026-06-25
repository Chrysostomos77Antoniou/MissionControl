"use client";
import { useCallback, useEffect, useState } from "react";
import { SuggestionCard } from "./SuggestionCard";
import type { Suggestion } from "../../lib/types";

export function SuggestionsFeed() {
  const [items, setItems] = useState<Suggestion[]>([]);
  const load = useCallback(() => {
    fetch("/api/suggestions").then((r) => r.json()).then(setItems);
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  if (items.length === 0) {
    return <p className="text-sm" style={{ color: "var(--text-dim)" }}>No new suggestions yet. Run a cycle.</p>;
  }
  return (
    <div>
      {items.map((s) => (
        <SuggestionCard key={s.id} s={s} onResolve={load} />
      ))}
    </div>
  );
}
