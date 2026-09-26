import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

// Static call-graph check (17 / €0): starting from every server entry point
// that can trigger AI work, follow real (non type-only) imports and prove the
// graph reaches the free router and never the Anthropic SDK, lib/anthropic,
// the legacy loop, or any other paid provider module.
const ROOT = join(__dirname, "..", "..");
const ENTRY_POINTS = [
  "app/api/cycle/route.ts",
  "app/api/agents/run/route.ts",
  "app/api/chat/route.ts",
  "app/api/agent-chat/[id]/route.ts",
  "app/api/qa/route.ts",
  "app/api/suggestions/[id]/handle/route.ts",
  "app/api/suggestions/[id]/qa-tick/route.ts",
  "app/api/suggestions/[id]/finalize/route.ts",
  "agents/run-agent.ts",
  "agents/fix-agent.ts",
  "agents/orchestrator.ts",
  "lib/qa-loop.ts",
  "lib/evals.ts",
  "lib/consensus.ts",
];

function valueImports(src: string): string[] {
  const out: string[] = [];
  const re = /^\s*(import|export)\s+(?!type\b)([^;]*?)\s+from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const spec = m[3] ?? m[4];
    if (m[2] && /^\{[^}]*\}$/.test(m[2].trim()) && m[2].replace(/[{}\s]/g, "").split(",").every((p) => p.startsWith("type"))) continue;
    out.push(spec);
  }
  return out;
}

function resolveLocal(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) if (existsSync(c) && c.match(/\.tsx?$/)) return c;
  return null;
}

function walk(): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const stack = ENTRY_POINTS.map((e) => join(ROOT, e)).filter((p) => existsSync(p));
  while (stack.length) {
    const f = stack.pop()!;
    if (files.has(f)) continue;
    files.add(f);
    for (const spec of valueImports(readFileSync(f, "utf8"))) {
      const local = resolveLocal(f, spec);
      if (local) stack.push(local);
      else if (!spec.startsWith(".")) packages.add(spec);
    }
  }
  return { files, packages };
}

describe("free-only call graph", () => {
  const { files, packages } = walk();
  const rel = [...files].map((f) => f.slice(ROOT.length + 1).replace(/\\/g, "/")).sort();

  it("reaches the free router and both free providers", () => {
    expect(rel).toContain("lib/free-llm.ts");
    expect(rel).toContain("lib/providers/ollama.ts");
    expect(rel).toContain("lib/providers/gemini.ts");
    expect(rel).toContain("agents/free-loop.ts");
  });

  it("never reaches the Anthropic SDK, lib/anthropic or the legacy loop", () => {
    expect(rel).not.toContain("lib/anthropic.ts");
    expect(rel).not.toContain("agents/run-loop.ts");
    // lib/models.ts is still reachable ONLY as inert data: agents/registry.ts
    // keeps a legacy `model: HAIKU` label that nothing on the free path reads.
    // It must stay a pure constants module (no imports, no SDK).
    if (rel.includes("lib/models.ts")) {
      expect(valueImports(readFileSync(join(ROOT, "lib/models.ts"), "utf8"))).toEqual([]);
      const importers = rel.filter((f) => /from ["'](\.\.\/)*(lib\/)?models["']|from ["']\.\/models["']/.test(readFileSync(join(ROOT, f), "utf8")));
      expect(importers).toEqual(["agents/registry.ts"]);
    }
    expect([...packages].filter((p) => /anthropic|openai|@google\/genai|generative-ai|groq|mistral|together|cohere|ollama/i.test(p))).toEqual([]);
  });

  it("no reachable file references a paid/other AI endpoint", () => {
    const hosts = /api\.anthropic\.com|api\.openai\.com|localhost:20128|9router|api\.groq\.com|api\.mistral\.ai|openrouter\.ai/i;
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(hosts);
  });

  it("the only AI endpoints reachable are local Ollama and Google's Generative Language API", () => {
    const ai = new Set<string>();
    for (const f of files) for (const u of readFileSync(f, "utf8").match(/https?:\/\/[a-z0-9.:-]+/gi) ?? []) ai.add(u);
    const aiHosts = [...ai].filter((u) => !/api\.github\.com|api\.supabase\.com|api\.tavily\.com|api\.telegram\.org|github\.com/.test(u));
    expect(aiHosts.sort()).toEqual(["http://127.0.0.1:11434", "https://generativelanguage.googleapis.com"]);
  });
});
