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

    // 2. Build a FRESH release APK. `flutter install` on its own only builds
    //    when no APK exists — if a build fails or an old APK is present, it
    //    silently ships stale code. An explicit build surfaces compile errors
    //    and guarantees the phone gets the current source.
    //    The Supabase URL + anon key MUST be passed as --dart-define; without
    //    them the app falls back to the localhost placeholder backend and all
    //    sign-in / data calls fail (DNS_PROBE_FINISHED_NXDOMAIN).
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseAnonKey) {
      return NextResponse.json({
        ok: false,
        detail:
          (syncOut ? syncOut + "\n\n" : "") +
          "SUPABASE_URL / SUPABASE_ANON_KEY missing from Mission Control env — refusing to build, because the app would point at the localhost placeholder backend and sign-in would break. Add both to .env.local.",
      });
    }
    try {
      const build = await run(
        `flutter build apk --release --dart-define=SUPABASE_URL=${supabaseUrl} --dart-define=SUPABASE_ANON_KEY=${supabaseAnonKey}`,
        { cwd, timeout: 540000 },
      );
      const buildOut = (build.stdout + "\n" + build.stderr).trim();
      if (!/Built .*app-release\.apk/i.test(buildOut)) {
        return NextResponse.json({
          ok: false,
          detail:
            (syncOut ? syncOut + "\n\n" : "") +
            "Build did not produce an APK:\n" +
            buildOut.slice(-1400),
        });
      }
    } catch (e) {
      const msg =
        e instanceof Error
          ? (e as Error & { stderr?: string }).stderr || e.message
          : String(e);
      return NextResponse.json({
        ok: false,
        detail:
          (syncOut ? syncOut + "\n\n" : "") +
          "Release build FAILED (the phone was not updated):\n" +
          String(msg).slice(-1400),
      });
    }

    // 3. Install the freshly-built APK, then launch it on the device.
    const { stdout, stderr } = await run(
      "flutter install --use-application-binary build/app/outputs/flutter-apk/app-release.apk",
      { cwd, timeout: 180000 },
    );
    const out = (stdout + "\n" + stderr).trim();
    const ok =
      /installed|success/i.test(out) && !/no (devices|connected)/i.test(out);

    // Best-effort auto-launch (don't fail the request if adb isn't on PATH).
    let launched = false;
    if (ok) {
      try {
        const adb = process.env.ADB_PATH || "adb";
        await run(
          `"${adb}" shell monkey -p com.footballcy.footrank -c android.intent.category.LAUNCHER 1`,
          { cwd, timeout: 30000 },
        );
        launched = true;
      } catch {
        launched = false;
      }
    }

    return NextResponse.json({
      ok,
      detail:
        (syncOut ? syncOut + "\n\n" : "") +
        out.slice(-1200) +
        (ok ? (launched ? "\n\nLaunched on device." : "\n\nInstalled (open it manually).") : ""),
    });
  } catch (e) {
    const msg =
      e instanceof Error
        ? (e as Error & { stderr?: string }).stderr || e.message
        : String(e);
    return NextResponse.json({ ok: false, detail: String(msg).slice(-1500) });
  }
}
