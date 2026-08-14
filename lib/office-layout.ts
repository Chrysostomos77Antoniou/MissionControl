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

// Coordinates worked out by hand to fit a 38x32 floor (x: -19..19,
// z: -16..16) with zero room overlap. All three department rooms sit
// side by side in one row along the north edge (same z center, 10-wide
// each, ~1.5-unit walking gaps between) rather than stacked front-to-back
// — the original stacked layout left a large dead void in the middle of
// the floor between the room column and the conference/Orchestrator
// cluster; this row, plus pulling that cluster up close behind it,
// removes that void.
export const DEPARTMENT_META: Record<DepartmentId, DepartmentMeta> = {
  "trust-legal": { name: "TRUST & LEGAL", center: { x: -11.5, z: -10 }, size: { w: 10, d: 9 }, cols: 2, spacing: 2.5 },
  engineering: { name: "ENGINEERING", center: { x: 0, z: -10 }, size: { w: 10, d: 9 }, cols: 3, spacing: 2.5 },
  "growth-design": { name: "GROWTH & DESIGN", center: { x: 11.5, z: -10 }, size: { w: 10, d: 9 }, cols: 3, spacing: 2.5 },
};

export function departmentAgents(department: DepartmentId): AgentSpec[] {
  return AGENTS.filter((spec) => AGENT_DEPARTMENT[spec.id] === department);
}

// Grid layout for a department room's desks — pure arithmetic, no THREE.js
// involved, so it's unit-testable (see office-layout.test.ts). Ported
// verbatim from AgentDeck.tsx, which now imports this instead of defining
// its own copy.
export function deskPositions(count: number, cols: number, cx: number, cz: number, spacing: number) {
  const rows = Math.ceil(count / cols);
  const out: { x: number; z: number }[] = [];
  const w = (cols - 1) * spacing;
  const d = (rows - 1) * spacing;
  for (let i = 0; i < count; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    out.push({ x: cx - w / 2 + c * spacing, z: cz - d / 2 + r * spacing });
  }
  return out;
}

export interface RoomSpec {
  center: { x: number; z: number };
  size: { w: number; d: number };
}

export type RoomId = DepartmentId | "conference" | "orchestrator";

// Single source of truth for every enclosed room's footprint on the 38x32
// floor — the three department rooms (reusing DEPARTMENT_META's own
// center/size, not a retyped copy of the same numbers), the conference
// room, and the Orchestrator's office. AgentDeck.tsx derives its
// MEETING_CENTER/MEETING_ROOM_W/D and ORCH_DESK/ORCH_ROOM constants from
// this instead of hardcoding them a second time, so a room can only ever
// move in one place. See office-layout.test.ts for the overlap/floor-fit
// invariant this is meant to protect.
//
// Conference and Orchestrator sit directly south of the department row
// (row's z max is -5.5) with ~1.4-1.5 unit gaps — close enough that the
// floor reads as one connected building, not two clusters split by open
// space.
export const ROOMS: Record<RoomId, RoomSpec> = {
  "trust-legal": DEPARTMENT_META["trust-legal"],
  engineering: DEPARTMENT_META.engineering,
  "growth-design": DEPARTMENT_META["growth-design"],
  conference: { center: { x: 7, z: -0.5 }, size: { w: 7.5, d: 7.2 } },
  orchestrator: { center: { x: -6, z: 1 }, size: { w: 11, d: 10 } },
};

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
