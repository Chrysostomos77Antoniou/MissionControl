import { supabaseAdmin } from "./supabase";
import type { AgentId, Approval } from "./types";

export async function queueApproval(input: {
  agent: AgentId;
  action_type: string;
  payload: Record<string, unknown>;
  preview: string;
}): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("approvals")
    .insert({ ...input, status: "pending" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

export async function listPending(): Promise<Approval[]> {
  const { data } = await supabaseAdmin
    .from("approvals")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  return (data ?? []) as Approval[];
}

export async function pendingCount(): Promise<number> {
  const { count } = await supabaseAdmin
    .from("approvals")
    .select("*", { count: "exact", head: true })
    .eq("status", "pending");
  return count ?? 0;
}

export async function resolveApproval(
  id: string,
  status: "approved" | "rejected",
  reason?: string,
): Promise<Approval> {
  const { data, error } = await supabaseAdmin
    .from("approvals")
    .update({ status, rejection_reason: reason ?? null, resolved_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data as Approval;
}
