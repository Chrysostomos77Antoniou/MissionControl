// Side-effect-free (no Supabase client, no server secrets) so client
// components (AgentDeck) can import the same tool->color mapping
// lib/agent-status.ts uses server-side, without pulling supabaseAdmin's
// service-role key into the browser bundle — same reasoning as the
// lib/models.ts / lib/anthropic.ts split (see that file's comment).
export const TOOL_VISUAL: Record<string, { color: number; label: string }> = {
  web_search: { color: 0x22d3ee, label: "search" },
  read_footrank_stats: { color: 0x22d3ee, label: "stats" },
  db_read: { color: 0x3b82f6, label: "db" },
  list_repo: { color: 0xa855f7, label: "repo" },
  read_repo_file: { color: 0xa855f7, label: "repo" },
  save_suggestion: { color: 0x22c55e, label: "inbox" },
  submit_fix: { color: 0xf97316, label: "pr" },
};

export const DEFAULT_TOOL_VISUAL = { color: 0xffaa00, label: "working" };
