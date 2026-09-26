import { describe, it, expect } from "vitest";
import { offeredToolNames, isToolOffered } from "../tool-guard";

describe("tool-guard", () => {
  const offered = offeredToolNames([{ name: "db_read" }, { name: "save_suggestion" }]);
  it("accepts offered tools only", () => {
    expect(isToolOffered("db_read", offered)).toBe(true);
    expect(isToolOffered("apply_db_migration", offered)).toBe(false);
    expect(isToolOffered("DB_READ", offered)).toBe(false);
    expect(isToolOffered(undefined as unknown as string, offered)).toBe(false);
  });
});
