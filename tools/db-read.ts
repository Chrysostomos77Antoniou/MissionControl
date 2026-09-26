import { checkReadOnlySql } from "../lib/sql-guard";
import { redactValue } from "../lib/redact";

// Read-only window into the live FootRank database for agents (Phase 1 safety).
//
// 1. lib/sql-guard.ts validates the statement (single SELECT/WITH, allowlisted
//    functions, no protected schemas, no personal columns on app data).
// 2. It executes via the Management API's READ-ONLY endpoint, which runs as
//    `supabase_read_only_user` in a read-only transaction — the database
//    itself rejects any write (verified live: SQLSTATE 25006).
// 3. The result is capped and personal-data / secret patterns are redacted.
//
// There is intentionally no write path: the old apply_db_migration tool was
// removed. Schema changes are proposed as migration files in a pull request.
const READ_ONLY_ENDPOINT = (ref: string) => `https://api.supabase.com/v1/projects/${encodeURIComponent(ref)}/database/query/read-only`;

export async function dbRead(sql: string): Promise<string> {
  const ref = process.env.SUPABASE_PROJECT_REF;
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!ref || !token) return "SUPABASE_PROJECT_REF / SUPABASE_ACCESS_TOKEN not set — cannot inspect the live database.";

  const verdict = checkReadOnlySql(sql);
  if (!verdict.ok) return `Query rejected by the read-only guard: ${verdict.reason}. Nothing was executed.`;

  try {
    const res = await fetch(READ_ONLY_ENDPOINT(ref), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: verdict.sql }),
    });
    if (!res.ok) return `DB read error ${res.status}: ${String(redactValue((await res.text()).slice(0, 200)))}`;
    const data = (await res.json()) as unknown;
    const rows = Array.isArray(data) ? data.slice(0, 50) : data;
    const safe = redactValue(rows, { maskKeys: verdict.kind === "data", maskUuids: verdict.kind === "data" });
    const out = JSON.stringify(safe, null, 1);
    return out.length > 6000 ? out.slice(0, 6000) + "\n…(truncated)" : out;
  } catch (e) {
    return `DB read error: ${e instanceof Error ? e.message : String(e)}`;
  }
}
