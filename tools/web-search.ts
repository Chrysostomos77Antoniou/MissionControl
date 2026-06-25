export async function webSearch(query: string): Promise<string> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      max_results: 5,
      search_depth: "basic",
    }),
  });
  if (!res.ok) return `Search failed (${res.status}).`;
  const data = (await res.json()) as { results?: { title: string; url: string; content: string }[] };
  const results = data.results ?? [];
  if (results.length === 0) return "No results found.";
  return results.map((r) => `- ${r.title} (${r.url})\n  ${r.content.slice(0, 300)}`).join("\n");
}
