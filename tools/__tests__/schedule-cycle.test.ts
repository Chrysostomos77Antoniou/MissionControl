import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const script = readFileSync(join(ROOT, "tools", "schedule-cycle.ps1"), "utf8");
const [header, body] = script.split("#>");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const workflow = readFileSync(join(ROOT, ".github", "workflows", "mc-cycle.yml"), "utf8");

describe("local scheduler script", () => {
  it("calls only the local cycle endpoint with a validated group", () => {
    expect(body).toMatch(/http:\/\/127\.0\.0\.1:3000\/api\/cycle\?group=\$Group/);
    expect(body).toMatch(/ValidateSet\("4h", "daily", "5day"\)/);
    expect(body.match(/https?:\/\/[^\s"']+/g)).toEqual(["http://127.0.0.1:3000/api/cycle?group=$Group"]);
  });

  it("contains no secret: it reads MC_CRON_SECRET or .env.local at run time and never prints it", () => {
    expect(script).toMatch(/MC_CRON_SECRET/);
    expect(script).toMatch(/CRON_SECRET/);
    expect(body).not.toMatch(/\$secret\s*=\s*["']/); // no literal secret assignment
    expect(body).not.toMatch(/Write-(Output|Host|Error)[^\n]*\$secret/);
    expect(script).not.toMatch(/Bearer [A-Za-z0-9._~+/=-]{8,}/); // no literal bearer token
    expect(script).not.toMatch(/(sk-|ghp_|github_pat_|AIza|sbp_|eyJ)[A-Za-z0-9_-]{10,}/);
  });

  it("does not register a scheduled task when run (registration is documented, done by the user)", () => {
    expect(header).toMatch(/Register-ScheduledTask/);
    expect(body).not.toMatch(/Register-ScheduledTask|New-ScheduledTask|schtasks/i);
  });
});

describe("docs + workflow", () => {
  it("README documents the local-only schedule, auth, change detection, 7-day age and manual runs", () => {
    for (const phrase of [
      /local only/i,
      /Windows Task Scheduler/,
      /must be running/i,
      /CRON_SECRET/,
      /no baseline → the agent runs/,
      /change detection/i,
      /7-day maximum age/i,
      /Manual runs[^\n]*skip change detection only/,
    ])
      expect(readme).toMatch(phrase);
  });

  it("the GitHub cycle workflow no longer has a scheduled trigger", () => {
    expect(workflow).not.toMatch(/^\s*schedule:/m);
    expect(workflow).not.toMatch(/cron:/);
    expect(workflow).toMatch(/workflow_dispatch:/);
  });
});
