// Read-only SQL guard for the db_read tool (Phase 1 safety).
//
// Layered defence — this module is NOT the only protection:
//   1. The query runs through Supabase's Management API read-only endpoint as
//      `supabase_read_only_user` inside a read-only transaction (verified live:
//      CREATE TABLE fails with SQLSTATE 25006). The database refuses writes.
//   2. This guard parses the statement (comments, strings, quoted identifiers,
//      dollar quoting) and enforces: exactly one statement, SELECT/WITH only,
//      no side-effecting keywords, functions from an allowlist only, no
//      protected schemas/relations, and — for queries touching app data — no
//      personal/free-text columns, no SELECT *, no whole-row serialization.
//   3. tools/db-read.ts redacts personal data patterns from the result.
//
// Pure (no I/O) so every rule is unit tested.

export type SqlKind = "catalog" | "data";
export type SqlVerdict = { ok: true; sql: string; kind: SqlKind } | { ok: false; reason: string };

type Tok =
  | { t: "word"; v: string } // unquoted identifier / keyword, lowercased
  | { t: "qident"; v: string } // "quoted identifier", lowercased for matching
  | { t: "str" }
  | { t: "num" }
  | { t: "punct"; v: string };

const MAX_SQL = 4000;

function tokenize(sql: string): Tok[] | string {
  const out: Tok[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "-" && sql[i + 1] === "-") { while (i < n && sql[i] !== "\n") i++; continue; }
    if (c === "/" && sql[i + 1] === "*") {
      let depth = 1; i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; }
        else if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; }
        else i++;
      }
      if (depth > 0) return "unterminated comment";
      continue;
    }
    if (c === "$") return "dollar quoting / positional parameters are not allowed";
    if (c === "\\") return "backslash commands are not allowed";
    if (c === "'") {
      // E'…' strings honour backslash escapes.
      const prev = out[out.length - 1];
      const escapeMode = !!prev && prev.t === "word" && prev.v === "e" && /[eE]/.test(sql[i - 1] ?? "");
      if (escapeMode) out.pop();
      i++;
      let closed = false;
      while (i < n) {
        if (escapeMode && sql[i] === "\\") { i += 2; continue; }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++; closed = true; break;
        }
        i++;
      }
      if (!closed) return "unterminated string literal";
      out.push({ t: "str" });
      continue;
    }
    if (c === '"') {
      i++;
      let v = "";
      let closed = false;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { v += '"'; i += 2; continue; }
          i++; closed = true; break;
        }
        v += sql[i++];
      }
      if (!closed) return "unterminated quoted identifier";
      out.push({ t: "qident", v: v.toLowerCase() });
      continue;
    }
    if (/[A-Za-z_]/.test(c) || c.charCodeAt(0) > 127) {
      let v = "";
      while (i < n && (/[A-Za-z0-9_]/.test(sql[i]) || sql.charCodeAt(i) > 127)) v += sql[i++];
      out.push({ t: "word", v: v.toLowerCase() });
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
      while (i < n && /[0-9.eE]/.test(sql[i])) i++;
      out.push({ t: "num" });
      continue;
    }
    if (c === ":" && sql[i + 1] === ":") { out.push({ t: "punct", v: "::" }); i += 2; continue; }
    out.push({ t: "punct", v: c });
    i++;
  }
  return out;
}

// Keywords that terminate / modify state, lock rows, or create objects.
const FORBIDDEN_KEYWORDS = new Set([
  "insert", "update", "delete", "merge", "upsert", "drop", "alter", "create", "grant", "revoke",
  "truncate", "copy", "call", "do", "execute", "exec", "prepare", "deallocate", "into", "share",
  "lock", "listen", "notify", "unlisten", "vacuum", "refresh", "set", "reset", "begin", "commit",
  "rollback", "savepoint", "checkpoint", "declare", "returning", "import",
]);

// Words that may legitimately be followed by "(" without being a function call.
const PAREN_KEYWORDS = new Set([
  "in", "any", "all", "some", "exists", "cast", "filter", "over", "within", "values", "as", "from",
  "join", "using", "on", "where", "select", "and", "or", "not", "when", "then", "else", "case", "by",
  "having", "lateral", "array", "extract", "like", "ilike", "is", "between", "union", "except",
  "intersect", "distinct", "limit", "offset", "with", "group", "order", "partition", "rollup", "cube",
  "grouping", "sets", "interval", "only", "recursive", "materialized", "similar", "to", "escape",
]);

// Functions allowed anywhere (pure, no side effects, no dynamic SQL).
const SAFE_FUNCTIONS = new Set([
  "count", "sum", "avg", "min", "max", "coalesce", "nullif", "greatest", "least",
  "bool_and", "bool_or", "every", "stddev", "stddev_pop", "stddev_samp", "variance", "var_pop",
  "var_samp", "corr", "percentile_cont", "percentile_disc", "mode",
  "row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile", "lag", "lead",
  "first_value", "last_value", "nth_value",
  "round", "ceil", "ceiling", "floor", "abs", "trunc", "mod", "power", "sqrt", "sign", "width_bucket",
  "now", "current_date", "current_timestamp", "date_trunc", "date_part", "age", "to_char", "to_date",
  "to_timestamp", "make_interval", "make_date", "justify_interval", "timezone", "date_bin",
  "lower", "upper", "length", "char_length", "octet_length", "trim", "btrim", "ltrim", "rtrim",
  "position", "strpos", "starts_with", "left", "right", "split_part", "replace", "substr", "substring",
  "array_length", "cardinality", "unnest", "generate_series",
  "has_table_privilege", "has_schema_privilege", "has_function_privilege", "has_column_privilege",
  "has_any_column_privilege", "pg_has_role", "row_security_active",
  "pg_get_expr", "pg_get_constraintdef", "pg_get_indexdef", "pg_get_functiondef", "pg_get_viewdef",
  "pg_get_triggerdef", "pg_get_function_arguments", "pg_get_function_result", "pg_get_userbyid",
  "pg_relation_size", "pg_total_relation_size", "pg_table_size", "pg_indexes_size", "pg_size_pretty",
  "pg_database_size", "format_type", "obj_description", "col_description", "to_regclass",
  "to_regproc", "to_regprocedure", "to_regrole", "quote_ident", "current_schema",
  "jsonb_typeof", "json_typeof", "jsonb_array_length", "json_array_length",
  "version", "current_user", "session_user", "inet_server_version",
]);
// Serialization/aggregation helpers: allowed for catalog queries only (they
// can serialize whole rows of app data into one opaque string/json value).
const CATALOG_ONLY_FUNCTIONS = new Set([
  "string_agg", "array_agg", "json_agg", "jsonb_agg", "row_to_json", "to_json", "to_jsonb",
  "json_build_object", "jsonb_build_object", "json_object_agg", "jsonb_object_agg", "concat",
  "concat_ws", "format", "array_to_string", "jsonb_pretty", "jsonb_object_keys", "json_object_keys",
]);

const CATALOG_SCHEMAS = new Set(["pg_catalog", "information_schema"]);
const BLOCKED_SCHEMAS = new Set([
  "auth", "vault", "pgsodium", "pgsodium_masks", "net", "supabase_functions", "cron", "realtime",
  "extensions", "graphql", "graphql_public", "pgbouncer", "supabase_migrations", "_realtime", "_analytics",
]);
const BLOCKED_RELATIONS = new Set([
  "pg_authid", "pg_shadow", "pg_user_mapping", "pg_user_mappings", "pg_stat_activity",
  "pg_stat_statements", "pg_stat_statements_info", "pg_largeobject", "pg_file_settings", "pg_hba_file_rules",
]);
const ALLOWED_STORAGE = new Set(["buckets"]); // storage.objects holds per-user file metadata

// Personal or free-text columns. Blocked in any query that touches app data.
export const SENSITIVE_IDENTIFIERS = new Set([
  "email", "e_mail", "emails", "phone", "phone_number", "phonenumber", "mobile", "telephone", "tel",
  "name", "first_name", "last_name", "full_name", "display_name", "username", "user_name", "nickname",
  "surname", "given_name", "family_name", "firstname", "lastname", "fullname", "displayname",
  "address", "street", "postcode", "postal_code", "zip", "zipcode", "ip", "ip_address", "ipaddress",
  "birth_date", "birthdate", "birthday", "dob", "date_of_birth",
  "password", "password_hash", "encrypted_password", "token", "access_token", "refresh_token",
  "fcm_token", "push_token", "device_token", "apns_token", "secret", "api_key",
  "avatar_url", "photo_url", "profile_picture", "picture", "image_url",
  "lat", "lng", "lon", "latitude", "longitude", "location", "coordinates", "geo",
  "raw_user_meta_data", "raw_app_meta_data", "user_metadata", "metadata",
  "bio", "message", "messages", "comment", "comments", "note", "notes", "description", "reason",
  "details", "content", "text", "body",
]);
const TEXTY_CASTS = new Set(["text", "varchar", "char", "bpchar", "character", "json", "jsonb", "xml", "name", "citext"]);

function wordOf(tok: Tok | undefined): string | null {
  return tok && (tok.t === "word" || tok.t === "qident") ? tok.v : null;
}

export function checkReadOnlySql(input: string): SqlVerdict {
  if (typeof input !== "string" || !input.trim()) return { ok: false, reason: "empty query" };
  if (input.length > MAX_SQL) return { ok: false, reason: `query too long (max ${MAX_SQL} chars)` };
  const tk = tokenize(input);
  if (typeof tk === "string") return { ok: false, reason: tk };
  const toks = [...tk];
  while (toks.length && toks[toks.length - 1].t === "punct" && (toks[toks.length - 1] as { v: string }).v === ";") toks.pop();
  if (!toks.length) return { ok: false, reason: "empty query" };
  if (toks.some((x) => x.t === "punct" && x.v === ";")) return { ok: false, reason: "exactly one statement is allowed" };
  const first = wordOf(toks[0]);
  if (toks[0].t !== "word" || (first !== "select" && first !== "with")) {
    return { ok: false, reason: "only SELECT / WITH queries are allowed" };
  }

  // Keyword + function + schema checks.
  for (let i = 0; i < toks.length; i++) {
    const x = toks[i];
    if (x.t !== "word" && x.t !== "qident") continue;
    if (x.t === "word" && FORBIDDEN_KEYWORDS.has(x.v)) return { ok: false, reason: `"${x.v.toUpperCase()}" is not allowed in read-only queries` };
    const nextIsDot = toks[i + 1]?.t === "punct" && (toks[i + 1] as { v: string }).v === ".";
    const prevIsDot = toks[i - 1]?.t === "punct" && (toks[i - 1] as { v: string }).v === ".";
    if (nextIsDot && !prevIsDot) {
      const nxt = wordOf(toks[i + 2]);
      if (BLOCKED_SCHEMAS.has(x.v)) return { ok: false, reason: `schema "${x.v}" is not readable by agents` };
      if (x.v === "storage" && nxt && !ALLOWED_STORAGE.has(nxt)) return { ok: false, reason: `storage.${nxt} is not readable by agents (only storage.buckets)` };
    }
    if (BLOCKED_RELATIONS.has(x.v)) return { ok: false, reason: `${x.v} is not readable by agents` };
    const isCall = toks[i + 1]?.t === "punct" && (toks[i + 1] as { v: string }).v === "(";
    if (isCall && !(x.t === "word" && PAREN_KEYWORDS.has(x.v))) {
      if (prevIsDot) {
        const schema = wordOf(toks[i - 2]);
        if (schema !== "pg_catalog") return { ok: false, reason: `calling ${schema}.${x.v}() is not allowed (only built-in functions)` };
      }
      if (!SAFE_FUNCTIONS.has(x.v) && !CATALOG_ONLY_FUNCTIONS.has(x.v)) {
        return { ok: false, reason: `function ${x.v}() is not on the read-only allowlist` };
      }
    }
  }

  // Relations in FROM / JOIN lists, their aliases, and query classification.
  const relations: string[] = [];
  const nameTokens = new Set<string>();
  const declIdx = new Set<number>();
  let i = 0;
  const readRelation = (): void => {
    while (wordOf(toks[i]) === "only" || wordOf(toks[i]) === "lateral") i++;
    if (toks[i]?.t === "punct" && (toks[i] as { v: string }).v === "(") return; // subquery — walked normally
    const parts: string[] = [];
    const start = i;
    while (wordOf(toks[i]) !== null) {
      parts.push(wordOf(toks[i])!);
      if (toks[i + 1]?.t === "punct" && (toks[i + 1] as { v: string }).v === ".") i += 2;
      else { i++; break; }
    }
    if (!parts.length) return;
    if (toks[i]?.t === "punct" && (toks[i] as { v: string }).v === "(") return; // set-returning function
    for (let k = start; k < i; k++) declIdx.add(k);
    relations.push(parts.join("."));
    nameTokens.add(parts[parts.length - 1]);
    if (wordOf(toks[i]) === "as") i++;
    const alias = wordOf(toks[i]);
    if (alias && !PAREN_KEYWORDS.has(alias) && !["left", "right", "inner", "outer", "full", "cross", "natural", "join", "on", "where", "group", "order", "limit", "union", "window"].includes(alias)) {
      nameTokens.add(alias);
      declIdx.add(i);
      i++;
    }
  };
  for (i = 0; i < toks.length; ) {
    const w = toks[i].t === "word" ? (toks[i] as { v: string }).v : null;
    if (w === "from" || w === "join") {
      i++;
      readRelation();
      while (toks[i]?.t === "punct" && (toks[i] as { v: string }).v === ",") { i++; readRelation(); }
      continue;
    }
    i++;
  }
  const isCatalogRel = (r: string) => {
    const p = r.split(".");
    if (p.length === 1) return p[0].startsWith("pg_");
    return CATALOG_SCHEMAS.has(p[0]) || (p[0] === "storage" && p[1] === "buckets");
  };
  const kind: SqlKind = relations.every(isCatalogRel) ? "catalog" : "data";

  if (kind === "data") {
    for (let k = 0; k < toks.length; k++) {
      const x = toks[k];
      const w = wordOf(x);
      if (w && SENSITIVE_IDENTIFIERS.has(w) && !(x.t === "word" && toks[k - 1]?.t === "punct" && (toks[k - 1] as { v: string }).v === "::")) {
        return { ok: false, reason: `column "${w}" is personal/free-text data and cannot be read by agents — use counts or aggregates` };
      }
      if (w && CATALOG_ONLY_FUNCTIONS.has(w) && toks[k + 1]?.t === "punct" && (toks[k + 1] as { v: string }).v === "(") {
        return { ok: false, reason: `${w}() cannot be used on app data (it can serialize whole rows)` };
      }
      if (x.t === "punct" && x.v === "::" && w === null) {
        const target = wordOf(toks[k + 1]);
        if (target && TEXTY_CASTS.has(target)) return { ok: false, reason: `casting app data to ${target} is not allowed` };
      }
      if (w && (w === "text" || w === "json" || w === "jsonb") && wordOf(toks[k - 1]) === "as" ) {
        return { ok: false, reason: `casting app data to ${w} is not allowed` };
      }
      if (x.t === "punct" && x.v === "*") {
        const prev = toks[k - 1];
        const countStar = prev?.t === "punct" && prev.v === "(" && wordOf(toks[k - 2]) === "count";
        const isSelectList = !prev || (prev.t === "word" && (prev.v === "select" || prev.v === "distinct")) || (prev.t === "punct" && (prev.v === "," || prev.v === "."));
        if (isSelectList && !countStar) return { ok: false, reason: "SELECT * on app data is not allowed — name the (non-personal) columns you need" };
      }
      const isCteName =
        (wordOf(toks[k + 1]) === "as" && toks[k + 2]?.t === "punct" && (toks[k + 2] as { v: string }).v === "(") ||
        (toks[k + 1]?.t === "punct" && (toks[k + 1] as { v: string }).v === "(" && (wordOf(toks[k - 1]) === "with" || wordOf(toks[k - 1]) === "recursive" || (toks[k - 1]?.t === "punct" && (toks[k - 1] as { v: string }).v === ",")));
      if (w && nameTokens.has(w) && !declIdx.has(k) && !isCteName) {
        const nextIsDot = toks[k + 1]?.t === "punct" && (toks[k + 1] as { v: string }).v === ".";
        const prevIsDot = toks[k - 1]?.t === "punct" && (toks[k - 1] as { v: string }).v === ".";
        if (!nextIsDot && !prevIsDot) return { ok: false, reason: `whole-row reference "${w}" is not allowed — select specific columns` };
      }
    }
  }
  return { ok: true, sql: input.trim().replace(/;+\s*$/, ""), kind };
}
