import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import type { Approval } from "./types";
import { generateImage } from "./image";
import { uploadPublic } from "./storage";

export interface ExecResult {
  ok: boolean;
  detail: string;
}

export async function executeApproval(approval: Approval): Promise<ExecResult> {
  try {
    switch (approval.action_type) {
      case "github_action":
        return await execGithub(approval.payload);
      case "push_notification":
        return await execPush(approval.payload);
      case "social_post":
        return await execSocial(approval.payload);
      default:
        return { ok: false, detail: `No actuator for action type "${approval.action_type}".` };
    }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

async function execGithub(p: Record<string, unknown>): Promise<ExecResult> {
  const kind = String(p.kind);
  if (kind !== "issue") {
    return { ok: false, detail: "Only GitHub issues are auto-created; a PR needs a branch + diff. Create it manually." };
  }
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) return { ok: false, detail: "GITHUB_REPO / GITHUB_TOKEN not set in .env.local." };

  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "footrank-mission-control",
    },
    body: JSON.stringify({ title: String(p.title), body: String(p.body) }),
  });
  if (!res.ok) return { ok: false, detail: `GitHub ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const data = (await res.json()) as { html_url: string };
  return { ok: true, detail: `Created issue ${data.html_url}` };
}

async function execSocial(p: Record<string, unknown>): Promise<ExecResult> {
  const platform = String(p.platform);
  if (platform === "facebook") return execFacebook(p);
  if (platform === "instagram") return execInstagram(p);
  return {
    ok: false,
    detail: `${platform} requires a video file, which the agent only drafts as a script. Use this draft to post manually.`,
  };
}

async function execFacebook(p: Record<string, unknown>): Promise<ExecResult> {
  const pageId = process.env.FACEBOOK_PAGE_ID;
  const token = process.env.FACEBOOK_ACCESS_TOKEN;
  if (!pageId || !token) return { ok: false, detail: "FACEBOOK_PAGE_ID / FACEBOOK_ACCESS_TOKEN not set in .env.local." };

  const res = await fetch(`https://graph.facebook.com/v21.0/${pageId}/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: String(p.text), access_token: token }),
  });
  if (!res.ok) return { ok: false, detail: `Facebook ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const data = (await res.json()) as { id: string };
  return { ok: true, detail: `Posted to Facebook (id ${data.id}).` };
}

async function execInstagram(p: Record<string, unknown>): Promise<ExecResult> {
  const igUserId = process.env.INSTAGRAM_USER_ID;
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!igUserId || !token) {
    return { ok: false, detail: "INSTAGRAM_USER_ID / INSTAGRAM_ACCESS_TOKEN not set in .env.local." };
  }

  // 1. Generate an image from the agent's media hint (falling back to the caption).
  const caption = String(p.text);
  const hint = p.media_hint ? String(p.media_hint) : caption;
  const prompt = `${hint}. Vibrant, high-quality square social media image for FootRank, a football (soccer) ranking & match-tracking app. No text overlay, no watermark.`;
  const { bytes, contentType } = await generateImage(prompt);

  // 2. Host it publicly so Instagram's API can fetch it by URL.
  const imageUrl = await uploadPublic(bytes, contentType, "webp");

  // 3. Create a media container.
  const containerRes = await fetch(`https://graph.facebook.com/v21.0/${igUserId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_url: imageUrl, caption, access_token: token }),
  });
  if (!containerRes.ok) {
    return { ok: false, detail: `Instagram container ${containerRes.status}: ${(await containerRes.text()).slice(0, 200)}` };
  }
  const container = (await containerRes.json()) as { id: string };

  // 4. Publish the container.
  const publishRes = await fetch(`https://graph.facebook.com/v21.0/${igUserId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creation_id: container.id, access_token: token }),
  });
  if (!publishRes.ok) {
    return { ok: false, detail: `Instagram publish ${publishRes.status}: ${(await publishRes.text()).slice(0, 200)}` };
  }
  const published = (await publishRes.json()) as { id: string };
  return { ok: true, detail: `Posted to Instagram (media ${published.id}).` };
}

function ensureFirebase() {
  if (getApps().length) return;
  const json = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!json) throw new Error("FIREBASE_SERVICE_ACCOUNT not set in .env.local.");
  initializeApp({ credential: cert(JSON.parse(json)) });
}

async function execPush(p: Record<string, unknown>): Promise<ExecResult> {
  ensureFirebase();
  // Broadcast to an FCM topic derived from the audience. Users must be
  // subscribed to that topic in the FootRank app; "all" is the safe default.
  const audience = String(p.audience ?? "all");
  const topic = audience.toLowerCase().replace(/[^a-z0-9_.~%-]/g, "_").slice(0, 80) || "all";
  const id = await getMessaging().send({
    topic,
    notification: { title: String(p.title), body: String(p.body) },
  });
  return { ok: true, detail: `Sent push to topic "${topic}" (message ${id}).` };
}
