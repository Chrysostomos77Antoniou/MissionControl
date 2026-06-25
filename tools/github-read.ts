// Read the FootRank GitHub repo so technical agents can give file-level advice.
const API = "https://api.github.com";

function repoEnv() {
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  return { repo, token };
}

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "footrank-mission-control",
  };
}

export async function listRepo(path: string): Promise<string> {
  const { repo, token } = repoEnv();
  if (!repo || !token) return "GITHUB_REPO / GITHUB_TOKEN not set — cannot read the codebase.";
  const clean = path.replace(/^\/+/, "");
  const res = await fetch(`${API}/repos/${repo}/contents/${clean}`, { headers: headers(token) });
  if (!res.ok) return `GitHub ${res.status}: ${(await res.text()).slice(0, 150)}`;
  const data = (await res.json()) as { name: string; type: string; path: string }[] | { type: string };
  if (!Array.isArray(data)) return `"${clean}" is a file, not a directory. Use read_repo_file.`;
  return data.map((e) => `${e.type === "dir" ? "[dir] " : "      "}${e.path}`).join("\n") || "(empty)";
}

export async function readRepoFile(path: string): Promise<string> {
  const { repo, token } = repoEnv();
  if (!repo || !token) return "GITHUB_REPO / GITHUB_TOKEN not set — cannot read the codebase.";
  const clean = path.replace(/^\/+/, "");
  const res = await fetch(`${API}/repos/${repo}/contents/${clean}`, { headers: headers(token) });
  if (!res.ok) return `GitHub ${res.status}: ${(await res.text()).slice(0, 150)}`;
  const data = (await res.json()) as { content?: string; encoding?: string; type?: string };
  if (data.type !== "file" || !data.content) return `"${clean}" is not a readable file.`;
  const decoded = Buffer.from(data.content, "base64").toString("utf-8");
  // Cap to keep token usage sane on large files.
  return decoded.length > 12000 ? decoded.slice(0, 12000) + "\n…(truncated)" : decoded;
}
