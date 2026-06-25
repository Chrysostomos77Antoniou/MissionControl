import type { Suggestion } from "./types";

export interface PublishResult {
  ok: boolean;
  detail: string;
}

// Publish a marketing suggestion. Only text platforms (Facebook) can auto-post;
// media platforms return guidance to post manually from the draft.
export async function publishSuggestion(s: Suggestion): Promise<PublishResult> {
  if (!s.publishable || !s.post_text) {
    return { ok: false, detail: "This suggestion is not a ready-to-publish post." };
  }
  const platform = (s.platform ?? "").toLowerCase();
  if (platform === "facebook") return publishFacebook(s.post_text);
  return {
    ok: false,
    detail: `${platform || "this platform"} needs a media file (image/video). Use the draft to post manually.`,
  };
}

async function publishFacebook(text: string): Promise<PublishResult> {
  const pageId = process.env.FACEBOOK_PAGE_ID;
  const token = process.env.FACEBOOK_ACCESS_TOKEN;
  if (!pageId || !token) {
    return { ok: false, detail: "FACEBOOK_PAGE_ID / FACEBOOK_ACCESS_TOKEN not set in .env.local." };
  }
  const res = await fetch(`https://graph.facebook.com/v21.0/${pageId}/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: text, access_token: token }),
  });
  if (!res.ok) return { ok: false, detail: `Facebook ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const data = (await res.json()) as { id: string };
  return { ok: true, detail: `Published to Facebook (id ${data.id}).` };
}
