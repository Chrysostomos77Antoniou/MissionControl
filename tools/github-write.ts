// Open a pull request against the FootRank repo with file changes.
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

export async function openPr(input: {
  branch: string;
  title: string;
  body: string;
  base?: string;
  files: { path: string; content: string }[];
}): Promise<string> {
  const { repo, token } = env();
  if (!repo || !token) return "GITHUB_REPO / GITHUB_TOKEN not set — cannot open a PR.";
  if (!input.files?.length) return "No file changes provided; cannot open a PR.";
  const base = input.base || "master";

  const refRes = await fetch(`${API}/repos/${repo}/git/ref/heads/${base}`, { headers: h(token) });
  if (!refRes.ok) return `GitHub base ref ${refRes.status}: ${(await refRes.text()).slice(0, 150)}`;
  const baseSha = ((await refRes.json()) as { object: { sha: string } }).object.sha;

  const branch = input.branch.replace(/[^a-zA-Z0-9._/-]/g, "-");
  const crRes = await fetch(`${API}/repos/${repo}/git/refs`, {
    method: "POST",
    headers: h(token),
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
  });
  if (!crRes.ok && crRes.status !== 422) {
    return `GitHub create branch ${crRes.status}: ${(await crRes.text()).slice(0, 150)}`;
  }

  for (const f of input.files) {
    let sha: string | undefined;
    const getRes = await fetch(`${API}/repos/${repo}/contents/${f.path}?ref=${branch}`, { headers: h(token) });
    if (getRes.ok) {
      const d = (await getRes.json()) as { sha?: string };
      if (!Array.isArray(d)) sha = d.sha;
    }
    const putRes = await fetch(`${API}/repos/${repo}/contents/${f.path}`, {
      method: "PUT",
      headers: h(token),
      body: JSON.stringify({
        message: `mc: ${input.title}`,
        content: Buffer.from(f.content, "utf-8").toString("base64"),
        branch,
        sha,
      }),
    });
    if (!putRes.ok) return `GitHub write ${f.path} ${putRes.status}: ${(await putRes.text()).slice(0, 150)}`;
  }

  const prRes = await fetch(`${API}/repos/${repo}/pulls`, {
    method: "POST",
    headers: h(token),
    body: JSON.stringify({ title: input.title, head: branch, base, body: input.body }),
  });
  if (!prRes.ok) return `GitHub PR ${prRes.status}: ${(await prRes.text()).slice(0, 150)}`;
  const pr = (await prRes.json()) as { html_url: string };
  return `Opened PR: ${pr.html_url}`;
}
