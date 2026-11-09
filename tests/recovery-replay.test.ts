// @vitest-environment node
import { readFile, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  applyRecoveryPlan, createRecoveryDatabase, readRecoveryManifest, readRecoverySources,
  recoveryExtensions, validateRecoveryManifest, verifyDeployedCheckpoint, type RecoveryManifest,
} from "../scripts/database-recovery/replay.mjs";
import { captureCatalog, catalogFingerprint } from "../scripts/database-recovery/catalog.mjs";

const allowed = "supabase/migrations/20261105192540_optimistic_assessment_mark_writes.sql";
const entry = { path: allowed, sha256: "a".repeat(64), kind: "pending" as const };
const manifest = (...plan: unknown[]) => ({ format: "sms-recovery-plan/v1", plan,
  platform_contract: { path: "scripts/database-recovery/platform-contract.sql", sha256: "a".repeat(64) },
  order_sha256: createHash("sha256").update(JSON.stringify(plan.map((source) => {
    const { path, sha256, kind, version } = source as Record<string, unknown>;
    return { path, sha256, kind, version };
  }))).digest("hex"),
});

describe("recovery source boundary", () => {
  it.each([null, {}, manifest(), { ...manifest(entry), format: "unknown" }])("rejects an absent/unsupported plan", (value) => {
    expect(() => validateRecoveryManifest(value)).toThrow();
  });

  it.each(["/tmp/input.sql", "supabase/migrations/../outside.sql", "supabase/migrations/a/../../outside.sql", ".env.local", "supabase\\migrations\\input.sql"])("rejects source path %s", (sourcePath) => {
    expect(() => validateRecoveryManifest(manifest({ ...entry, path: sourcePath }))).toThrow(/allowed repository SQL path/);
  });

  it("rejects hash/kind drift, duplicate sources, pending-before-history and tenant seeds", () => {
    expect(() => validateRecoveryManifest(manifest({ ...entry, sha256: "not-a-hash" }))).toThrow();
    expect(() => validateRecoveryManifest(manifest({ ...entry, kind: "tenant-data" }))).toThrow();
    expect(() => validateRecoveryManifest(manifest(entry, entry))).toThrow(/Duplicate/);
    expect(() => validateRecoveryManifest(manifest(entry, { ...entry, path: "supabase/recovery/history/old.sql", kind: "historical" }))).toThrow(/Pending changes/);
    expect(() => validateRecoveryManifest(manifest({ ...entry, path: "supabase/recovery/history/20261030094244_seed.sql" }))).toThrow(/Tenant-specific/);
    expect(() => validateRecoveryManifest(manifest({ ...entry, version: "20261030095353" }))).toThrow(/Tenant-specific/);
  });

  it("verifies every source before allocation, including pending sources in checkpoint mode", async () => {
    const actual = await readRecoveryManifest();
    const wrong: RecoveryManifest = { ...actual, plan: actual.plan.map((source) => source.kind === "pending" ? { ...source, sha256: "0".repeat(64) } : source) };
    wrong.order_sha256 = manifest(...wrong.plan).order_sha256;
    await expect(readRecoverySources(wrong, { applyPending: false })).rejects.toThrow(/source hash mismatch/);
  });

  it("rejects removed/reordered steps and an unverified platform contract", async () => {
    const actual = await readRecoveryManifest();
    expect(() => validateRecoveryManifest({ ...actual, plan: actual.plan.slice(1) })).toThrow(/order or membership/);
    expect(() => validateRecoveryManifest({ ...actual, plan: [actual.plan[1], actual.plan[0], ...actual.plan.slice(2)] })).toThrow(/order or membership/);
    await expect(readRecoverySources({ ...actual, platform_contract: { ...actual.platform_contract, sha256: "0".repeat(64) } })).rejects.toThrow(/platform-contract hash mismatch/);
  });

  it("keeps tenant bootstrap scripts archived but outside the replay plan", async () => {
    const actual = await readRecoveryManifest();
    expect(actual.plan).toHaveLength(105);
    expect(actual.plan.filter((source) => source.kind === "pending")).toHaveLength(35);
    expect(actual.plan.some((source) => source.path.endsWith("20261030_academic_teacher_self_management.sql"))).toBe(false);
    expect(actual.plan.some((source) => /20261030094244|20261030095353/.test(source.path))).toBe(false);
    const before = await readRecoverySources(actual, { applyPending: false });
    const after = await readRecoverySources(actual);
    expect(after.length - before.length).toBe(35);
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it("rejects a source symlink before reading outside the repository", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sms-recovery-link-"));
    const relative = `supabase/recovery/manual/recovery-test-${randomUUID()}.sql`;
    const link = new URL(`../${relative}`, import.meta.url);
    try {
      const target = path.join(directory, "external.sql");
      await writeFile(target, "select 1;");
      await symlink(target, link);
      const actual = await readRecoveryManifest();
      const altered = { ...actual, plan: [{ ...actual.plan[0], path: relative }] };
      altered.order_sha256 = manifest(...altered.plan).order_sha256;
      await expect(readRecoverySources(altered)).rejects.toThrow(/symlinks/);
    } finally { await rm(link, { force: true }); await rm(directory, { recursive: true, force: true }); }
  });
});

describe("complete empty application replay", () => {
  it("recreates all application tables/views and pending contracts without tenant data", async () => {
    const db = await createRecoveryDatabase();
    try {
      const counts = await db.query<{ tables: number; views: number }>(`select
        count(*) filter(where c.relkind='r')::int as tables,
        count(*) filter(where c.relkind='v')::int as views
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname in ('public','app_private')`);
      expect(counts.rows).toEqual([{ tables: 133, views: 5 }]);
      expect((await db.query("select count(*)::int as schools from public.schools")).rows).toEqual([{ schools: 0 }]);
      expect((await db.query("select count(*)::int as users from auth.users")).rows).toEqual([{ users: 0 }]);
      expect((await db.query("select count(*)::int as profiles from public.profiles")).rows).toEqual([{ profiles: 0 }]);
      const rls = await db.query<{ missing: number }>(`select count(*)::int as missing from pg_class c
        join pg_namespace n on n.oid=c.relnamespace
        where n.nspname in ('public','app_private') and c.relkind='r' and not c.relrowsecurity`);
      expect(rls.rows).toEqual([{ missing: 0 }]);
      expect((await db.query(`select count(*)::int as token from pg_attribute
        where attrelid='public.notices'::regclass and attname='version' and attnotnull and atttypid='uuid'::regtype`)).rows).toEqual([{ token: 1 }]);
      expect((await db.query(`select has_function_privilege('authenticated',
        'public.save_assessment_mark(uuid,timestamptz,uuid,uuid,timestamptz,numeric,text,numeric,text)','EXECUTE') as caller,
        has_function_privilege('anon','public.save_assessment_mark(uuid,timestamptz,uuid,uuid,timestamptz,numeric,text,numeric,text)','EXECUTE') as anonymous`)).rows).toEqual([{ caller: true, anonymous: false }]);
      expect((await db.query(`select p.prosecdef as definer,
        has_function_privilege('authenticated',p.oid,'EXECUTE') as browser,
        has_function_privilege('anon',p.oid,'EXECUTE') as anonymous,
        has_function_privilege('service_role',p.oid,'EXECUTE') as server
        from pg_proc p where p.oid=to_regprocedure('public.ingest_gate_attendance_event(uuid,text,text,text,text,timestamptz)')`)).rows)
        .toEqual([{ definer: false, browser: false, anonymous: false, server: true }]);
      expect((await db.query(`select p.proname,p.prosecdef as definer,
        has_function_privilege('authenticated',p.oid,'EXECUTE') as browser,
        has_function_privilege('anon',p.oid,'EXECUTE') as anonymous,
        has_function_privilege('service_role',p.oid,'EXECUTE') as server from pg_proc p
        where p.oid in(to_regprocedure('public.get_my_gate_alert_preferences()'),
          to_regprocedure('public.get_family_notification_inbox_v2(text,boolean,integer,timestamptz,text,uuid)'))
        order by p.proname collate "C"`)).rows).toEqual([
        { proname: "get_family_notification_inbox_v2", definer: false, browser: true, anonymous: false, server: false },
        { proname: "get_my_gate_alert_preferences", definer: false, browser: true, anonymous: false, server: false },
      ]);
      expect((await db.query(`select p.prosecdef as definer,p.provolatile,
        has_function_privilege('authenticated',p.oid,'EXECUTE') as browser,
        has_function_privilege('anon',p.oid,'EXECUTE') as anonymous,
        has_function_privilege('service_role',p.oid,'EXECUTE') as server from pg_proc p
        where p.oid=to_regprocedure('public.get_school_attendance_calendar(uuid,date,date)')`)).rows)
        .toEqual([{ definer: false, provolatile: "v", browser: true, anonymous: false, server: false }]);
      expect((await db.query(`select p.prosecdef as definer,p.provolatile,
        has_function_privilege('authenticated',p.oid,'EXECUTE') as browser,
        has_function_privilege('anon',p.oid,'EXECUTE') as anonymous,
        has_function_privilege('service_role',p.oid,'EXECUTE') as server from pg_proc p
        where p.oid=to_regprocedure('public.search_gate_pupils(uuid,text,integer)')`)).rows)
        .toEqual([{ definer: false, provolatile: "v", browser: true, anonymous: false, server: false }]);
      expect((await db.query(`select p.proname,p.prosecdef as definer,
        has_function_privilege('authenticated',p.oid,'EXECUTE') as browser,
        has_function_privilege('anon',p.oid,'EXECUTE') as anonymous,
        has_function_privilege('service_role',p.oid,'EXECUTE') as server from pg_proc p
        where p.oid in(to_regprocedure('public.get_school_late_alert_settings(uuid)'),
          to_regprocedure('public.get_family_notification_inbox_v3(text,boolean,integer,timestamptz,text,uuid)'))
        order by p.proname collate "C"`)).rows).toEqual([
        { proname: "get_family_notification_inbox_v3", definer: false, browser: true, anonymous: false, server: false },
        { proname: "get_school_late_alert_settings", definer: false, browser: true, anonymous: false, server: false },
      ]);
      expect((await db.query(`select p.prosecdef as definer,p.provolatile,
        has_function_privilege('authenticated',p.oid,'EXECUTE') as browser,
        has_function_privilege('anon',p.oid,'EXECUTE') as anonymous,
        has_function_privilege('service_role',p.oid,'EXECUTE') as server from pg_proc p
        where p.oid=to_regprocedure('public.get_family_attendance_summary(text,uuid,date)')`)).rows)
        .toEqual([{ definer: false, provolatile: "v", browser: true, anonymous: false, server: false }]);
      expect((await db.query(`select p.prosecdef as definer,p.provolatile,
        has_function_privilege('authenticated',p.oid,'EXECUTE') as browser,
        has_function_privilege('anon',p.oid,'EXECUTE') as anonymous,
        has_function_privilege('service_role',p.oid,'EXECUTE') as server from pg_proc p
        where p.oid=to_regprocedure('public.import_historical_attendance_calendar(uuid,uuid,jsonb,bigint,text,boolean,text,uuid)')`)).rows)
        .toEqual([{ definer: false, provolatile: "v", browser: true, anonymous: false, server: false }]);
      expect((await db.query(`select has_table_privilege('authenticated','app_private.school_attendance_policy_versions','INSERT') as policy,
        has_table_privilege('authenticated','public.school_holidays','INSERT,UPDATE,DELETE') as legacy_holiday,
        has_any_column_privilege('authenticated','public.school_holidays','INSERT,UPDATE,REFERENCES') as legacy_column_write,
        has_function_privilege('authenticated','app_private.resolve_attendance_calendar_day(uuid,date)','EXECUTE') as unchecked`)).rows)
        .toEqual([{ policy: false, legacy_holiday: false, legacy_column_write: false, unchecked: false }]);
      expect((await db.query<{ tgname: string }>("select tgname from pg_trigger where tgrelid='auth.users'::regclass and not tgisinternal order by tgname")).rows.map((row) => row.tgname)).toEqual([
        "follow_guardian_auth_contact", "guard_guardian_auth_contact", "on_auth_user_created",
      ]);
      expect((await db.query("select id,public from storage.buckets order by id")).rows).toEqual([
        { id: "homework-submissions", public: false }, { id: "report-cards", public: false },
        { id: "school-assets", public: false }, { id: "student-documents", public: false },
        { id: "study-materials", public: false },
      ]);
    } finally { await db.close(); }
  }, 30_000);

  it("reconstructs the deployed checkpoint separately from the pending patches", async () => {
    const db = await createRecoveryDatabase({ applyPending: false });
    try {
      expect((await db.query("select count(*)::int as token from pg_attribute where attrelid='public.notices'::regclass and attname='version' and not attisdropped")).rows).toEqual([{ token: 0 }]);
      expect((await db.query("select to_regprocedure('public.save_assessment_mark(uuid,timestamptz,uuid,uuid,timestamptz,numeric,text,numeric,text)') is null as pending")).rows).toEqual([{ pending: true }]);
      expect((await db.query("select to_regprocedure('public.ingest_gate_attendance_event(uuid,text,text,text,text,timestamptz)') is null as pending")).rows).toEqual([{ pending: true }]);
      expect((await db.query("select to_regprocedure('public.get_my_gate_alert_preferences()') is null as pending")).rows).toEqual([{ pending: true }]);
      expect((await db.query("select to_regprocedure('public.search_gate_pupils(uuid,text,integer)') is null as pending")).rows).toEqual([{ pending: true }]);
      expect((await db.query("select to_regprocedure('public.get_school_late_alert_settings(uuid)') is null as pending")).rows).toEqual([{ pending: true }]);
      expect((await db.query("select to_regprocedure('public.get_family_notification_inbox_v3(text,boolean,integer,timestamptz,text,uuid)') is null as pending")).rows).toEqual([{ pending: true }]);
      expect((await db.query("select to_regprocedure('public.get_school_attendance_calendar(uuid,date,date)') is null as pending")).rows).toEqual([{ pending: true }]);
      expect((await db.query("select to_regprocedure('public.get_family_attendance_summary(text,uuid,date)') is null as pending")).rows).toEqual([{ pending: true }]);
      expect((await db.query("select count(*)::int as tables from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app_private') and c.relkind='r'")).rows).toEqual([{ tables: 99 }]);
    } finally { await db.close(); }
  }, 30_000);

  it("rejects unexplained checkpoint drift before it can be accepted for hardening or seeding", async () => {
    const db = await createRecoveryDatabase({ applyPending: false });
    try {
      await db.exec("alter table public.students add column unexpected_recovery_field text");
      await expect(verifyDeployedCheckpoint(db)).rejects.toThrow(/1 changed objects/);
      expect((await db.query("select count(*)::int as users from auth.users")).rows).toEqual([{ users: 0 }]);
    } finally { await db.close(); }
  }, 30_000);

  it("refuses an occupied application target without altering its data", async () => {
    const db = new PGlite();
    try {
      await db.exec("create table public.existing(id int primary key);insert into public.existing values(1)");
      await expect(applyRecoveryPlan(db)).rejects.toThrow(/empty application schema/);
      expect((await db.query("select id from public.existing")).rows).toEqual([{ id: 1 }]);
    } finally { await db.close(); }
  });

  it.each(["create type public.existing as enum('retained')", "create function public.existing() returns int language sql as 'select 1'"])("refuses an existing type or routine target: %s", async (sql) => {
    const db = new PGlite();
    try {
      await db.exec(sql);
      await expect(applyRecoveryPlan(db)).rejects.toThrow(/empty application schema/);
    } finally { await db.close(); }
  });

  it.each([
    { relation: "auth.users", sql: "insert into auth.users(id,email) values('40000000-0000-0000-0000-000000000099','occupied@recovery.invalid')" },
    { relation: "storage.buckets", sql: "insert into storage.buckets(id,name) values('existing-provider-bucket','Preserve existing bucket')" },
    { relation: "auth.provider_state", sql: "create table auth.provider_state(id int primary key);insert into auth.provider_state values(7)" },
  ])("rejects occupied managed-only target $relation without changing catalog or data", async ({ relation, sql }) => {
    const db = new PGlite({ extensions: recoveryExtensions });
    try {
      await db.exec(await readFile(new URL("../scripts/database-recovery/platform-contract.sql", import.meta.url), "utf8"));
      await db.exec(sql);
      const beforeCatalog = catalogFingerprint(await captureCatalog(db));
      const beforeData = (await db.query(`select to_jsonb(rec) as row from ${relation} rec`)).rows;
      await expect(applyRecoveryPlan(db)).rejects.toThrow(/empty managed-service tables/);
      expect(catalogFingerprint(await captureCatalog(db))).toEqual(beforeCatalog);
      expect((await db.query(`select to_jsonb(rec) as row from ${relation} rec`)).rows).toEqual(beforeData);
      expect((await db.query("select count(*)::int as tables from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app_private') and c.relkind='r'")).rows).toEqual([{ tables: 0 }]);
    } finally { await db.close(); }
  });

  it("rejects an absent managed-service contract before creating any application objects", async () => {
    const db = new PGlite();
    try {
      const before = catalogFingerprint(await captureCatalog(db));
      await expect(applyRecoveryPlan(db)).rejects.toThrow(/complete local managed-service table contract/);
      expect(catalogFingerprint(await captureCatalog(db))).toEqual(before);
    } finally { await db.close(); }
  });

  it.each([
    "drop table auth.mfa_factors", "alter table auth.sessions drop column aal",
    "alter table auth.sessions drop column factor_id", "alter table auth.mfa_factors drop column status",
    "alter table auth.sessions alter column factor_id type text",
  ])("rejects incomplete native MFA contracts before applying application SQL: %s", async (sql) => {
    const db = new PGlite({ extensions: recoveryExtensions });
    try {
      await db.exec(await readFile(new URL("../scripts/database-recovery/platform-contract.sql", import.meta.url), "utf8"));
      await db.exec(sql);
      const before = catalogFingerprint(await captureCatalog(db));
      await expect(applyRecoveryPlan(db)).rejects.toThrow(/complete local managed-service/);
      expect(catalogFingerprint(await captureCatalog(db))).toEqual(before);
      expect((await db.query("select count(*)::int as count from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','app_private') and c.relkind='r'")).rows).toEqual([{ count: 0 }]);
    } finally { await db.close(); }
  });

  it("the managed-service contract is clearly separate from application SQL", async () => {
    const text = await readFile(new URL("../scripts/database-recovery/platform-contract.sql", import.meta.url), "utf8");
    expect(text).toContain("LOCAL TEST CONTRACT ONLY");
    expect(text).not.toMatch(/create\s+table\s+(?:public|app_private)\./i);
  });

  it("uses the captured JWT fallback and prefixed Storage-operation helpers", async () => {
    const db = await createRecoveryDatabase();
    try {
      const id = "40000000-0000-0000-0000-000000000001";
      await db.query("select set_config('request.jwt.claim.sub','',false),set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: id })]);
      expect((await db.query("select auth.uid()::text as id,auth.jwt()->>'sub' as jwt_id")).rows).toEqual([{ id, jwt_id: id }]);
      await db.query("select set_config('storage.operation','storage.object.upload',false)");
      expect((await db.query(`select storage.allow_only_operation('storage.object.upload') as prefixed,
        storage.allow_any_operation(array['object.upload']) as bare,
        storage.allow_only_operation('object.delete') as rejected,
        storage.foldername('school/year/file.pdf') as folders`)).rows).toEqual([
        { prefixed: true, bare: true, rejected: false, folders: ["school", "year"] },
      ]);
    } finally { await db.close(); }
  }, 30_000);
});
