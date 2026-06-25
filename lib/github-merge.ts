// Merge an open PR (commit + push to the base branch) after checking CI status.
const API = "https://api.github.com";

function h(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "footrank-mission-control",
  };
}

export interface FinalizeResult {
  ok: boolean;
  detail: string;
}

export async function finalizePr(prUrl: string): Promise<FinalizeResult> {
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) return { ok: false, detail: "GITHUB_REPO / GITHUB_TOKEN not set." };

  const m = prUrl.match(/\/pull\/(\d+)/);
  if (!m) return { ok: false, detail: `Could not parse a PR number from ${prUrl}.` };
  const number = m[1];

  // 1. Fetch PR state.
  const prRes = await fetch(`${API}/repos/${repo}/pulls/${number}`, { headers: h(token) });
  if (!prRes.ok) return { ok: false, detail: `GitHub PR ${prRes.status}: ${(await prRes.text()).slice(0, 150)}` };
  const pr = (await prRes.json()) as {
    head: { sha: string };
    merged: boolean;
    mergeable: boolean | null;
    mergeable_state: string;
  };
  if (pr.merged) return { ok: true, detail: "PR is already merged." };

  // 2. Check CI status ("test if everything is okay").
  const checkRes = await fetch(`${API}/repos/${repo}/commits/${pr.head.sha}/check-runs`, { headers: h(token) });
  if (checkRes.ok) {
    const data = (await checkRes.json()) as {
      check_runs: { name: string; status: string; conclusion: string | null }[];
    };
    const runs = data.check_runs ?? [];
    const failed = runs.filter((r) => ["failure", "timed_out", "cancelled", "action_required"].includes(r.conclusion ?? ""));
    const pending = runs.filter((r) => r.status !== "completed");
    if (failed.length > 0) {
      return { ok: false, detail: `Tests failing — not merged: ${failed.map((r) => r.name).join(", ")}. Fix and retry.` };
    }
    if (pending.length > 0) {
      return { ok: false, detail: `Tests still running (${pending.map((r) => r.name).join(", ")}). Try again shortly.` };
    }
  }
  // (No check runs configured = nothing to fail; proceed to merge.)

  if (pr.mergeable === false) {
    return { ok: false, detail: `PR has conflicts (state: ${pr.mergeable_state}). Resolve them, then retry.` };
  }

  // 3. Merge (commit + push to base).
  const mergeRes = await fetch(`${API}/repos/${repo}/pulls/${number}/merge`, {
    method: "PUT",
    headers: h(token),
    body: JSON.stringify({ merge_method: "squash" }),
  });
  if (!mergeRes.ok) return { ok: false, detail: `Merge ${mergeRes.status}: ${(await mergeRes.text()).slice(0, 150)}` };
  return { ok: true, detail: `Merged PR #${number} to the base branch.` };
}
