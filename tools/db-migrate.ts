// Apply a SQL migration to the live FootRank database via the Supabase
// Management API + a personal access token (no database password needed).
// Used only when the owner clicks "Okay" on a DB/security suggestion.
export async function applyMigration(sql: string): Promise<string> {
  const ref = process.env.SUPABASE_PROJECT_REF;
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!ref || !token) return "SUPABASE_PROJECT_REF / SUPABASE_ACCESS_TOKEN not set — cannot apply DB changes.";

  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql }),
    });
    if (!res.ok) return `DB error ${res.status}: ${(await res.text()).slice(0, 250)}`;
    return "Migration applied successfully to the live database.";
  } catch (e) {
    return `DB error: ${e instanceof Error ? e.message : String(e)}`;
  }
}
