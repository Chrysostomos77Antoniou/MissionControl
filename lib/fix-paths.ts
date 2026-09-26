// Which files an AI fix may write to its QA branch (Phase 1 safety).
// Pure — no I/O — so the rules are unit tested.
//
// Rules:
// - Never touch CI/workflow config: a model that can edit .github/ could make
//   the QA suite "pass" or exfiltrate repository secrets.
// - Never touch secrets, signing material, or credentials files.
// - No absolute paths, no "..", no hidden traversal.
// - Database changes are expressed ONLY as a NEW timestamped migration file
//   under supabase/migrations/ (checked for non-existence on the base branch
//   by the caller). They are never executed by Mission Control — a human
//   reviews and merges the PR, then applies the migration themselves.

export const MIGRATIONS_DIR = "supabase/migrations/";
const MIGRATION_NAME = /^supabase\/migrations\/\d{14}_[a-z0-9_]{3,80}\.sql$/;

const BLOCKED: RegExp[] = [
  /(^|\/)\.github\//i,
  /(^|\/)\.env($|\.)/i,
  /\.(pem|key|p12|pfx|jks|keystore|mobileprovision|cer|crt|der)$/i,
  /(^|\/)key\.properties$/i,
  /(^|\/)google-services\.json$/i,
  /(^|\/)GoogleService-Info\.plist$/i,
  /(^|\/)(service[-_]?account|credentials?|secrets?)[^/]*\.(json|ya?ml|txt|env)$/i,
  /(^|\/)\.git\//,
  /(^|\/)supabase\/config\.toml$/i,
];

export interface FixFile {
  path: string;
  content: string;
}

export type PathVerdict = { ok: true; isMigration: boolean } | { ok: false; reason: string };

export function checkFixPath(path: string): PathVerdict {
  if (typeof path !== "string" || !path.trim()) return { ok: false, reason: "empty path" };
  const p = path.trim();
  if (p.startsWith("/") || p.startsWith("\\") || /^[a-z]:/i.test(p)) return { ok: false, reason: "absolute paths are not allowed" };
  if (p.includes("\\")) return { ok: false, reason: "use forward slashes" };
  if (p.split("/").some((seg) => seg === ".." || seg === "." || seg === "")) return { ok: false, reason: "path traversal / empty segment not allowed" };
  for (const re of BLOCKED) if (re.test(p)) return { ok: false, reason: `protected path (${re.source})` };
  if (p.startsWith(MIGRATIONS_DIR)) {
    if (!MIGRATION_NAME.test(p)) {
      return { ok: false, reason: "migrations must be NEW files named supabase/migrations/YYYYMMDDHHMMSS_snake_case_name.sql" };
    }
    return { ok: true, isMigration: true };
  }
  return { ok: true, isMigration: false };
}

export function validateFixFiles(files: unknown): { ok: true; files: FixFile[]; migrations: string[] } | { ok: false; errors: string[] } {
  if (!Array.isArray(files) || files.length === 0) return { ok: false, errors: ["no files provided"] };
  if (files.length > 25) return { ok: false, errors: ["too many files in one fix (max 25)"] };
  const errors: string[] = [];
  const out: FixFile[] = [];
  const migrations: string[] = [];
  const seen = new Set<string>();
  for (const f of files as { path?: unknown; content?: unknown }[]) {
    const path = String(f?.path ?? "");
    if (typeof f?.content !== "string") { errors.push(`${path}: content must be a string`); continue; }
    if (f.content.length > 200_000) { errors.push(`${path}: file too large`); continue; }
    if (seen.has(path)) { errors.push(`${path}: duplicate`); continue; }
    seen.add(path);
    const v = checkFixPath(path);
    if (!v.ok) { errors.push(`${path}: ${v.reason}`); continue; }
    if (v.isMigration) migrations.push(path.trim());
    out.push({ path: path.trim(), content: f.content });
  }
  return errors.length ? { ok: false, errors } : { ok: true, files: out, migrations };
}
