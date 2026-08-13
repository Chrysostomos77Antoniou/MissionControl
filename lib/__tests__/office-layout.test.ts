import { describe, expect, it } from "vitest";
import { AGENTS } from "../../agents/registry";
import {
  AGENT_DEPARTMENT,
  CHATTER_RANGE_SQ,
  DEPARTMENT_META,
  departmentAgents,
  shouldChatter,
} from "../office-layout";

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
