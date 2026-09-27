// Pattern-based redaction of personal data and secrets in tool output
// (Phase 1: used by db_read; extended into the full privacy scrubber later).
// Pure — no I/O.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_INTL = /\+\d[\d\s().-]{6,}\d/g;
const PHONE_DIGITS = /(?<![\d.-])\d{8,15}(?![\d.-])/g;
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const SECRETS = /\b(?:sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{30,}|sbp_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// Secrets only (API keys, tokens, JWTs, bearer headers) — for source code
// shown to agents (tools/github-read.ts, tools/code-search.ts). The personal-
// data patterns above are deliberately NOT applied there: they would mangle
// ordinary numbers and identifiers in code that agents must quote exactly.
export function redactSecrets(s: string): string {
  return s.replace(JWT, "[redacted-token]").replace(SECRETS, "[redacted-secret]").replace(BEARER, "$1 [redacted-token]");
}

export function redactText(s: string, opts: { maskUuids?: boolean } = {}): string {
  let out = s
    .replace(JWT, "[redacted-token]")
    .replace(SECRETS, "[redacted-secret]")
    .replace(BEARER, "$1 [redacted-token]")
    .replace(EMAIL, "[redacted-email]")
    .replace(PHONE_INTL, "[redacted-phone]")
    .replace(PHONE_DIGITS, "[redacted-phone]")
    .replace(IPV4, "[redacted-ip]");
  if (opts.maskUuids) out = out.replace(UUID, "[id]");
  return out;
}

const SENSITIVE_KEY = /(e_?mail|phone|mobile|telephone|(^|_)name$|^name|username|nickname|surname|address|street|postcode|postal|zip|(^|_)ip(_|$)|birth|dob|password|token|secret|api_?key|avatar|photo|picture|latitude|longitude|(^|_)lat$|(^|_)lng$|location|meta_?data|bio$|message|comment|note|description|reason|details|content|body)/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

// Recursively redact a JSON value. maskKeys: blank out values under
// personal-looking keys (used for app-data queries, not catalog queries).
export function redactValue(v: unknown, opts: { maskKeys?: boolean; maskUuids?: boolean } = {}, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof v === "string") return redactText(v, opts);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, opts, depth + 1));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      o[k] = opts.maskKeys && isSensitiveKey(k) && val !== null ? "[redacted]" : redactValue(val, opts, depth + 1);
    }
    return o;
  }
  return v;
}
