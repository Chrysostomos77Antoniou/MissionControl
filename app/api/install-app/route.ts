import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";

const run = promisify(exec);

export const maxDuration = 600;

// Builds + installs the FootRank app onto the connected phone via `flutter
// install`. Runs locally on the owner's machine (needs flutter + adb + a
// connected device). FOOTRANK_PATH points at the app repo.
export async function POST() {
  const cwd = process.env.FOOTRANK_PATH || "C:\\Projects\\footrank";
  try {
    const { stdout, stderr } = await run("flutter install", { cwd, timeout: 570000 });
    const out = (stdout + "\n" + stderr).trim();
    const ok = /installed|success/i.test(out) && !/no (devices|connected)/i.test(out);
    return NextResponse.json({ ok, detail: out.slice(-1500) });
  } catch (e) {
    const msg = e instanceof Error ? (e as Error & { stderr?: string }).stderr || e.message : String(e);
    return NextResponse.json({ ok: false, detail: String(msg).slice(-1500) });
  }
}
