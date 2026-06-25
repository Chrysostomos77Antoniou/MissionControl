import { supabaseAdmin } from "./supabase";
import type { AgentId, Suggestion } from "./types";

export async function saveSuggestion(input: {
  agent: AgentId;
  category: string;
  title: string;
  body: string;
  priority: "low" | "medium" | "high";
  publishable?: boolean;
  platform?: string;
  post_text?: string;
}): Promise<void> {
  await supabaseAdmin.from("suggestions").insert({
    ...input,
    publishable: input.publishable ?? false,
  });
}

export async function listSuggestions(
  status: "new" | "done" | "dismissed" | "published" = "new",
): Promise<Suggestion[]> {
  const { data } = await supabaseAdmin
    .from("suggestions")
    .select("*")
    .eq("status", status)
    .order("created_at", { ascending: false });
  return (data ?? []) as Suggestion[];
}

export async function getSuggestion(id: string): Promise<Suggestion | null> {
  const { data } = await supabaseAdmin.from("suggestions").select("*").eq("id", id).single();
  return (data as Suggestion) ?? null;
}

export async function updateSuggestion(
  id: string,
  status: "new" | "done" | "dismissed" | "published",
): Promise<void> {
  await supabaseAdmin.from("suggestions").update({ status }).eq("id", id);
}
