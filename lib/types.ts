export type AgentId = "marketing" | "growth" | "content";

export interface Approval {
  id: string;
  agent: AgentId;
  action_type: string;
  payload: Record<string, unknown>;
  preview: string;
  status: "pending" | "approved" | "rejected";
  rejection_reason: string | null;
  created_at: string;
  resolved_at: string | null;
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

export interface ContentDraft {
  id: string;
  agent: AgentId;
  type: string;
  title: string;
  body: string;
  status: "draft" | "approved" | "used";
  created_at: string;
}
