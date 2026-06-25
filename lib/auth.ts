// Minimal owner-only gate: a single password (OWNER_PASSWORD) unlocks a signed,
// httpOnly session cookie. Edge-compatible (Web Crypto only) so it works in
// middleware. Appropriate for a single-user tool that can merge code and run
// DB migrations — keep OWNER_PASSWORD and AUTH_SECRET secret.
export const SESSION_COOKIE = "mc_session";

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// The cookie value is an HMAC over a fixed message with AUTH_SECRET — it can't
// be forged without the secret, and it doesn't contain the password.
export async function expectedToken(): Promise<string> {
  const secret = process.env.AUTH_SECRET || "insecure-dev-secret-change-me";
  return hmacHex(secret, "footrank-mission-control-owner");
}
