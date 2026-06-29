import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";

const run = promisify(exec);

export const maxDuration = 600;

// Builds + installs the FootRank app onto the connected phone via `flutter
// install`. FIRST syncs the local repo to GitHub's master, so any fixes the QA
// loop merged via "push live" are actually included in the build — otherwise the
// phone gets stale local code (the merge lives on GitHub, the build reads local).
// Runs on the owner's machine (needs flutter + adb + git + a connected device).
// FOOTRANK_PATH points at the app repo.
export async function POST() {
  const cwd = process.env.FOOTRANK_PATH || "C:\\Projects\\footrank";
  try {
    // 1. Pull merged changes from GitHub master before building.
    let syncOut = "";
    try {
      const sync = await run(
        "git fetch origin --quiet && git checkout master && git pull --ff-only origin master",
        { cwd, timeout: 120000 },
      );
      syncOut = (sync.stdout + "\n" + sync.stderr).trim();
    } catch (e) {
      const msg =
        e instanceof Error
          ? (e as Error & { stderr?: string }).stderr || e.message
          : String(e);
      return NextResponse.json({
        ok: false,
        detail:
          "Could not sync with GitHub master before building (commit or stash local changes first):\n" +
          String(msg).slice(-1200),
      });
    }

    // 2. Build + install the freshly-synced master onto the connected phone.
    const { stdout, stderr } = await run("flutter install", {
      cwd,
      timeout: 570000,
    });
    const out = (stdout + "\n" + stderr).trim();
    const ok =
      /installed|success/i.test(out) && !/no (devices|connected)/i.test(out);
    return NextResponse.json({
      ok,
      detail: (syncOut ? syncOut + "\n\n" : "") + out.slice(-1400),
    });
  } catch (e) {
    const msg =
      e instanceof Error
        ? (e as Error & { stderr?: string }).stderr || e.message
        : String(e);
    return NextResponse.json({ ok: false, detail: String(msg).slice(-1500) });
  }
}
