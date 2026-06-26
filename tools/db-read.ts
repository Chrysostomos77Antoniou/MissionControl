import { Client } from "pg";

// Read-only window into the live FootRank database so agents can VERIFY the real
// state (RLS policies, tables, storage config) instead of guessing from the repo.
// Double-guarded: a SELECT/WITH-only regex plus a READ ONLY transaction.
export async function dbRead(sql: string): Promise<string> {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) return "SUPABASE_DB_URL not set — cannot inspect the live database.";

  const t = sql.trim().toLowerCase();
  if (!/^(select|with)\b/.test(t) || /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|copy)\b/.test(t)) {
    return "Only read-only SELECT/WITH queries are allowed.";
  }

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    await client.query("begin");
    await client.query("set transaction read only");
    const res = await client.query(sql);
    await client.query("commit");
    const rows = res.rows.slice(0, 50);
    const out = JSON.stringify(rows, null, 1);
    return out.length > 6000 ? out.slice(0, 6000) + "\n…(truncated)" : out;
  } catch (e) {
    try {
      await client.query("rollback");
    } catch {}
    return `DB read error: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await client.end().catch(() => {});
  }
}
