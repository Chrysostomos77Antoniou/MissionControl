import { supabaseAdmin } from "./supabase";

const BUCKET = "mc-media";

// Upload bytes to the public mc-media bucket and return a publicly-fetchable
// URL — required because Instagram's Graph API fetches the image by URL.
export async function uploadPublic(
  bytes: Buffer,
  contentType: string,
  ext: string,
): Promise<string> {
  const path = `instagram/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType, upsert: true });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}
