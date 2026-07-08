// Resilient client-side GET for the dashboard's polling fetches. Transient
// dev-server hot-reloads / network blips return null (so callers keep their last
// data instead of throwing an uncaught "Failed to fetch"); a real 401 (expired
// owner session) sends the user to the login page.
export async function apiGet<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(path);
    if (r.status === 401) {
      if (typeof window !== "undefined") window.location.href = "/login";
      return null;
    }
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export async function apiPost<T>(path: string, body: unknown): Promise<T | null> {
  try {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.status === 401) {
      if (typeof window !== "undefined") window.location.href = "/login";
      return null;
    }
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}
