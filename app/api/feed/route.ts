import { NextResponse } from "next/server";
import { supabaseAdmin } from "../../../lib/supabase";

export async function GET() {
  const { data } = await supabaseAdmin
    .from("activity_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);
  return NextResponse.json(data ?? []);
}
