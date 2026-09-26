// Suggestion category validation (Commit 6a).
//
// There is no category registry in Mission Control: `category` is a free-form
// "short tag" (tools/registry.ts, e.g. 'bug', 'feature', 'security',
// 'growth'; the marketing agent uses 'video-idea'), and "general" is the
// existing default. So instead of inventing a list, this enforces the tag
// SHAPE and keeps figures out of it: a category must be a short lowercase
// slug with no numeric claim in it (it is not covered by the claim guard's
// title/body/evidence check). Anything else becomes the existing default.
// Pure: no I/O.

import { extractClaims } from "./claim-guard";

export const DEFAULT_CATEGORY = "general";
const TAG = /^[a-z][a-z0-9-]{0,31}$/;
// Letters, digits, space, underscore, hyphen only (no newlines/markup/punctuation).
const RAW_CHARS = /^[A-Za-z0-9 _-]+$/;

export function normalizeCategory(raw: unknown): { category: string; valid: boolean } {
  const original = typeof raw === "string" ? raw.trim() : "";
  const s = original.toLowerCase().replace(/[\s_]+/g, "-");
  // Checked before AND after normalising: "growth 6" must not pass as "growth-6".
  if (RAW_CHARS.test(original) && TAG.test(s) && extractClaims(original).length === 0 && extractClaims(s).length === 0) return { category: s, valid: true };
  return { category: DEFAULT_CATEGORY, valid: false };
}
