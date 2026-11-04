// @vitest-environment node

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createTeachingGovernanceDatabase, readTeachingGovernanceSql } from "./staff-scope-fixture";

type Database = Awaited<ReturnType<typeof createTeachingGovernanceDatabase>>;
type Check = { check_name: string; passes: boolean };

async function applicationData(db: Database) {
  const tables = (await db.query<{ name: string }>(`
    select c.relname as name from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' order by c.relname
  `)).rows;
  const hashes: Record<string, string> = {};
  for (const { name } of tables) {
    const identifier = `"${name.replaceAll('"', '""')}"`;
    const result = await db.query<{ value: string }>(`
      select md5(coalesce(jsonb_agg(r.value order by r.value::text), '[]'::jsonb)::text) as value
      from (select to_jsonb(t) as value from public.${identifier} t) r
    `);
    hashes[name] = result.rows[0].value;
  }
  return hashes;
}

describe("manual teaching-governance verification", () => {
  it("reports all 26 checks after the patch, preserves every application table and detects unsafe definer drift", async () => {
    const db = await createTeachingGovernanceDatabase({ applyMigration: false });
    try {
      const sql = await readFile(new URL("../../supabase/manual/verify-teaching-governance.sql", import.meta.url), "utf8");
      const original = await applicationData(db);
      const before = (await db.query<Check>(sql)).rows;
      expect(before).toHaveLength(26);
      expect(before.some((check) => check.passes === false)).toBe(true);
      expect(new Set(before.map((check) => check.check_name)).size).toBe(26);
      expect(await applicationData(db)).toEqual(original);

      await db.exec(await readTeachingGovernanceSql());
      const after = (await db.query<Check>(sql)).rows;
      expect(after.map((check) => check.check_name)).toEqual(before.map((check) => check.check_name));
      expect(after.filter((check) => check.passes !== true)).toEqual([]);
      expect(await applicationData(db)).toEqual(original);

      // The guard must execute as the caller. Making it a definer would let
      // the trusted-owner exception swallow ordinary API identity edits.
      await db.exec("alter function app_private.guard_academic_identity() security definer");
      const drift = (await db.query<Check>(sql)).rows;
      expect(drift.find((check) => check.check_name === "five_governance_function_security_contracts")?.passes).toBe(false);
      expect(await applicationData(db)).toEqual(original);
    } finally {
      await db.close();
    }
  });

  it("rejects an unexpected custom trigger without leaving partial governance changes", async () => {
    const db = await createTeachingGovernanceDatabase({ applyMigration: false });
    try {
      await db.exec(`create trigger unmanaged_profile_update before update on public.profiles
        for each row execute function public.set_updated_at()`);
      const original = await applicationData(db);
      const metadata = async () => (await db.query(`
        select count(*) as policies,
          to_regprocedure('app_private.guard_academic_identity()')::text as identity_guard
        from pg_catalog.pg_policy where polrelid='public.teacher_subject_assignments'::regclass
      `)).rows;
      const before = await metadata();
      await expect(db.exec(await readTeachingGovernanceSql())).rejects.toThrow(/trigger/i);
      await db.exec("rollback");
      expect(await metadata()).toEqual(before);
      expect(await applicationData(db)).toEqual(original);
      expect((await db.query("select 1 from pg_catalog.pg_trigger where tgname='unmanaged_profile_update'")).rows).toHaveLength(1);
    } finally {
      await db.close();
    }
  });
});
