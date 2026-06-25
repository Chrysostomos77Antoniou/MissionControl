export type AgentId =
  | "cybersecurity"
  | "engineering"
  | "developer"
  | "qa"
  | "uxdesign"
  | "marketing"
  | "growth"
  | "data"
  | "community"
  | "competitive"
  | "monetization";

export type Cadence = "hourly" | "4h" | "daily" | "5day" | "ondemand";

export interface Suggestion {
  id: string;
  agent: AgentId;
  category: string | null;
  title: string;
  body: string;
  priority: "low" | "medium" | "high";
  status: "new" | "done" | "dismissed";
  result: string | null;
  pr_url: string | null;
  outcome: "fixed" | "action_needed" | null;
  qa_status: "testing" | "fixing" | "passed" | "needs_owner" | null;
  qa_branch: string | null;
  qa_run_id: string | null;
  qa_attempts: number;
  qa_log: string | null;
  created_at: string;
}

export interface ActivityEntry {
  id: string;
  agent: AgentId;
  action: string;
  detail: string | null;
  created_at: string;
}

export interface MemoryEntry {
  id: string;
  agent: AgentId;
  cycle_at: string;
  summary: string;
  created_at: string;
}
