import { describe, it, expect, vi } from "vitest";

vi.mock("../supabase", () => {
  const insert = vi.fn(() => ({
    select: () => ({ single: () => ({ data: { id: "abc" }, error: null }) }),
  }));
  return { supabaseAdmin: { from: () => ({ insert }) } };
});

import { queueApproval } from "../approvals";

describe("queueApproval", () => {
  it("returns the new approval id", async () => {
    const id = await queueApproval({
      agent: "marketing",
      action_type: "social_post",
      payload: { platform: "tiktok", text: "hi" },
      preview: "TikTok: hi",
    });
    expect(id).toBe("abc");
  });
});
