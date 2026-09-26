import { describe, it, expect } from "vitest";
import { checkFixPath, validateFixFiles } from "../fix-paths";

describe("checkFixPath", () => {
  it("allows ordinary source files", () => {
    expect(checkFixPath("lib/features/match/match_screen.dart")).toEqual({ ok: true, isMigration: false });
    expect(checkFixPath("test/match_test.dart").ok).toBe(true);
  });
  it("allows a correctly named NEW migration file", () => {
    expect(checkFixPath("supabase/migrations/20260926120000_tighten_matches_rls.sql")).toEqual({ ok: true, isMigration: true });
  });
  it.each([
    ".github/workflows/integration.yml",
    ".env",
    ".env.production",
    "android/app/upload-keystore.jks",
    "android/key.properties",
    "android/app/google-services.json",
    "ios/Runner/GoogleService-Info.plist",
    "certs/server.pem",
    "service-account.json",
    "supabase/config.toml",
    "../outside.dart",
    "/etc/passwd",
    "C:/Windows/x",
    "lib\\\\main.dart",
    "supabase/migrations/fix.sql",
    "supabase/migrations/20260926_fix.sql",
  ])("rejects %s", (p) => expect(checkFixPath(p).ok).toBe(false));
});

describe("validateFixFiles", () => {
  it("returns files and lists migrations", () => {
    const r = validateFixFiles([
      { path: "lib/a.dart", content: "x" },
      { path: "supabase/migrations/20260926120000_add_index.sql", content: "create index if not exists i on public.m(x);" },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.migrations).toEqual(["supabase/migrations/20260926120000_add_index.sql"]);
  });
  it("rejects the whole batch if any file is protected", () => {
    const r = validateFixFiles([{ path: "lib/a.dart", content: "x" }, { path: ".github/workflows/ci.yml", content: "x" }]);
    expect(r.ok).toBe(false);
  });
  it("rejects empty / malformed input", () => {
    expect(validateFixFiles([]).ok).toBe(false);
    expect(validateFixFiles(undefined).ok).toBe(false);
    expect(validateFixFiles([{ path: "lib/a.dart" }]).ok).toBe(false);
  });
});
