// Read-only window into the live FootRank database, via the Supabase Management
// API + a personal access token (no database password needed). Guarded to
// SELECT/WITH only so agents can inspect but never mutate through this tool.
export async function dbRead(sql: string): Promise<string> {
  const ref = process.env.SUPABASE_PROJECT_REF;
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!ref || !token) return "SUPABASE_PROJECT_REF / SUPABASE_ACCESS_TOKEN not set — cannot inspect the live database.";

  const t = sql.trim().toLowerCase();
  if (!/^(select|with)\b/.test(t) || /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|copy)\b/.test(t)) {
    return "Only read-only SELECT/WITH queries are allowed.";
  }

  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql }),
    });
    if (!res.ok) return `DB read error ${res.status}: ${(await res.text()).slice(0, 200)}`;
    const data = (await res.json()) as unknown;
    const rows = Array.isArray(data) ? data.slice(0, 50) : data;
    const out = JSON.stringify(rows, null, 1);
    return out.length > 6000 ? out.slice(0, 6000) + "\n…(truncated)" : out;
  } catch (e) {
    return `DB read error: ${e instanceof Error ? e.message : String(e)}`;
  }
}
