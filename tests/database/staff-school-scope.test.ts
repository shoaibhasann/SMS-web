// @vitest-environment node

import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  asStaffActor, createStaffScopeDatabase, readStaffScopeSql, SCHOOL_B_PROBES,
  STAFF_IDS as IDS, STAFF_ROWS as ROWS, STAFF_SCOPE_TABLES,
} from "./staff-scope-fixture";

type StaffDb = Awaited<ReturnType<typeof createStaffScopeDatabase>>;
const databases: StaffDb[] = [];
const officeActors = ["adminA", "principalA", "accountantA", "receptionA"] as const;
async function database(options: { applyMigration?: boolean } = {}) {
  const db = await createStaffScopeDatabase(options);
  databases.push(db);
  return db;
}
afterEach(async () => { await Promise.all(databases.splice(0).map((db) => db.close())); });

async function state(db: StaffDb) {
  return (await db.query(`
    select (select jsonb_agg(to_jsonb(r) order by id) from public.user_roles r) as roles,
           (select jsonb_agg(to_jsonb(r) order by id) from public.students r) as students,
           (select jsonb_agg(to_jsonb(r) order by id) from public.enrollments r) as enrollments,
           (select jsonb_agg(to_jsonb(r) order by id) from public.teacher_subject_assignments r) as assignments,
           (select jsonb_agg(to_jsonb(r) order by id) from public.student_fees r) as fees,
           (select jsonb_agg(to_jsonb(r) order by id) from public.fee_payments r) as payments,
           (select jsonb_agg(to_jsonb(r) order by id) from public.fee_structures r) as structures,
           (select jsonb_agg(to_jsonb(r) order by id) from public.class_activities r) as activities,
           (select jsonb_agg(to_jsonb(r) order by student_id,parent_id) from public.student_parents r) as parent_links,
           (select jsonb_agg(to_jsonb(r) order by id) from public.notices r) as notices
  `)).rows;
}

async function expectBlocked(db: StaffDb, operation: () => Promise<unknown>) {
  const before = await state(db);
  try {
    const result = await operation() as { rows?: unknown[] };
    expect(result.rows).toEqual([]);
  } catch (error) {
    expect(error).toMatchObject({ code: "42501" });
  }
  expect(await state(db)).toEqual(before);
}

describe("recovered global staff-policy regression", () => {
  it("after the role-assignment fix alone, accountant A still reads and edits school B finance", async () => {
    const db = await database({ applyMigration: false });
    const rows = await asStaffActor(db, IDS.accountantA, SCHOOL_B_PROBES.fee_structures.sql, SCHOOL_B_PROBES.fee_structures.params);
    expect(rows.rows).toEqual([{ id: ROWS.B.structure }]);
    await asStaffActor(db, IDS.accountantA, "update public.fee_structures set amount=1250 where id=$1 returning id", [ROWS.B.structure]);
    const actual = await db.query<{ amount: string }>("select amount::text from public.fee_structures where id=$1", [ROWS.B.structure]);
    expect(actual.rows).toEqual([{ amount: "1250.00" }]);
  });

  it("captures the original students/enrollments policy-expansion cycle instead of omitting either policy", async () => {
    const db = await database({ applyMigration: false });
    await expect(asStaffActor(db, IDS.accountantA, SCHOOL_B_PROBES.students.sql, SCHOOL_B_PROBES.students.params)).rejects.toMatchObject({ code: "42P17" });
    await expect(asStaffActor(db, IDS.accountantA, SCHOOL_B_PROBES.enrollments.sql, SCHOOL_B_PROBES.enrollments.params)).rejects.toMatchObject({ code: "42P17" });
  });
});

describe("office school boundaries with all coexisting policies", () => {
  it.each(officeActors)("%s cannot read B rows in any of the 17 affected tables", async (actor) => {
    const db = await database();
    for (const table of STAFF_SCOPE_TABLES) {
      const probe = SCHOOL_B_PROBES[table];
      const result = await asStaffActor(db, IDS[actor], probe.sql, probe.params);
      expect(result.rows, `${actor} must not read school B ${table}`).toEqual([]);
    }
  });

  it.each(officeActors)("%s retains own-school finance CRUD but cannot insert, update or delete a B fee structure", async (actor) => {
    const db = await database();
    const created = await asStaffActor<{ id: string }>(db, IDS[actor], `
      insert into public.fee_structures(school_id,academic_year_id,name,amount)
      values($1,$2,'Authorized local fee',300) returning id
    `, [IDS.schoolA, ROWS.A.year]);
    const id = created.rows[0].id;
    expect((await asStaffActor(db, IDS[actor], "select id from public.fee_structures where id=$1", [id])).rows).toEqual([{ id }]);
    expect((await asStaffActor(db, IDS[actor], "update public.fee_structures set amount=350 where id=$1 returning id", [id])).rows).toEqual([{ id }]);
    expect((await asStaffActor(db, IDS[actor], "delete from public.fee_structures where id=$1 returning id", [id])).rows).toEqual([{ id }]);

    await expectBlocked(db, () => asStaffActor(db, IDS[actor], `
      insert into public.fee_structures(school_id,academic_year_id,name,amount)
      values($1,$2,'Denied B fee',300) returning id
    `, [IDS.schoolB, ROWS.B.year]));
    await expectBlocked(db, () => asStaffActor(db, IDS[actor], "update public.fee_structures set amount=300 where id=$1 returning id", [ROWS.B.structure]));
    await expectBlocked(db, () => asStaffActor(db, IDS[actor], "delete from public.fee_structures where id=$1 returning id", [ROWS.B.structure]));
    await expectBlocked(db, () => asStaffActor(db, IDS[actor], "update public.fee_structures set school_id=$1 where id=$2 returning id", [IDS.schoolB, ROWS.A.structure]));
  });

  it("scopes child-row activity CRUD through its class log, including UPDATE reparenting", async () => {
    const db = await database();
    const created = await asStaffActor<{ id: string }>(db, IDS.receptionA, `
      insert into public.class_activities(class_log_id,activity_type,title) values($1,'homework','Local activity') returning id
    `, [ROWS.A.log]);
    const id = created.rows[0].id;
    await asStaffActor(db, IDS.receptionA, "update public.class_activities set title='Updated' where id=$1 returning id", [id]);
    await expectBlocked(db, () => asStaffActor(db, IDS.receptionA, "update public.class_activities set class_log_id=$1 where id=$2 returning id", [ROWS.B.log, id]));
    await expectBlocked(db, () => asStaffActor(db, IDS.receptionA, "insert into public.class_activities(class_log_id,activity_type,title) values($1,'homework','Denied B') returning id", [ROWS.B.log]));
    await expectBlocked(db, () => asStaffActor(db, IDS.receptionA, "update public.class_activities set title='Denied B' where id=$1 returning id", [ROWS.B.activity]));
    await expectBlocked(db, () => asStaffActor(db, IDS.receptionA, "delete from public.class_activities where id=$1 returning id", [ROWS.B.activity]));
    expect((await asStaffActor(db, IDS.receptionA, "delete from public.class_activities where id=$1 returning id", [id])).rows).toEqual([{ id }]);
  });

  it("requires both student and parent to belong to the office's authorized school", async () => {
    const db = await database();
    const local = [ROWS.privateStudentA, ROWS.A.parent];
    expect((await asStaffActor(db, IDS.receptionA, "insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian') returning student_id", local)).rows).toHaveLength(1);
    await expectBlocked(db, () => asStaffActor(db, IDS.receptionA, "insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian') returning student_id", [ROWS.privateStudentA, ROWS.B.parent]));
    await expectBlocked(db, () => asStaffActor(db, IDS.receptionA, "insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian') returning student_id", [ROWS.privateStudentB, ROWS.A.parent]));
    await expectBlocked(db, () => asStaffActor(db, IDS.receptionA, "update public.student_parents set parent_id=$1 where student_id=$2 and parent_id=$3 returning student_id", [ROWS.B.parent, ...local]));
    await expectBlocked(db, () => asStaffActor(db, IDS.receptionA, "delete from public.student_parents where student_id=$1 returning student_id", [ROWS.B.student]));
    expect((await asStaffActor(db, IDS.receptionA, "delete from public.student_parents where student_id=$1 and parent_id=$2 returning student_id", local)).rows).toHaveLength(1);
  });

  it("permits local enrollment/assignment updates but rejects changing their canonical pupil or teacher to B", async () => {
    const db = await database();
    expect((await asStaffActor(db, IDS.receptionA, "update public.enrollments set roll_no='2' where id=$1 returning id", [ROWS.A.enrollment])).rows).toEqual([{ id: ROWS.A.enrollment }]);
    expect((await asStaffActor(db, IDS.receptionA, "update public.teacher_subject_assignments set is_class_teacher=false where id=$1 returning id", [ROWS.A.assignment])).rows).toEqual([{ id: ROWS.A.assignment }]);
    await expectBlocked(db, () => asStaffActor(db, IDS.receptionA, "update public.enrollments set student_id=$1 where id=$2 returning id", [ROWS.B.student, ROWS.A.enrollment]));
    await expectBlocked(db, () => asStaffActor(db, IDS.receptionA, "update public.teacher_subject_assignments set teacher_id=$1 where id=$2 returning id", [ROWS.B.teacher, ROWS.A.assignment]));
  });

  it("retains global super-admin reads and writes across both schools", async () => {
    const db = await database();
    for (const table of STAFF_SCOPE_TABLES) {
      const probe = SCHOOL_B_PROBES[table];
      expect((await asStaffActor(db, IDS.superAdmin, probe.sql, probe.params)).rows.length).toBeGreaterThan(0);
    }
    expect((await asStaffActor(db, IDS.superAdmin, "update public.fee_structures set amount=1100 where id=$1 returning id", [ROWS.B.structure])).rows).toEqual([{ id: ROWS.B.structure }]);
  });
});

describe("mixed and ordinary roles retain only their existing non-office paths", () => {
  it("accountant A plus teacher B does not acquire office access in B", async () => {
    const db = await database();
    expect((await asStaffActor(db, IDS.mixedTeacher, "select id from public.fee_structures where id=$1", [ROWS.A.structure])).rows).toHaveLength(1);
    expect((await asStaffActor(db, IDS.mixedTeacher, "select id from public.student_fees where school_id=$1", [IDS.schoolB])).rows).toEqual([]);
    expect((await asStaffActor(db, IDS.mixedTeacher, "select id from public.students where id=$1", [ROWS.B.student])).rows).toHaveLength(1);
    expect((await asStaffActor(db, IDS.mixedTeacher, "select id from public.students where id=$1", [ROWS.privateStudentB])).rows).toEqual([]);
    await expectBlocked(db, () => asStaffActor(db, IDS.mixedTeacher, "update public.fee_structures set amount=900 where id=$1 returning id", [ROWS.B.structure]));
  });

  it("accountant A plus parent B can read their B child's fees but cannot act as B finance", async () => {
    const db = await database();
    expect((await asStaffActor(db, IDS.mixedParent, "select id from public.student_fees where id=$1", [ROWS.B.fee])).rows).toHaveLength(1);
    expect((await asStaffActor(db, IDS.mixedParent, "select id from public.student_fees where id=$1", [ROWS.privateFeeB])).rows).toEqual([]);
    expect((await asStaffActor(db, IDS.mixedParent, "select id from public.fee_payments where id=$1", [ROWS.privatePaymentB])).rows).toEqual([]);
    await expectBlocked(db, () => asStaffActor(db, IDS.mixedParent, "update public.student_fees set amount=10 where id=$1 returning id", [ROWS.B.fee]));
    await expectBlocked(db, () => asStaffActor(db, IDS.mixedParent, "delete from public.fee_payments where id=$1 returning id", [ROWS.B.payment]));
  });

  it("retains teacher assigned-pupil reads, own log drafts, class-teacher attendance and own-school notice writes", async () => {
    const db = await database();
    expect((await asStaffActor(db, IDS.teacherA, "select id from public.students order by id")).rows).toEqual([{ id: ROWS.A.student }]);
    expect((await asStaffActor(db, IDS.teacherA, "select id from public.class_logs order by id")).rows).toEqual([{ id: ROWS.A.log }, { id: ROWS.draftLogA }]);
    expect((await asStaffActor(db, IDS.teacherA, "update public.attendance set status='present' where student_id=$1 returning student_id", [ROWS.A.student])).rows).toHaveLength(1);
    expect((await asStaffActor(db, IDS.teacherA, "insert into public.notices(school_id,title,content,created_by) values($1,'Teacher local','Content',$2) returning id", [IDS.schoolA, IDS.teacherA])).rows).toHaveLength(1);
    await expectBlocked(db, () => asStaffActor(db, IDS.teacherA, "insert into public.notices(school_id,title,content,created_by) values($1,'Teacher cross-school','Content',$2) returning id", [IDS.schoolB, IDS.teacherA]));
  });

  it.each(["parentA", "studentA"] as const)("retains %s's own-child/pupil reads and hides other pupils plus draft work", async (actor) => {
    const db = await database();
    expect((await asStaffActor(db, IDS[actor], "select id from public.students order by id")).rows).toEqual([{ id: ROWS.A.student }]);
    expect((await asStaffActor(db, IDS[actor], "select id from public.student_fees order by id")).rows).toEqual([{ id: ROWS.A.fee }]);
    expect((await asStaffActor(db, IDS[actor], "select id from public.fee_payments order by id")).rows).toEqual([{ id: ROWS.A.payment }]);
    expect((await asStaffActor(db, IDS[actor], "select id from public.class_logs order by id")).rows).toEqual([{ id: ROWS.A.log }]);
    expect((await asStaffActor(db, IDS[actor], "select id from public.class_activities order by id")).rows).toEqual([{ id: ROWS.A.activity }]);
    await expectBlocked(db, () => asStaffActor(db, IDS[actor], "update public.student_fees set amount=1 where id=$1 returning id", [ROWS.A.fee]));
  });
});

describe("staff-scope privileges, deployment checks and replay", () => {
  it("denies anon access and removes non-DML privileges while preserving authenticated DML and trusted service DML", async () => {
    const db = await database();
    for (const table of STAFF_SCOPE_TABLES) {
      const privileges = await db.query<{ anon_access: boolean; auth_write_admin: boolean; auth_dml: boolean; service_dml: boolean }>(`
        select has_table_privilege('anon',$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') as anon_access,
          has_table_privilege('authenticated',$1,'TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') as auth_write_admin,
          has_table_privilege('authenticated',$1,'SELECT') and has_table_privilege('authenticated',$1,'INSERT')
            and has_table_privilege('authenticated',$1,'UPDATE') and has_table_privilege('authenticated',$1,'DELETE') as auth_dml,
          has_table_privilege('service_role',$1,'SELECT') and has_table_privilege('service_role',$1,'INSERT')
            and has_table_privilege('service_role',$1,'UPDATE') and has_table_privilege('service_role',$1,'DELETE') as service_dml
      `, [`public.${table}`]);
      expect(privileges.rows, table).toEqual([{ anon_access: false, auth_write_admin: false, auth_dml: true, service_dml: true }]);
    }
    await expectBlocked(db, () => asStaffActor(db, null, "select id from public.students", [], "anon"));
    await expectBlocked(db, () => asStaffActor(db, IDS.accountantA, "truncate public.fee_payments"));
  });

  it("preserves service-role helper execution with scoped actor results and no anonymous helper execution", async () => {
    const db = await database();
    const sql = `select app_private.has_school_roles($1::uuid,array['accountant'::public.app_role]) as authorized`;
    expect((await asStaffActor(db, IDS.accountantA, sql, [IDS.schoolA], "service_role")).rows).toEqual([{ authorized: true }]);
    expect((await asStaffActor(db, IDS.accountantA, sql, [IDS.schoolB], "service_role")).rows).toEqual([{ authorized: false }]);
    expect((await asStaffActor(db, null, sql, [IDS.schoolA], "service_role")).rows).toEqual([{ authorized: false }]);
    await expectBlocked(db, () => asStaffActor(db, IDS.superAdmin, sql, [IDS.schoolA], "anon"));
  });

  it("is repeatable, preserves application rows and passes the SELECT-only manual checks", async () => {
    const db = await database({ applyMigration: false });
    const original = await state(db);
    const verification = await readFile(new URL("../../supabase/manual/verify-staff-school-scope.sql", import.meta.url), "utf8");
    const beforeChecks = (await db.query<{ check_name: string; passes: boolean }>(verification)).rows;
    expect(beforeChecks).toHaveLength(20);
    expect(beforeChecks.some((check) => check.passes === false)).toBe(true);
    expect(beforeChecks.every((check) => typeof check.passes === "boolean")).toBe(true);
    expect(await state(db)).toEqual(original);
    const sql = await readStaffScopeSql();
    await db.exec(sql);
    expect(await state(db)).toEqual(original);
    await db.exec(sql);
    expect(await state(db)).toEqual(original);
    const checks = (await db.query<{ check_name: string; passes: boolean }>(verification)).rows;
    expect(checks).toHaveLength(20);
    expect(checks.map((check) => check.check_name)).toEqual(beforeChecks.map((check) => check.check_name));
    expect(new Set(checks.map((check) => check.check_name)).size).toBe(checks.length);
    expect(checks.filter((check) => check.passes !== true)).toEqual([]);
    const firstVerification = await readFile(new URL("../../supabase/manual/verify-role-permissions.sql", import.meta.url), "utf8");
    const firstChecks = (await db.query<{ check_name: string; passes: boolean }>(firstVerification)).rows;
    expect(firstChecks).toHaveLength(15);
    expect(firstChecks.filter((check) => check.passes !== true)).toEqual([]);
    expect(await state(db)).toEqual(original);
  });

  it("rejects unexpected coexisting target-table policies and rolls back instead of partially changing access", async () => {
    const db = await database({ applyMigration: false });
    await db.exec("create policy unexpected_staff_allow on public.students for select to authenticated using (true)");
    const original = await state(db);
    const aclBefore = (await db.query("select relacl::text from pg_class where oid='public.students'::regclass")).rows;
    await expect(db.exec(await readStaffScopeSql())).rejects.toThrow(/policy|policies|Unexpected/i);
    await db.exec("rollback");
    expect(await state(db)).toEqual(original);
    expect((await db.query("select relacl::text from pg_class where oid='public.students'::regclass")).rows).toEqual(aclBefore);
    expect((await db.query("select 1 from pg_policy where polname='unexpected_staff_allow'")).rows).toHaveLength(1);
  });
});
