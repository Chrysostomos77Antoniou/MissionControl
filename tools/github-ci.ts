// GitHub plumbing for the async QA loop: commit a fix to a qa/* branch (which
// auto-triggers the emulator workflow), read the run status/failure, then merge
// to master on go-live. No pull requests are created.
const API = "https://api.github.com";

function env() {
  return { repo: process.env.GITHUB_REPO, token: process.env.GITHUB_TOKEN };
}
function h(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "footrank-mission-control",
  };
}

export async function commitToBranch(
  branch: string,
  message: string,
  files: { path: string; content: string }[],
  base = "master",
): Promise<string> {
  const { repo, token } = env();
  if (!repo || !token) return "GITHUB_REPO / GITHUB_TOKEN not set.";
  if (!files?.length) return "No files to commit.";

  const refRes = await fetch(`${API}/repos/${repo}/git/ref/heads/${base}`, { headers: h(token) });
  if (!refRes.ok) return `base ref ${refRes.status}: ${(await refRes.text()).slice(0, 120)}`;
  const baseSha = ((await refRes.json()) as { object: { sha: string } }).object.sha;

  const cr = await fetch(`${API}/repos/${repo}/git/refs`, {
    method: "POST",
    headers: h(token),
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
  });
  if (!cr.ok && cr.status !== 422) return `create branch ${cr.status}: ${(await cr.text()).slice(0, 120)}`;

  for (const f of files) {
    let sha: string | undefined;
    const g = await fetch(`${API}/repos/${repo}/contents/${f.path}?ref=${branch}`, { headers: h(token) });
    if (g.ok) {
      const d = (await g.json()) as { sha?: string };
      if (!Array.isArray(d)) sha = d.sha;
    }
    const put = await fetch(`${API}/repos/${repo}/contents/${f.path}`, {
      method: "PUT",
      headers: h(token),
      body: JSON.stringify({
        message,
        content: Buffer.from(f.content, "utf-8").toString("base64"),
        branch,
        sha,
      }),
    });
    if (!put.ok) return `write ${f.path} ${put.status}: ${(await put.text()).slice(0, 120)}`;
  }
  return `Committed ${files.length} file(s) to ${branch}.`;
}

export async function latestRunId(branch: string): Promise<string | null> {
  const { repo, token } = env();
  if (!repo || !token) return null;
  const res = await fetch(`${API}/repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=1`, {
    headers: h(token),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { workflow_runs?: { id: number }[] };
  return data.workflow_runs?.[0]?.id?.toString() ?? null;
}

export async function runStatus(runId: string): Promise<{ status: string; conclusion: string | null }> {
  const { repo, token } = env();
  if (!repo || !token) return { status: "unknown", conclusion: null };
  const res = await fetch(`${API}/repos/${repo}/actions/runs/${runId}`, { headers: h(token) });
  if (!res.ok) return { status: "unknown", conclusion: null };
  const d = (await res.json()) as { status: string; conclusion: string | null };
  return { status: d.status, conclusion: d.conclusion };
}

export async function runFailureSummary(runId: string): Promise<string> {
  const { repo, token } = env();
  if (!repo || !token) return "no token";
  const jobsRes = await fetch(`${API}/repos/${repo}/actions/runs/${runId}/jobs`, { headers: h(token) });
  if (!jobsRes.ok) return "could not read jobs";
  const jobs = (await jobsRes.json()) as { jobs: { id: number; conclusion: string }[] };
  const failed = jobs.jobs.find((j) => j.conclusion === "failure");
  if (!failed) return "no failed job found";
  const logRes = await fetch(`${API}/repos/${repo}/actions/jobs/${failed.id}/logs`, { headers: h(token) });
  if (!logRes.ok) return "could not read logs";
  const text = await logRes.text();
  // Keep the lines that point at the actual failure (Flutter/test output).
  const lines = text
    .split("\n")
    .filter((l) => /error|exception|failed|expected|test|✗|✕|analyze|\bat /i.test(l))
    .map((l) => l.replace(/^\S+\s/, "")) // strip timestamps
    .slice(-60);
  return lines.join("\n").slice(-6000);
}

export async function mergeBranch(branch: string, base = "master"): Promise<{ ok: boolean; detail: string }> {
  const { repo, token } = env();
  if (!repo || !token) return { ok: false, detail: "GITHUB_REPO / GITHUB_TOKEN not set." };
  const res = await fetch(`${API}/repos/${repo}/merges`, {
    method: "POST",
    headers: h(token),
    body: JSON.stringify({ base, head: branch, commit_message: `mc: merge ${branch} (QA passed)` }),
  });
  if (res.status === 201) return { ok: true, detail: `Merged ${branch} into ${base}.` };
  if (res.status === 204) return { ok: true, detail: `${base} already up to date.` };
  return { ok: false, detail: `merge ${res.status}: ${(await res.text()).slice(0, 150)}` };
}

export async function deleteBranch(branch: string): Promise<void> {
  const { repo, token } = env();
  if (!repo || !token) return;
  await fetch(`${API}/repos/${repo}/git/refs/heads/${branch}`, { method: "DELETE", headers: h(token) });
}
