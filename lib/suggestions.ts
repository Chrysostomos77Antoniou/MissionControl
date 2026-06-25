import { supabaseAdmin } from "./supabase";
import type { AgentId, Suggestion } from "./types";

export async function saveSuggestion(input: {
  agent: AgentId;
  category: string;
  title: string;
  body: string;
  priority: "low" | "medium" | "high";
}): Promise<void> {
  await supabaseAdmin.from("suggestions").insert(input);
}

export async function listSuggestions(status: "new" | "done" | "dismissed" = "new"): Promise<Suggestion[]> {
  const { data } = await supabaseAdmin
    .from("suggestions")
    .select("*")
    .eq("status", status)
    .order("created_at", { ascending: false });
  return (data ?? []) as Suggestion[];
}

export async function updateSuggestion(
  id: string,
  status: "new" | "done" | "dismissed",
): Promise<void> {
  await supabaseAdmin.from("suggestions").update({ status }).eq("id", id);
}
