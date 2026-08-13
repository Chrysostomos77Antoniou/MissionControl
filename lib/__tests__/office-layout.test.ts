import { describe, expect, it } from "vitest";
import { AGENTS } from "../../agents/registry";
import {
  AGENT_DEPARTMENT,
  CHATTER_RANGE_SQ,
  DEPARTMENT_META,
  ROOMS,
  departmentAgents,
  deskPositions,
  shouldChatter,
  type DepartmentId,
  type RoomId,
  type RoomSpec,
} from "../office-layout";

// Axis-aligned bounds of a room, derived from its center/size — the same
// shape buildGlassRoom in AgentDeck.tsx uses to place its 4 walls.
function bounds(room: RoomSpec) {
  return {
    xMin: room.center.x - room.size.w / 2,
    xMax: room.center.x + room.size.w / 2,
    zMin: room.center.z - room.size.d / 2,
    zMax: room.center.z + room.size.d / 2,
  };
}

function overlaps(a: RoomSpec, b: RoomSpec): boolean {
  const A = bounds(a);
  const B = bounds(b);
  return A.xMin < B.xMax && A.xMax > B.xMin && A.zMin < B.zMax && A.zMax > B.zMin;
}

describe("AGENT_DEPARTMENT", () => {
  it("assigns exactly one department to every agent in the registry", () => {
    for (const spec of AGENTS) {
      expect(AGENT_DEPARTMENT[spec.id]).toBeDefined();
      expect(Object.keys(DEPARTMENT_META)).toContain(AGENT_DEPARTMENT[spec.id]);
    }
  });

  it("has no agent assigned to more than one department", () => {
    // Record type already prevents this structurally, but assert the id set
    // is exactly AGENTS' ids with no extras/omissions.
    const mapped = Object.keys(AGENT_DEPARTMENT).sort();
    const real = AGENTS.map((a) => a.id).sort();
    expect(mapped).toEqual(real);
  });
});

describe("departmentAgents", () => {
  it("returns every agent whose AGENT_DEPARTMENT matches, and only those", () => {
    const engineering = departmentAgents("engineering");
    for (const spec of engineering) {
      expect(AGENT_DEPARTMENT[spec.id]).toBe("engineering");
    }
    const engineeringIds = new Set(engineering.map((a) => a.id));
    for (const spec of AGENTS) {
      if (AGENT_DEPARTMENT[spec.id] === "engineering") {
        expect(engineeringIds.has(spec.id)).toBe(true);
      }
    }
  });

  it("covers all three departments across all agents with no one left out", () => {
    const total =
      departmentAgents("engineering").length +
      departmentAgents("growth-design").length +
      departmentAgents("trust-legal").length;
    expect(total).toBe(AGENTS.length);
  });
});

describe("shouldChatter", () => {
  const now = 100_000;

  it("is true when within range, one agent working, neither on cooldown", () => {
    expect(
      shouldChatter({
        distanceSq: CHATTER_RANGE_SQ - 0.01,
        aWorking: true,
        bWorking: false,
        aCooldownUntil: 0,
        bCooldownUntil: 0,
        now,
      }),
    ).toBe(true);
  });

  it("is false when outside range even if both working", () => {
    expect(
      shouldChatter({
        distanceSq: CHATTER_RANGE_SQ + 0.01,
        aWorking: true,
        bWorking: true,
        aCooldownUntil: 0,
        bCooldownUntil: 0,
        now,
      }),
    ).toBe(false);
  });

  it("is false when neither agent is working", () => {
    expect(
      shouldChatter({
        distanceSq: 0,
        aWorking: false,
        bWorking: false,
        aCooldownUntil: 0,
        bCooldownUntil: 0,
        now,
      }),
    ).toBe(false);
  });

  it("is false when the working agent is still on cooldown", () => {
    expect(
      shouldChatter({
        distanceSq: 0,
        aWorking: true,
        bWorking: false,
        aCooldownUntil: now + 5000,
        bCooldownUntil: 0,
        now,
      }),
    ).toBe(false);
  });

  it("is true when the working agent's cooldown has just expired", () => {
    expect(
      shouldChatter({
        distanceSq: 0,
        aWorking: true,
        bWorking: false,
        aCooldownUntil: now - 1,
        bCooldownUntil: 0,
        now,
      }),
    ).toBe(true);
  });

  it("is false exactly at the range boundary (strictly less-than)", () => {
    expect(
      shouldChatter({
        distanceSq: CHATTER_RANGE_SQ,
        aWorking: true,
        bWorking: false,
        aCooldownUntil: 0,
        bCooldownUntil: 0,
        now,
      }),
    ).toBe(false);
  });
});

// Regression coverage for the whole-branch review's Finding 1 (a decor
// plant landing inside a desk's occupied space after a room moved) and
// Finding 5 (theme-prop coordinates silently drifting from the room they're
// supposed to sit in). Both bugs were pure arithmetic — no WebGL needed to
// catch them.
describe("ROOMS", () => {
  const FLOOR_W = 48;
  const FLOOR_D = 34;

  it("fits every room inside the 48x34 floor", () => {
    for (const id of Object.keys(ROOMS) as RoomId[]) {
      const b = bounds(ROOMS[id]);
      expect(b.xMin).toBeGreaterThanOrEqual(-FLOOR_W / 2);
      expect(b.xMax).toBeLessThanOrEqual(FLOOR_W / 2);
      expect(b.zMin).toBeGreaterThanOrEqual(-FLOOR_D / 2);
      expect(b.zMax).toBeLessThanOrEqual(FLOOR_D / 2);
    }
  });

  it("has no two rooms overlapping", () => {
    const ids = Object.keys(ROOMS) as RoomId[];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        expect(overlaps(ROOMS[ids[i]], ROOMS[ids[j]])).toBe(false);
      }
    }
  });
});

describe("deskPositions within department rooms", () => {
  it("keeps every desk, and its occupant's home position (desk z + 0.9), inside that department's own room bounds", () => {
    const ids = Object.keys(DEPARTMENT_META) as DepartmentId[];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const meta = DEPARTMENT_META[id];
      const specs = departmentAgents(id);
      expect(specs.length).toBeGreaterThan(0);
      const positions = deskPositions(specs.length, meta.cols, meta.center.x, meta.center.z, meta.spacing);
      const b = bounds(ROOMS[id]);
      for (const pos of positions) {
        expect(pos.x).toBeGreaterThanOrEqual(b.xMin);
        expect(pos.x).toBeLessThanOrEqual(b.xMax);
        expect(pos.z).toBeGreaterThanOrEqual(b.zMin);
        expect(pos.z).toBeLessThanOrEqual(b.zMax);
        const homeZ = pos.z + 0.9;
        expect(homeZ).toBeGreaterThanOrEqual(b.zMin);
        expect(homeZ).toBeLessThanOrEqual(b.zMax);
      }
    }
  });
});
