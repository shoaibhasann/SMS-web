// @vitest-environment node

import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { asActor, createRoleTestDatabase, IDS, readRoleHardeningSql } from "./role-fixture";

type RoleDatabase = Awaited<ReturnType<typeof createRoleTestDatabase>>;
type RoleRow = { id: string; user_id: string; school_id: string | null; role: string; created_at: string };
const databases: RoleDatabase[] = [];
const assignmentSql = "select public.assign_school_role($1::uuid, $2::uuid, $3::public.app_role)";
const privateAssignmentSql = "select app_private.assign_school_role($1::uuid, $2::uuid, $3::public.app_role)";

async function database(options: { applyMigration?: boolean } = {}) {
  const db = await createRoleTestDatabase(options);
  databases.push(db);
  return db;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

async function allRoles(db: RoleDatabase): Promise<RoleRow[]> {
  return (await db.query<RoleRow>(`
    select id::text, user_id::text, school_id::text, role::text, created_at::text
    from public.user_roles order by id
  `)).rows;
}

async function visibleRoles(db: RoleDatabase, actor: string | null) {
  const result = await asActor(db, actor, `
    select user_id::text, school_id::text, role::text
    from public.user_roles order by user_id, school_id nulls first, role
  `);
  return result.rows as { user_id: string; school_id: string | null; role: string }[];
}

function grantsFor(rows: RoleRow[], userId: string, schoolId: string | null, role: string) {
  return rows.filter((row) => row.user_id === userId && row.school_id === schoolId && row.role === role);
}

async function expectDeniedWithoutMutation(db: RoleDatabase, operation: () => Promise<unknown>) {
  const before = await allRoles(db);
  await expect(operation()).rejects.toThrow();
  expect(await allRoles(db)).toEqual(before);
}

async function expectDirectMutationBlocked(db: RoleDatabase, operation: () => ReturnType<typeof asActor>) {
  const before = await allRoles(db);
  let result: Awaited<ReturnType<typeof asActor>> | undefined;
  try {
    result = await operation();
  } catch (error) {
    // Do not let an unrelated SQL typo or missing table make a security test
    // pass. Both ACL denial and RLS write denial use insufficient_privilege.
    expect(error).toMatchObject({ code: "42501" });
  }
  if (result) expect(result.rows).toEqual([]);
  expect(await allRoles(db)).toEqual(before);
}

async function asServiceActor(db: RoleDatabase, userId: string | null, sql: string, params: unknown[] = []) {
  await db.exec("begin; set local role service_role");
  try {
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId ?? ""]);
    const result = await db.query(sql, params);
    await db.exec("commit");
    return result;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

describe("recovered role-assignment vulnerabilities before the migration", () => {
  it("reproduces a student directly granting themselves super_admin in their school", async () => {
    const db = await database({ applyMigration: false });
    await asActor(db, IDS.studentA, `
      insert into public.user_roles (user_id, school_id, role)
      values ($1::uuid, $2::uuid, 'super_admin'::public.app_role)
    `, [IDS.studentA, IDS.schoolA]);

    expect(grantsFor(await allRoles(db), IDS.studentA, IDS.schoolA, "super_admin")).toHaveLength(1);
    const result = await asActor(db, IDS.studentA, "select public.current_user_has_role('super_admin'::public.app_role) as elevated");
    expect(result.rows).toEqual([{ elevated: true }]);
  });

  it("reproduces a school-A administrator using the old RPC to grant a role in school B", async () => {
    const db = await database({ applyMigration: false });
    await asActor(db, IDS.adminA, assignmentSql, [IDS.targetUser, IDS.schoolB, "school_admin"]);
    expect(grantsFor(await allRoles(db), IDS.targetUser, IDS.schoolB, "school_admin")).toHaveLength(1);
  });
});

describe("direct role-table access after the migration", () => {
  const ordinaryActors = ["teacherA", "parentA", "studentA"] as const;
  const directActors = [...ordinaryActors, "adminA", "adminB"] as const;

  it.each(directActors)("%s cannot directly INSERT a privileged role", async (actor) => {
    const db = await database();
    await expectDeniedWithoutMutation(db, () => asActor(db, IDS[actor], `
      insert into public.user_roles (user_id, school_id, role)
      values ($1::uuid, $2::uuid, 'super_admin'::public.app_role)
    `, [IDS[actor], actor === "adminB" ? IDS.schoolB : IDS.schoolA]));
  });

  it.each(directActors)("%s cannot directly UPDATE their own role to super_admin", async (actor) => {
    const db = await database();
    // A revoked privilege may reject; an RLS-hidden row may instead affect zero
    // rows. Either mechanism must preserve the actual role records.
    await expectDirectMutationBlocked(db, () => asActor(db, IDS[actor], `
      update public.user_roles set role = 'super_admin'::public.app_role
      where user_id = $1::uuid returning id
    `, [IDS[actor]]));
  });

  it.each(directActors)("%s cannot directly DELETE their own role", async (actor) => {
    const db = await database();
    await expectDirectMutationBlocked(db, () => asActor(db, IDS[actor], "delete from public.user_roles where user_id = $1::uuid returning id", [IDS[actor]]));
  });

  it.each(ordinaryActors)("%s sees their own role without seeing other users' roles", async (actor) => {
    const db = await database();
    const rows = await visibleRoles(db, IDS[actor]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.user_id === IDS[actor])).toBe(true);
  });

  it("a user without a role sees no other user's role", async () => {
    const db = await database();
    expect(await visibleRoles(db, IDS.targetUser)).toEqual([]);
  });

  it.each([
    ["adminA", "schoolA", "schoolB"],
    ["adminB", "schoolB", "schoolA"],
  ] as const)("%s can read %s roles without seeing %s roles", async (actor, ownSchool, otherSchool) => {
    const db = await database();
    const expected = (await allRoles(db)).filter((row) => row.school_id === IDS[ownSchool]);
    const actual = await visibleRoles(db, IDS[actor]);
    expect(actual).toHaveLength(expected.length);
    expect(actual.every((row) => row.school_id === IDS[ownSchool])).toBe(true);
    expect(actual.some((row) => row.school_id === IDS[otherSchool])).toBe(false);
    expect(actual.some((row) => row.school_id === null)).toBe(false);
    expect(actual.some((row) => row.user_id === IDS[actor] && row.role === "school_admin")).toBe(true);
  });

  it("the trusted super administrator can read roles across both schools and global scope", async () => {
    const db = await database();
    const rows = await visibleRoles(db, IDS.superAdmin);
    expect(rows).toHaveLength((await allRoles(db)).length);
    expect(new Set(rows.map((row) => row.school_id))).toEqual(new Set([null, IDS.schoolA, IDS.schoolB]));
  });
});

describe("school-scoped role assignment RPC", () => {
  it("allows a school admin to grant ordinary roles in their own school", async () => {
    const db = await database();
    await asActor(db, IDS.adminA, assignmentSql, [IDS.targetUser, IDS.schoolA, "teacher"]);
    await asActor(db, IDS.adminA, assignmentSql, [IDS.targetUser, IDS.schoolA, "school_admin"]);
    const rows = await allRoles(db);
    expect(grantsFor(rows, IDS.targetUser, IDS.schoolA, "teacher")).toHaveLength(1);
    expect(grantsFor(rows, IDS.targetUser, IDS.schoolA, "school_admin")).toHaveLength(1);
  });

  it("allows assigning a user from school B into A while retaining the existing B role", async () => {
    const db = await database();
    await asActor(db, IDS.adminA, assignmentSql, [IDS.teacherB, IDS.schoolA, "teacher"]);
    const roles = await allRoles(db);
    expect(grantsFor(roles, IDS.teacherB, IDS.schoolA, "teacher")).toHaveLength(1);
    expect(grantsFor(roles, IDS.teacherB, IDS.schoolB, "teacher")).toHaveLength(1);

    const visibleToAdminA = (await visibleRoles(db, IDS.adminA)).filter((row) => row.user_id === IDS.teacherB);
    expect(visibleToAdminA).toEqual([{ user_id: IDS.teacherB, school_id: IDS.schoolA, role: "teacher" }]);
    const visibleToTeacherB = (await visibleRoles(db, IDS.teacherB)).filter((row) => row.user_id === IDS.teacherB);
    expect(visibleToTeacherB).toHaveLength(2);
  });

  it.each([
    ["adminA", "schoolB"],
    ["adminB", "schoolA"],
  ] as const)("%s cannot grant a role in the other school", async (actor, school) => {
    const db = await database();
    await expectDeniedWithoutMutation(db, () => asActor(db, IDS[actor], assignmentSql, [IDS.targetUser, IDS[school], "teacher"]));
  });

  it.each(["teacherA", "parentA", "studentA", "targetUser"] as const)("%s cannot grant any role through the RPC", async (actor) => {
    const db = await database();
    await expectDeniedWithoutMutation(db, () => asActor(db, IDS[actor], assignmentSql, [IDS.targetUser, IDS.schoolA, "teacher"]));
  });

  it("a school admin cannot grant super_admin even within their school or to themselves", async () => {
    const db = await database();
    await expectDeniedWithoutMutation(db, () => asActor(db, IDS.adminA, assignmentSql, [IDS.targetUser, IDS.schoolA, "super_admin"]));
    await expectDeniedWithoutMutation(db, () => asActor(db, IDS.adminA, assignmentSql, [IDS.adminA, IDS.schoolA, "super_admin"]));
    await expectDeniedWithoutMutation(db, () => asActor(db, IDS.adminA, assignmentSql, [IDS.targetUser, null, "super_admin"]));
  });

  it("the trusted super administrator can assign school roles in A/B and a global super_admin", async () => {
    const db = await database();
    await asActor(db, IDS.superAdmin, assignmentSql, [IDS.targetUser, IDS.schoolA, "school_admin"]);
    await asActor(db, IDS.superAdmin, assignmentSql, [IDS.targetUser, IDS.schoolB, "teacher"]);
    await asActor(db, IDS.superAdmin, assignmentSql, [IDS.targetUser, null, "super_admin"]);
    const rows = await allRoles(db);
    expect(grantsFor(rows, IDS.targetUser, IDS.schoolA, "school_admin")).toHaveLength(1);
    expect(grantsFor(rows, IDS.targetUser, IDS.schoolB, "teacher")).toHaveLength(1);
    expect(grantsFor(rows, IDS.targetUser, null, "super_admin")).toHaveLength(1);
  });

  it.each(["school_admin", "principal", "teacher", "accountant", "reception_staff", "parent", "student"])("rejects NULL school for ordinary role %s even for super_admin", async (role) => {
    const db = await database();
    await expectDeniedWithoutMutation(db, () => asActor(db, IDS.superAdmin, assignmentSql, [IDS.targetUser, null, role]));
  });

  it.each([
    [null, "authenticated"],
    [null, "anon"],
    ["superAdmin", "anon"],
  ] as const)("rejects missing auth or anon execution (%s, %s)", async (actor, dbRole) => {
    const db = await database();
    const actorId = actor === "superAdmin" ? IDS.superAdmin : null;
    await expectDeniedWithoutMutation(db, () => asActor(db, actorId, assignmentSql, [IDS.targetUser, IDS.schoolA, "teacher"], dbRole));
  });

  it("does not allow direct calls to the private core to bypass school/promotion/auth checks", async () => {
    const db = await database();
    for (const [actor, school, role] of [
      [IDS.adminA, IDS.schoolB, "teacher"],
      [IDS.adminA, IDS.schoolA, "super_admin"],
      [IDS.studentA, IDS.schoolA, "teacher"],
      [null, IDS.schoolA, "teacher"],
    ] as const) {
      await expectDeniedWithoutMutation(db, () => asActor(db, actor, privateAssignmentSql, [IDS.targetUser, school, role]));
    }
    await expectDeniedWithoutMutation(db, () => asActor(db, IDS.superAdmin, privateAssignmentSql, [IDS.targetUser, IDS.schoolA, "teacher"], "anon"));
  });

  it("keeps repeated school and NULL-global grants idempotent without deleting existing roles", async () => {
    const db = await database();
    const seeded = await allRoles(db);
    for (let attempt = 0; attempt < 3; attempt++) {
      await asActor(db, IDS.adminA, assignmentSql, [IDS.targetUser, IDS.schoolA, "teacher"]);
      await asActor(db, IDS.superAdmin, assignmentSql, [IDS.targetUser, null, "super_admin"]);
    }
    const rows = await allRoles(db);
    expect(grantsFor(rows, IDS.targetUser, IDS.schoolA, "teacher")).toHaveLength(1);
    expect(grantsFor(rows, IDS.targetUser, null, "super_admin")).toHaveLength(1);
    expect(rows).toHaveLength(seeded.length + 2);
    for (const original of seeded) expect(rows.find((row) => row.id === original.id)).toEqual(original);
  });

  it("the management helper distinguishes school A/B and global scope without granting mutation authority to ordinary users", async () => {
    const db = await database();
    const result = await asActor(db, IDS.adminA, `
      select app_private.can_manage_school_roles($1::uuid) as own_school,
             app_private.can_manage_school_roles($2::uuid) as other_school,
             app_private.can_manage_school_roles(null::uuid) as global_scope
    `, [IDS.schoolA, IDS.schoolB]);
    expect(result.rows).toEqual([{ own_school: true, other_school: false, global_scope: false }]);
    const ordinary = await asActor(db, IDS.studentA, "select app_private.can_manage_school_roles($1::uuid) as allowed", [IDS.schoolA]);
    expect(ordinary.rows).toEqual([{ allowed: false }]);
  });

  it("preserves service-role RPC execution with an authenticated admin subject and its school boundary", async () => {
    const db = await database();
    await asServiceActor(db, IDS.adminA, assignmentSql, [IDS.targetUser, IDS.schoolA, "teacher"]);
    expect(grantsFor(await allRoles(db), IDS.targetUser, IDS.schoolA, "teacher")).toHaveLength(1);
    await expectDeniedWithoutMutation(db, () => asServiceActor(db, IDS.adminA, assignmentSql, [IDS.targetUser, IDS.schoolB, "teacher"]));
  });

  it("does not let a service-role caller without an authenticated actor bypass RPC authorization", async () => {
    const db = await database();
    await expectDeniedWithoutMutation(db, () => asServiceActor(db, null, assignmentSql, [IDS.targetUser, IDS.schoolA, "teacher"]));
  });
});

describe("role hardening migration replay", () => {
  it("can run twice and preserves all existing role values, IDs and creation times", async () => {
    const db = await database({ applyMigration: false });
    const before = await allRoles(db);
    const migration = await readRoleHardeningSql();
    expect(migration.trim()).not.toBe("");
    await db.exec(migration);
    expect(await allRoles(db)).toEqual(before);
    await asActor(db, IDS.adminA, assignmentSql, [IDS.targetUser, IDS.schoolA, "teacher"]);
    const afterGrant = await allRoles(db);
    await db.exec(migration);
    expect(await allRoles(db)).toEqual(afterGrant);
    await asActor(db, IDS.adminA, assignmentSql, [IDS.targetUser, IDS.schoolA, "teacher"]);
    expect(await allRoles(db)).toEqual(afterGrant);
  });

  it.each(["unexpected-policy", "unexpected-trigger", "inherited-write-grant"])("aborts atomically for %s instead of leaving a partial hotfix", async (variant) => {
    const db = await database({ applyMigration: false });
    if (variant === "unexpected-policy") {
      await db.exec("create policy extra_role_write on public.user_roles for insert to authenticated with check (true)");
    }
    if (variant === "unexpected-trigger") {
      await db.exec(`
        create function public.extra_role_trigger() returns trigger language plpgsql
          as $$ begin return new; end $$;
        create trigger extra_role_write before insert on public.user_roles
          for each row execute function public.extra_role_trigger();
      `);
    }
    if (variant === "inherited-write-grant") {
      await db.exec(`
        create role role_test_writer nologin;
        grant insert on public.user_roles to role_test_writer;
        grant role_test_writer to authenticated;
      `);
    }
    const beforeRoles = await allRoles(db);
    const metadata = async () => (await db.query(`
      select c.relacl::text as table_acl,
        array(select p.polname::text from pg_policy p where p.polrelid = c.oid order by p.polname) as policies,
        (select prosecdef from pg_proc where oid = 'public.assign_school_role(uuid,uuid,public.app_role)'::regprocedure) as public_definer,
        to_regprocedure('app_private.assign_school_role(uuid,uuid,public.app_role)')::text as private_implementation,
        has_table_privilege('authenticated', c.oid, 'INSERT') as authenticated_insert
      from pg_class c where c.oid = 'public.user_roles'::regclass
    `)).rows;
    const beforeMetadata = await metadata();
    const migration = await readRoleHardeningSql();
    await expect(db.exec(migration)).rejects.toThrow(/Unexpected user_roles|write privileges remain/);
    await db.exec("rollback");
    expect(await allRoles(db)).toEqual(beforeRoles);
    expect(await metadata()).toEqual(beforeMetadata);
  });

  it("removes explicit authenticated column UPDATE grants along with table write privileges", async () => {
    const db = await database({ applyMigration: false });
    await db.exec("grant update (role) on public.user_roles to authenticated");
    const beforeRoles = await allRoles(db);
    const explicitAcl = await db.query<{ column_acl: string }>(`
      select attacl::text as column_acl from pg_attribute
      where attrelid = 'public.user_roles'::regclass and attname = 'role'
    `);
    expect(explicitAcl.rows[0].column_acl).toContain("authenticated=w");
    // PostgreSQL REVOKE ALL ON TABLE also removes corresponding explicit
    // column grants from that grantee; this safe case need not abort.
    await db.exec(await readRoleHardeningSql());
    const access = await db.query<{ can_update: boolean }>(`
      select has_column_privilege('authenticated', 'public.user_roles', 'role', 'UPDATE') as can_update
    `);
    expect(access.rows).toEqual([{ can_update: false }]);
    await expectDirectMutationBlocked(db, () => asActor(db, IDS.teacherA,
      "update public.user_roles set role = 'super_admin' where user_id = $1 returning id", [IDS.teacherA]));
    expect(await allRoles(db)).toEqual(beforeRoles);
  });

  it("preserves preexisting duplicate global grants and does not add another duplicate", async () => {
    const db = await database({ applyMigration: false });
    await db.query("insert into public.user_roles(user_id, school_id, role) values ($1, null, 'super_admin')", [IDS.superAdmin]);
    const before = await allRoles(db);
    expect(grantsFor(before, IDS.superAdmin, null, "super_admin")).toHaveLength(2);
    await db.exec(await readRoleHardeningSql());
    expect(await allRoles(db)).toEqual(before);
    await asActor(db, IDS.superAdmin, assignmentSql, [IDS.superAdmin, null, "super_admin"]);
    expect(await allRoles(db)).toEqual(before);
  });

  it("runs all 15 manual verification flags before/after and does not modify role rows", async () => {
    const db = await database({ applyMigration: false });
    const verification = await readFile(new URL("../../supabase/manual/verify-role-permissions.sql", import.meta.url), "utf8");
    const beforeRoles = await allRoles(db);
    const before = (await db.query<{ check_name: string; passes: boolean }>(verification)).rows;
    expect(before).toHaveLength(15);
    expect(new Set(before.map((row) => row.check_name)).size).toBe(15);
    expect(before.every((row) => row.check_name && typeof row.passes === "boolean")).toBe(true);
    expect(before.some((row) => !row.passes)).toBe(true);
    expect(await allRoles(db)).toEqual(beforeRoles);

    await db.exec(await readRoleHardeningSql());
    const after = (await db.query<{ check_name: string; passes: boolean }>(verification)).rows;
    expect(after.map((row) => row.check_name)).toEqual(before.map((row) => row.check_name));
    expect(after.filter((row) => !row.passes)).toEqual([]);
    expect(after.every((row) => row.passes === true)).toBe(true);
    expect(await allRoles(db)).toEqual(beforeRoles);
  });
});
