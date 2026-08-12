import { describe, expect, it } from "vitest";
import { computeApprovalRate } from "../suggestions";

describe("computeApprovalRate", () => {
  it("returns the fraction approved when both counts are positive", () => {
    expect(computeApprovalRate(3, 1)).toBe(0.75);
  });

  it("returns 1 when everything was approved", () => {
    expect(computeApprovalRate(5, 0)).toBe(1);
  });

  it("returns 0 when everything was dismissed", () => {
    expect(computeApprovalRate(0, 5)).toBe(0);
  });

  it("returns null instead of dividing by zero when nothing has been decided yet", () => {
    expect(computeApprovalRate(0, 0)).toBeNull();
  });
});
