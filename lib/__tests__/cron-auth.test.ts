import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isCronAuthorized } from "../cron-auth";

const SECRET = ["cycle", "test", "value", "42"].join("-"); // built at runtime: not a real secret

describe("CRON_SECRET bearer check (fails closed)", () => {
  it.each([
    ["missing secret", "Bearer undefined", undefined],
    ["missing secret, no header", null, undefined],
    ["null secret", "Bearer null", null],
    ["empty secret", "Bearer ", ""],
    ["blank secret", "Bearer    ", "   "],
    ["empty secret vs any token", "Bearer anything", ""],
  ])("%s -> rejected", (_l, header, secret) => {
    expect(isCronAuthorized(header, secret)).toBe(false);
  });

  it.each([
    ["no header", null],
    ["empty header", ""],
    ["empty bearer", "Bearer "],
    ["blank bearer", "Bearer    "],
    ["wrong token", "Bearer nope"],
    ["prefix of the secret", `Bearer ${SECRET.slice(0, -1)}`],
    ["secret plus extra", `Bearer ${SECRET}x`],
    ["no Bearer scheme", SECRET],
    ["other scheme", `Basic ${SECRET}`],
    ["lowercase scheme", `bearer ${SECRET}`],
  ])("%s -> rejected", (_l, header) => {
    expect(isCronAuthorized(header, SECRET)).toBe(false);
  });

  it("the correct token is accepted", () => {
    expect(isCronAuthorized(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it("uses a constant-time comparison from node:crypto (no dependency)", () => {
    const src = readFileSync(join(__dirname, "..", "cron-auth.ts"), "utf8");
    expect(src).toMatch(/timingSafeEqual/);
    expect(src).toMatch(/from "node:crypto"/);
  });
});
