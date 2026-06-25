import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import type { Approval } from "./types";

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
  if (platform !== "facebook") {
    return {
      ok: false,
      detail: `${platform} requires a media file (image/video), which the agent only drafts as text. Use this draft to post manually.`,
    };
  }
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
