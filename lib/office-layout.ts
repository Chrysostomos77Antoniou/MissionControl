import { AGENTS, type AgentSpec } from "../agents/registry";
import type { AgentId } from "./types";

export type DepartmentId = "engineering" | "growth-design" | "trust-legal";

export interface DepartmentMeta {
  name: string;
  center: { x: number; z: number };
  size: { w: number; d: number };
  cols: number;
  spacing: number;
}

// Grouped by how the agents' actual work relates, not the old loose
// command/arrivals/workspace zones. Every AgentId must appear exactly
// once — see office-layout.test.ts's coverage check.
export const AGENT_DEPARTMENT: Record<AgentId, DepartmentId> = {
  cybersecurity: "engineering",
  devops: "engineering",
  engineering: "engineering",
  developer: "engineering",
  qa: "engineering",
  uxdesign: "growth-design",
  marketing: "growth-design",
  growth: "growth-design",
  competitive: "growth-design",
  copywriter: "growth-design",
  community: "trust-legal",
  legal: "trust-legal",
};

// Coordinates worked out by hand to fit a 48x34 floor (x: -24..24,
// z: -17..17) with zero room overlap — see the plan's Task 2 for the
// full derivation. All three department rooms share the west column
// (x center -15, width 10) stacked along z with 1-unit walking gaps.
export const DEPARTMENT_META: Record<DepartmentId, DepartmentMeta> = {
  "trust-legal": { name: "TRUST & LEGAL", center: { x: -15, z: -12 }, size: { w: 10, d: 6 }, cols: 2, spacing: 2.5 },
  engineering: { name: "ENGINEERING", center: { x: -15, z: -3 }, size: { w: 10, d: 9 }, cols: 3, spacing: 2.5 },
  "growth-design": { name: "GROWTH & DESIGN", center: { x: -15, z: 7 }, size: { w: 10, d: 9 }, cols: 3, spacing: 2.5 },
};

export function departmentAgents(department: DepartmentId): AgentSpec[] {
  return AGENTS.filter((spec) => AGENT_DEPARTMENT[spec.id] === department);
}

// Squared distance (avoids a sqrt per pair per frame across 66 agent
// pairs) — 2 units, per the design spec's "roughly 2 units" proximity
// range for the chatter mechanic.
export const CHATTER_RANGE_SQ = 2 * 2;

export interface ChatterCheckOptions {
  distanceSq: number;
  aWorking: boolean;
  bWorking: boolean;
  aCooldownUntil: number;
  bCooldownUntil: number;
  now: number;
}

// A bubble is eligible when the pair is within range, at least one of them
// is doing real work (so there's something true to show), and that
// working agent isn't still cooling down from its last bubble. Never
// invents dialogue for two idle agents standing near each other.
export function shouldChatter(opts: ChatterCheckOptions): boolean {
  if (opts.distanceSq >= CHATTER_RANGE_SQ) return false;
  const aEligible = opts.aWorking && opts.aCooldownUntil <= opts.now;
  const bEligible = opts.bWorking && opts.bCooldownUntil <= opts.now;
  return aEligible || bEligible;
}
