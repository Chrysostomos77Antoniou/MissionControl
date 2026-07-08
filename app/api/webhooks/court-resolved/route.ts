import { NextRequest, NextResponse } from "next/server";
import { notify } from "../../../../lib/notify";

export const maxDuration = 30;

// Called directly from Postgres (pg_net, inside submit_court_picks()) the
// moment both captains' ranked court picks resolve to a suggested court —
// this is the signal that a real phone call needs to happen now. Guarded by
// the same CRON_SECRET already used for /api/cycle, since this is also a
// trusted-server-to-server call, not something a browser should hit.
export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (!body?.match_id) {
    return NextResponse.json({ error: "missing match_id" }, { status: 400 });
  }

  const when = body.scheduled_at
    ? new Date(body.scheduled_at).toLocaleString("en-GB", { timeZone: "Asia/Nicosia" })
    : "an upcoming match";
  const phone = body.court_phone ? ` — call ${body.court_phone}` : " (no phone on file yet)";
  const lines = [
    `📞 Book a court: ${body.home_team ?? "?"} vs ${body.away_team ?? "?"} in ${body.city ?? "?"}`,
    `${when}`,
    `Suggested: ${body.court_name ?? "unknown court"}${body.court_address ? " — " + body.court_address : ""}${phone}`,
  ];
  await notify(lines.join("\n"));

  return NextResponse.json({ ok: true });
}
