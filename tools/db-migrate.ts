import { Client } from "pg";

// Apply a SQL migration directly to the live FootRank database.
// Used only when the owner clicks "Okay" on a DB/security suggestion.
export async function applyMigration(sql: string): Promise<string> {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) return "SUPABASE_DB_URL not set — cannot apply DB changes.";
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    await client.query("begin");
    await client.query(sql);
    await client.query("commit");
    return "Migration applied successfully to the live database.";
  } catch (e) {
    try {
      await client.query("rollback");
    } catch {}
    return `DB error (rolled back): ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await client.end().catch(() => {});
  }
}
