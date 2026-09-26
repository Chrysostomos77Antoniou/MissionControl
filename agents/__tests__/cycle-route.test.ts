import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { runScheduledCycle, runManual } = vi.hoisted(() => ({ runScheduledCycle: vi.fn(), runManual: vi.fn() }));
vi.mock("../cycle", () => ({ runScheduledCycle, runManual, SCHEDULED_GROUPS: ["hourly", "4h", "daily", "5day"] }));

import { POST } from "../../app/api/cycle/route";

const SECRET = ["route", "test", "value", "7"].join("-");
const req = (group: string, auth?: string) =>
  new NextRequest(`http://127.0.0.1:3000/api/cycle?group=${group}`, { method: "POST", headers: auth === undefined ? {} : { authorization: auth } });

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CRON_SECRET;
  runScheduledCycle.mockReset().mockResolvedValue({ status: "completed", mode: "scheduled", group: "4h", agents: [{ agent: "engineering", outcome: "skipped-no-change", reason: "unchanged" }] });
  runManual.mockReset().mockResolvedValue({ status: "completed", mode: "manual", agents: [{ agent: "growth", outcome: "ran-ok", reason: "manual", text: "model output" }] });
});
afterEach(() => {
  if (saved === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = saved;
});

describe("/api/cycle authentication (fails closed)", () => {
  it("missing CRON_SECRET -> 401 even for 'Bearer undefined'; nothing runs", async () => {
    delete process.env.CRON_SECRET;
    for (const h of ["Bearer undefined", "Bearer ", undefined]) {
      const r = await POST(req("4h", h));
      expect(r.status).toBe(401);
    }
    expect(runScheduledCycle).not.toHaveBeenCalled();
  });

  it("empty or blank CRON_SECRET -> 401", async () => {
    for (const s of ["", "   "]) {
      process.env.CRON_SECRET = s;
      expect((await POST(req("4h", "Bearer "))).status).toBe(401);
      expect((await POST(req("4h", `Bearer ${s}`))).status).toBe(401);
    }
    expect(runScheduledCycle).not.toHaveBeenCalled();
  });

  it("wrong or missing token -> 401", async () => {
    process.env.CRON_SECRET = SECRET;
    expect((await POST(req("4h", "Bearer wrong"))).status).toBe(401);
    expect((await POST(req("4h"))).status).toBe(401);
    expect(runScheduledCycle).not.toHaveBeenCalled();
  });

  it("correct token -> runs the scheduled cycle for that group", async () => {
    process.env.CRON_SECRET = SECRET;
    const r = await POST(req("daily", `Bearer ${SECRET}`));
    expect(r.status).toBe(200);
    expect(runScheduledCycle).toHaveBeenCalledWith("daily");
    expect((await r.json()).status).toBe("completed");
  });

  it("an agent id is an explicit single-agent run; model output is not returned", async () => {
    process.env.CRON_SECRET = SECRET;
    const r = await POST(req("growth", `Bearer ${SECRET}`));
    expect(runManual).toHaveBeenCalledWith(["growth"]);
    const body = await r.json();
    expect(body.agents[0]).toEqual({ agent: "growth", outcome: "ran-ok", reason: "manual" });
  });

  it("invalid group -> 400 without echoing input; 'ondemand' is not a scheduled group", async () => {
    process.env.CRON_SECRET = SECRET;
    for (const g of ["ondemand", "bogus"]) {
      const r = await POST(req(g, `Bearer ${SECRET}`));
      expect(r.status).toBe(400);
      expect(JSON.stringify(await r.json())).not.toContain(g);
    }
  });

  it("no response ever contains the secret", async () => {
    process.env.CRON_SECRET = SECRET;
    for (const r of [await POST(req("4h", `Bearer ${SECRET}`)), await POST(req("4h", "Bearer wrong")), await POST(req("growth", `Bearer ${SECRET}`))]) {
      expect(await r.text()).not.toContain(SECRET);
    }
  });
});
