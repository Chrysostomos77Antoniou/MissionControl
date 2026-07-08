import { NextRequest, NextResponse } from "next/server";
import { notify } from "../../../../lib/notify";

export const maxDuration = 30;

function captainLine(teamName: string, name: string | null, phone: string | null, email: string | null): string {
  const who = name ?? "captain not on file";
  const contact = [phone ?? "no phone on file", email ?? "no email on file"].join(" · ");
  return `${teamName}: ${who} (${contact})`;
}

// Called directly from Postgres (pg_net, inside accept_match_request()) the
// moment a match's suggested court resolves — this is the signal that a real
// phone call needs to happen now. Guarded by the same CRON_SECRET already
// used for /api/cycle, since this is also a trusted-server-to-server call,
// not something a browser should hit.
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
  const homeTeam = body.home_team ?? "Home";
  const awayTeam = body.away_team ?? "Away";
  const courtPhone = body.court_phone ?? "no phone on file";

  const lines = [
    `📞 Book a court: ${homeTeam} vs ${awayTeam}`,
    `${body.city ?? "?"} · ${when}`,
    "",
    captainLine(homeTeam, body.home_captain_name, body.home_captain_phone, body.home_captain_email),
    captainLine(awayTeam, body.away_captain_name, body.away_captain_phone, body.away_captain_email),
    "",
    `Court: ${body.court_name ?? "unknown court"} (${courtPhone})`,
  ];
  if (body.court_address) lines.push(body.court_address);

  await notify(lines.join("\n"));

  return NextResponse.json({ ok: true });
}
