// @vitest-environment node

import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { asStaffActor, createTeachingGovernanceDatabase, STAFF_IDS as I } from "./staff-scope-fixture";

type Database = Awaited<ReturnType<typeof createTeachingGovernanceDatabase>>;
const databases: Database[] = [];
const migrationUrl = new URL("../../supabase/migrations/20261105184939_require_active_role_assignment_actor.sql", import.meta.url);
const grantSql = "select public.assign_school_role($1::uuid,$2::uuid,$3::public.app_role)";

async function database(applyMigration = true) {
  const db = await createTeachingGovernanceDatabase();
  databases.push(db);
  if (applyMigration) await db.exec(await readFile(migrationUrl, "utf8"));
  return db;
}

async function roles(db: Database) {
  return (await db.query<{ user_id: string; school_id: string | null; role: string }>(
    "select user_id,school_id,role from public.user_roles order by user_id,school_id,role",
  )).rows;
}

async function denyGrant(db: Database, actor: string | null, school: string | null = I.schoolA, role = "teacher") {
  const before = await roles(db);
  await expect(asStaffActor(db, actor, grantSql, [I.outsider, school, role])).rejects.toThrow();
  expect(await roles(db)).toEqual(before);
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

describe("active role authority regression", () => {
  it("reproduces disabled admin role assignment and self-reactivation before the patch", async () => {
    const db = await database(false);
    await db.query("update public.profiles set is_active=false where id=$1", [I.adminA]);
    await asStaffActor(db, I.adminA, grantSql, [I.outsider, I.schoolA, "teacher"]);
    expect((await roles(db)).some((r) => r.user_id === I.outsider)).toBe(true);
    await asStaffActor(db, I.adminA, "update public.profiles set is_active=true where id=$1 returning id", [I.adminA]);
    expect((await db.query("select is_active from public.profiles where id=$1", [I.adminA])).rows).toEqual([{ is_active: true }]);
  });

  it.each(["adminA", "superAdmin"] as const)("disabled %s cannot grant roles via either RPC or reactivate themselves", async (name) => {
    const db = await database();
    await db.query("update public.profiles set is_active=false where id=$1", [I[name]]);
    await denyGrant(db, I[name]);
    await expect(asStaffActor(db, I[name], "select app_private.assign_school_role($1,$2,'teacher')", [I.outsider, I.schoolA])).rejects.toThrow(/active account/i);
    await expect(asStaffActor(db, I[name], "update public.profiles set is_active=true where id=$1 returning id", [I[name]])).rejects.toThrow(/Own-profile edits/);
    expect((await db.query("select is_active from public.profiles where id=$1", [I[name]])).rows).toEqual([{ is_active: false }]);
  });

  it("disabled principal cannot reactivate themselves or exercise staff policies", async () => {
    const db = await database();
    await db.query("update public.profiles set is_active=false where id=$1", [I.principalA]);
    await expect(asStaffActor(db, I.principalA, "update public.profiles set is_active=true where id=$1", [I.principalA])).rejects.toThrow(/Own-profile edits/);
    const result = await asStaffActor(db, I.principalA, "select id from public.students");
    expect(result.rows).toEqual([]);
  });

  it("the coexisting legacy admin student policy cannot bypass disabled-account checks", async () => {
    const db = await database();
    await db.query("update public.profiles set is_active=false where id=$1", [I.adminA]);
    expect((await asStaffActor(db, I.adminA, "select id from public.students")).rows).toEqual([]);
    expect((await asStaffActor(db, I.adminA, "update public.students set first_name='Tampered' returning id")).rows).toEqual([]);
    expect((await asStaffActor(db, I.adminA, "select public.is_school_admin_for_school($1) as allowed", [I.schoolA])).rows).toEqual([{ allowed: false }]);
  });

  it("active admin can reactivate a disabled school user, then role granting works on a fresh request", async () => {
    const db = await database();
    await db.query("update public.profiles set is_active=false where id=$1", [I.adminA]);
    await denyGrant(db, I.adminA);
    await asStaffActor(db, I.superAdmin, "update public.profiles set is_active=true where id=$1 returning id", [I.adminA]);
    await asStaffActor(db, I.adminA, grantSql, [I.outsider, I.schoolA, "teacher"]);
    expect((await roles(db)).filter((r) => r.user_id === I.outsider)).toEqual([{ user_id: I.outsider, school_id: I.schoolA, role: "teacher" }]);
    await db.query("update public.profiles set is_active=false where id=$1", [I.teacherA]);
    const result = await asStaffActor(db, I.adminA, "update public.profiles set is_active=true where id=$1 returning id", [I.teacherA]);
    expect(result.rows).toEqual([{ id: I.teacherA }]);
  });

  it("retains own name/phone/avatar edits but prevents inactive account security-field edits", async () => {
    const db = await database();
    await db.query("update public.profiles set is_active=false where id=$1", [I.adminA]);
    const result = await asStaffActor(db, I.adminA, "update public.profiles set full_name='Renamed',phone='9876543210' where id=$1 returning full_name,phone", [I.adminA]);
    expect(result.rows).toEqual([{ full_name: "Renamed", phone: "9876543210" }]);
    await expect(asStaffActor(db, I.adminA, "update public.profiles set email='changed@example.test' where id=$1", [I.adminA])).rejects.toThrow(/Own-profile edits/);
  });

  it.each(["teacherA", "parentA", "studentA", "principalA", "outsider"] as const)("%s cannot assign school roles", async (actor) => {
    await denyGrant(await database(), I[actor]);
  });

  it("denies missing profile, missing identity, revoked role, wrong school and super-admin escalation", async () => {
    const db = await database();
    await denyGrant(db, null);
    await denyGrant(db, I.adminA, I.schoolB);
    await denyGrant(db, I.adminA, null, "super_admin");
    await db.query("delete from public.user_roles where user_id=$1", [I.adminA]);
    await denyGrant(db, I.adminA);
    await db.query("delete from public.profiles where id=$1", [I.adminB]);
    await denyGrant(db, I.adminB, I.schoolB);
  });

  it("idempotently grants ordinary school roles and global super admin without broadening Principal authority", async () => {
    const db = await database();
    for (let retry = 0; retry < 2; retry++) {
      await asStaffActor(db, I.adminA, grantSql, [I.outsider, I.schoolA, "teacher"]);
      await asStaffActor(db, I.superAdmin, grantSql, [I.outsider, null, "super_admin"]);
    }
    expect((await roles(db)).filter((r) => r.user_id === I.outsider)).toHaveLength(2);
    await denyGrant(db, I.principalA);
    await denyGrant(db, I.superAdmin, I.schoolA, "super_admin");
  });

  it("requires a locked target profile even when its Auth account exists", async () => {
    const db = await database();
    await db.query("delete from public.profiles where id=$1", [I.outsider]);
    await denyGrant(db, I.adminA);
    expect((await db.query("select id from auth.users where id=$1", [I.outsider])).rows).toEqual([{ id: I.outsider }]);
    // A user's own profile is one row, not two independent lock targets.
    await asStaffActor(db, I.adminA, grantSql, [I.adminA, I.schoolA, "teacher"]);
    expect((await roles(db)).some((r) => r.user_id === I.adminA && r.role === "teacher")).toBe(true);
  });

  it("ignores malformed school-scoped super-admin history without deleting it", async () => {
    const db = await database();
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'super_admin')", [I.outsider, I.schoolA]);
    await denyGrant(db, I.outsider, I.schoolB);
    const flags = await asStaffActor(db, I.outsider, "select app_private.has_school_roles($1,array['super_admin']::public.app_role[]) as privileged, app_private.can_manage_school_roles($1) as manages", [I.schoolA]);
    expect(flags.rows).toEqual([{ privileged: false, manages: false }]);
    expect((await roles(db)).filter((r) => r.user_id === I.outsider)).toHaveLength(1);
  });

  it("disabled admin reads only their own role; active admin retains school-scoped visibility", async () => {
    const db = await database();
    expect((await asStaffActor(db, I.adminA, "select user_id,school_id from public.user_roles")).rows.length).toBeGreaterThan(1);
    await db.query("update public.profiles set is_active=false where id=$1", [I.adminA]);
    expect((await asStaffActor(db, I.adminA, "select user_id from public.user_roles")).rows).toEqual([{ user_id: I.adminA }]);
  });

  it("keeps the helper schema private, pins paths and denies anonymous RPC execution", async () => {
    const db = await database();
    await expect(asStaffActor(db, null, grantSql, [I.outsider, I.schoolA, "teacher"], "anon")).rejects.toMatchObject({ code: "42501" });
    const helper = await db.query("select p.prosecdef,p.proconfig,has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' and p.proname in ('has_school_roles','can_manage_school_roles','assign_school_role')");
    expect(helper.rows).toHaveLength(3);
    for (const row of helper.rows) expect(row).toMatchObject({ prosecdef: true, proconfig: ['search_path=""'], anon_execute: false });
  });

  it("refuses a missing profile guard atomically", async () => {
    const db = await database(false);
    await db.exec("drop trigger trg_guard_academic_identity on public.profiles");
    const before = await roles(db);
    await expect(db.exec(await readFile(migrationUrl, "utf8"))).rejects.toThrow(/identity guard/);
    await db.exec("rollback");
    expect(await roles(db)).toEqual(before);
  });
});
