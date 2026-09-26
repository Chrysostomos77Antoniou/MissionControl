import { describe, it, expect } from "vitest";
import { redactText, redactValue } from "../redact";

describe("redactText", () => {
  it("redacts emails, phone numbers and IPs", () => {
    const s = redactText("mail a.b+x@gmail.com call +357 99 123456 or 99123456 from 192.168.1.20");
    expect(s).not.toMatch(/gmail|99 123456|99123456|192\.168/);
    expect(s).toContain("[redacted-email]");
    expect(s).toContain("[redacted-phone]");
    expect(s).toContain("[redacted-ip]");
  });
  it("does not mangle dates, times or small counts", () => {
    expect(redactText("2026-09-26 12:00:00 — 16 users, 4 matches")).toBe("2026-09-26 12:00:00 — 16 users, 4 matches");
  });

  // Fake credentials are ASSEMBLED AT RUNTIME from split pieces, so this
  // source file never contains a contiguous key-shaped literal that GitHub
  // secret scanning / push protection could flag. The redactor still receives
  // full-shape values; the shape assertions below stop them being hollowed out.
  const join = (...parts: string[]) => parts.join("");
  const FAKE = {
    anthropic: join("sk", "-ant-", "TESTONLY", "x".repeat(20)),
    github: join("gh", "p_", "TESTONLY", "0".repeat(28)),
    google: join("AI", "za", "TESTONLY", "0".repeat(27)),
    jwt: join("ey", "J", "TESTONLYHEADER", ".", "ey", "J", "TESTONLYPAYLOAD", ".", "TESTONLYSIGNATURE"),
    bearer: join("TESTONLY", "b".repeat(20)),
  };

  it("builds fake credentials with the real key shapes", () => {
    expect(FAKE.anthropic).toMatch(/^sk-ant-[A-Za-z0-9_-]{16,}$/);
    expect(FAKE.github).toMatch(/^ghp_[A-Za-z0-9]{20,}$/);
    expect(FAKE.google).toMatch(/^AIza[0-9A-Za-z_-]{30,}$/);
    expect(FAKE.jwt).toMatch(/^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/);
  });

  it.each([
    ["Anthropic-style secret", () => FAKE.anthropic, "[redacted-secret]"],
    ["GitHub-style secret", () => FAKE.github, "[redacted-secret]"],
    ["Google-style secret", () => FAKE.google, "[redacted-secret]"],
    ["JWT-style token", () => FAKE.jwt, "[redacted-token]"],
  ] as const)("redacts a %s", (_label, value, placeholder) => {
    const out = redactText(`before ${value()} after`);
    expect(out).not.toContain(value());
    expect(out).toBe(`before ${placeholder} after`);
  });

  it("redacts all secret formats together, plus bearer tokens", () => {
    const all = [FAKE.anthropic, FAKE.github, FAKE.google, FAKE.jwt].join(" ") + ` Bearer ${FAKE.bearer}`;
    const out = redactText(all);
    for (const v of [FAKE.anthropic, FAKE.github, FAKE.google, FAKE.jwt, FAKE.bearer]) expect(out).not.toContain(v);
    expect(out).toContain("Bearer [redacted-token]");
  });

  it("masks UUIDs only when asked", () => {
    const id = "3f2b8c1e-9a4d-4e2f-8b7a-1c2d3e4f5a6b";
    expect(redactText(id)).toBe(id);
    expect(redactText(id, { maskUuids: true })).toBe("[id]");
  });
});

describe("redactValue", () => {
  it("masks personal keys for app-data results, recursively", () => {
    const v = redactValue([{ id: 1, display_name: "Chris", nested: { phone_number: "123", status: "ok" } }], { maskKeys: true });
    expect(v).toEqual([{ id: 1, display_name: "[redacted]", nested: { phone_number: "[redacted]", status: "ok" } }]);
  });
  it("keeps catalog keys like tablename/policyname when not masking keys", () => {
    const v = redactValue([{ tablename: "users", policyname: "users_select_own", name: "avatars" }]);
    expect(v).toEqual([{ tablename: "users", policyname: "users_select_own", name: "avatars" }]);
  });
});
