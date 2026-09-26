import { describe, it, expect } from "vitest";
import { checkReadOnlySql } from "../sql-guard";

const ok = (sql: string) => {
  const v = checkReadOnlySql(sql);
  if (!v.ok) throw new Error(`expected OK for ${sql}: ${v.reason}`);
  return v;
};
const bad = (sql: string, re?: RegExp) => {
  const v = checkReadOnlySql(sql);
  expect(v.ok, `expected rejection for: ${sql}`).toBe(false);
  if (!v.ok && re) expect(v.reason).toMatch(re);
};

describe("sql-guard: allowed read-only queries", () => {
  it("allows catalog introspection the agents rely on", () => {
    expect(ok("select * from pg_policies where tablename = 'matches'").kind).toBe("catalog");
    expect(ok("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'users';").kind).toBe("catalog");
    expect(ok("select name, public, file_size_limit from storage.buckets").kind).toBe("catalog");
    expect(ok("select indexname, indexdef from pg_catalog.pg_indexes where schemaname='public'").kind).toBe("catalog");
    expect(ok("select relname, pg_size_pretty(pg_total_relation_size(c.oid)) from pg_class c").kind).toBe("catalog");
    expect(ok("select string_agg(policyname, ', ') from pg_policies").kind).toBe("catalog");
    expect(ok("select 1").kind).toBe("catalog");
  });
  it("allows aggregate queries on app data", () => {
    const v = ok("select date_trunc('week', created_at) as wk, count(*) from public.users where created_at > now() - interval '30 days' group by 1 order by 1");
    expect(v.kind).toBe("data");
    ok("with t as (select team_id, count(*) as n from public.matches group by team_id) select avg(n), max(n) from t");
    ok("select m.status, count(*) from public.matches m join public.teams t on t.id = m.home_team_id group by m.status");
    ok("select count(*) filter (where status = 'completed') from public.matches");
  });
  it("classifies unqualified app tables as data (search_path includes public)", () => {
    expect(ok("select count(*) from teams").kind).toBe("data");
  });
});

describe("sql-guard: side effects and multi-statement", () => {
  it.each([
    "insert into public.users(id) values (1)",
    "update public.users set x = 1",
    "delete from public.users",
    "drop table public.users",
    "create table x(a int)",
    "grant all on public.users to anon",
    "call some_proc()",
    "do 'begin end'",
    "copy public.users to stdout",
    "truncate public.users",
    "explain analyze select 1",
    "set role postgres",
    "vacuum",
  ])("rejects %s", (sql) => bad(sql));
  it("rejects multiple statements, including hidden ones", () => {
    bad("select 1; drop table public.users", /one statement/);
    bad("select 1 /* comment */ ; select 2", /one statement/);
    bad("select 1;select 2;", /one statement/);
  });
  it("allows a single trailing semicolon and semicolons inside strings/comments", () => {
    ok("select 1;");
    ok("select ';' as s -- ; drop table x");
    ok("select 1 /* ; nested /* ; */ still comment */");
  });
  it("rejects data-modifying CTEs, SELECT INTO and row locks", () => {
    bad("with d as (delete from public.users returning 1) select * from d");
    bad("select count(*) into tmp_x from public.users");
    bad("select id from public.matches for update");
    bad("select id from public.matches for share");
  });
  it("rejects dollar quoting, unterminated literals and backslash commands", () => {
    bad("select $$x$$", /dollar/);
    bad("select 'abc", /unterminated/);
    bad('select "abc', /unterminated/);
    bad("select 1 /* open", /unterminated/);
    bad("\\! rm -rf /");
  });
  it("tokenizes backslashes exactly like PostgreSQL (standard_conforming_strings)", () => {
    // Plain string: backslash is literal, so the ; after it is a real statement break.
    bad("select '\\'; drop table x; --'", /one statement/);
    // E-string: \' is an escaped quote, so everything is one harmless literal.
    ok("select E'\\'; drop table x; --'");
    ok("select E'it\\'s fine'");
  });
});

describe("sql-guard: dangerous or unknown functions", () => {
  it.each([
    "select pg_sleep(10)",
    "select set_config('role','postgres',false)",
    "select nextval('public.seq')",
    "select lo_import('/etc/passwd')",
    "select pg_read_file('/etc/passwd')",
    "select dblink('host=x', 'select 1')",
    "select query_to_xml('select email from auth.users', true, true, '')",
    "select table_to_xml('public.users', true, true, '')",
    "select pg_terminate_backend(123)",
    "select public.get_user_emails()",
    "select get_user_emails()",
    "select auth.uid()",
    "select net.http_get('https://evil.example')",
  ])("rejects %s", (sql) => bad(sql));
});

describe("sql-guard: protected schemas and personal data", () => {
  it.each([
    "select * from auth.users",
    "select count(*) from auth.identities",
    "select * from vault.decrypted_secrets",
    "select name from storage.objects",
    "select * from pg_authid",
    "select query from pg_stat_activity",
  ])("rejects protected relation: %s", (sql) => bad(sql));

  it.each([
    "select email from public.users",
    'select "Email" from public.users',
    "select id, phone from public.users",
    "select full_name from public.profiles",
    "select name from public.teams",
    "select u.email from public.users u",
    "select count(*) from public.users where email like '%@gmail.com'",
    "select description from public.behavior_reports",
    "select fcm_token from public.profiles",
  ])("rejects personal/free-text column: %s", (sql) => bad(sql, /personal|free-text/));

  it("rejects SELECT * and whole-row serialization on app data", () => {
    bad("select * from public.users", /SELECT \*/);
    bad("select u.* from public.users u", /SELECT \*/);
    bad("select u from public.users u", /whole-row/);
    bad("select row_to_json(u) from public.users u");
    bad("select string_agg(id::text, ',') from public.users");
    bad("select array_agg(created_at) from public.users");
    bad("select cast(u as text) from public.users u");
    bad("select id::text from public.users");
  });
  it("keeps count(*) and multiplication working on app data", () => {
    ok("select count(*) from public.users");
    ok("select count(*) * 2 from public.users");
  });
});
