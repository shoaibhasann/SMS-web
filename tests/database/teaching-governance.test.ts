// @vitest-environment node

import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  asStaffActor, createTeachingGovernanceDatabase, readTeachingGovernanceSql,
  STAFF_IDS as IDS, STAFF_ROWS as ROWS,
} from "./staff-scope-fixture";

type GovernanceDb = Awaited<ReturnType<typeof createTeachingGovernanceDatabase>>;
const databases: GovernanceDb[] = [];
const temporaryId = (value: number) => `20000000-0000-0000-0000-${String(value).padStart(12, "0")}`;
const assignmentInsert = `insert into public.teacher_subject_assignments
  (teacher_id,academic_year_id,class_id,section_id,subject_id,is_class_teacher)
  values($1,$2,$3,$4,$5,$6) returning id`;
const localAssignment = [ROWS.A.teacher, ROWS.A.year, ROWS.privateClassA, ROWS.privateSectionA, ROWS.A.subject, false];

async function database(options: { applyMigration?: boolean } = {}) {
  const db = await createTeachingGovernanceDatabase(options);
  databases.push(db);
  return db;
}
afterEach(async () => { await Promise.all(databases.splice(0).map((db) => db.close())); });

async function state(db: GovernanceDb) {
  return (await db.query(`
    select (select jsonb_agg(to_jsonb(r) order by id) from public.user_roles r) as roles,
      (select jsonb_agg(to_jsonb(r) order by id) from public.teacher_subject_assignments r) as assignments,
      (select jsonb_agg(to_jsonb(r) order by id) from public.teachers r) as teachers,
      (select jsonb_agg(to_jsonb(r) order by id) from public.profiles r) as profiles,
      (select jsonb_agg(to_jsonb(r) order by id) from public.academic_years r) as years,
      (select jsonb_agg(to_jsonb(r) order by id) from public.classes r) as classes,
      (select jsonb_agg(to_jsonb(r) order by id) from public.sections r) as sections,
      (select jsonb_agg(to_jsonb(r) order by id) from public.subjects r) as subjects,
      (select jsonb_agg(to_jsonb(r) order by id) from public.students r) as students,
      (select jsonb_agg(to_jsonb(r) order by id) from public.enrollments r) as enrollments,
      (select jsonb_agg(to_jsonb(r) order by id) from public.attendance r) as attendance
  `)).rows;
}

async function blocked(db: GovernanceDb, operation: () => Promise<unknown>) {
  const before = await state(db);
  let result: { rows?: unknown[] } | undefined;
  try { result = await operation() as { rows?: unknown[] }; }
  catch (error) {
    // Authorization, deliberate trigger exceptions and explicit integrity
    // checks are valid denials. FK/uniqueness/type errors must not fake a pass.
    expect(["42501", "P0001", "23514"]).toContain((error as { code?: string }).code);
  }
  if (result) expect(result.rows).toEqual([]);
  expect(await state(db)).toEqual(before);
}

async function markPrivatePupil(db: GovernanceDb) {
  return asStaffActor(db, IDS.teacherA, `insert into public.attendance
    (school_id,academic_year_id,student_id,section_id,attendance_date,status,marked_by)
    values($1,$2,$3,$4,'2026-11-02','present',$5) returning student_id`,
  [IDS.schoolA, ROWS.A.year, ROWS.privateStudentA, ROWS.privateSectionA, IDS.teacherA]);
}

async function seedApprovedVictim(db: GovernanceDb) {
  const victim = temporaryId(900);
  await db.query("update public.profiles set school_id=$1 where id=$2", [IDS.schoolA, IDS.outsider]);
  await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'teacher')", [IDS.outsider, IDS.schoolA]);
  await db.query("insert into public.teachers(id,school_id,profile_id,employee_id,full_name) values($1,$2,$3,'VICTIM-A','Approved class teacher')", [victim, IDS.schoolA, IDS.outsider]);
  await db.query(assignmentInsert, [victim, ROWS.A.year, ROWS.privateClassA, ROWS.privateSectionA, ROWS.A.subject, true]);
  return victim;
}

describe("governance exploits after the first two deployed patches", () => {
  it("reproduces self-assignment acquiring another roster and attendance authority", async () => {
    const db = await database({ applyMigration: false });
    expect((await asStaffActor(db, IDS.teacherA, "select id from public.students order by id")).rows).toEqual([{ id: ROWS.A.student }]);
    await asStaffActor(db, IDS.teacherA, "update public.teacher_subject_assignments set is_class_teacher=false where id=$1", [ROWS.A.assignment]);
    await asStaffActor(db, IDS.teacherA, assignmentInsert, [...localAssignment.slice(0, 5), true]);
    expect((await asStaffActor(db, IDS.teacherA, "select id from public.students order by id")).rows).toEqual([{ id: ROWS.A.student }, { id: ROWS.privateStudentA }]);
    expect((await markPrivatePupil(db)).rows).toEqual([{ student_id: ROWS.privateStudentA }]);
  });

  it("reproduces teacher identity hijacking without any actor assignment mutation", async () => {
    const db = await database({ applyMigration: false });
    const victim = await seedApprovedVictim(db);
    const assignments = (await db.query("select * from public.teacher_subject_assignments order by id")).rows;
    await asStaffActor(db, IDS.teacherA, "update public.teachers set profile_id=null where id=$1", [ROWS.A.teacher]);
    await asStaffActor(db, IDS.teacherA, "update public.teachers set profile_id=$1 where id=$2", [IDS.teacherA, victim]);
    expect((await db.query("select * from public.teacher_subject_assignments order by id")).rows).toEqual(assignments);
    expect((await asStaffActor(db, IDS.teacherA, "select id from public.students order by id")).rows).toEqual([{ id: ROWS.privateStudentA }]);
    expect((await markPrivatePupil(db)).rows).toEqual([{ student_id: ROWS.privateStudentA }]);
  });
});

describe("teacher and ordinary office assignment permissions", () => {
  it.each(["teacherA", "accountantA", "receptionA", "mixedTeacher", "mixedParent"] as const)("%s cannot INSERT, UPDATE or DELETE teaching assignments", async (actor) => {
    const db = await database();
    await blocked(db, () => asStaffActor(db, IDS[actor], assignmentInsert, localAssignment));
    await blocked(db, () => asStaffActor(db, IDS[actor], "update public.teacher_subject_assignments set is_class_teacher=false where id=$1 returning id", [ROWS.A.assignment]));
    await blocked(db, () => asStaffActor(db, IDS[actor], "delete from public.teacher_subject_assignments where id=$1 returning id", [ROWS.A.assignment]));
  });

  it("retains teachers' approved reads and office school reads without granting another school", async () => {
    const db = await database();
    expect((await asStaffActor(db, IDS.teacherA, "select id from public.teacher_subject_assignments order by id")).rows).toEqual([{ id: ROWS.A.assignment }]);
    for (const actor of [IDS.accountantA, IDS.receptionA]) {
      expect((await asStaffActor(db, actor, "select id from public.teacher_subject_assignments where id=$1", [ROWS.A.assignment])).rows).toHaveLength(1);
      expect((await asStaffActor(db, actor, "select id from public.teacher_subject_assignments where id=$1", [ROWS.B.assignment])).rows).toEqual([]);
    }
    expect((await asStaffActor(db, IDS.mixedTeacher, "select id from public.teacher_subject_assignments order by id")).rows.map((row) => row.id)).toEqual([ROWS.A.assignment, ROWS.mixedAssignment]);
  });
});

describe("scoped supervisor assignment governance", () => {
  it.each(["adminA", "principalA"] as const)("%s can manage coherent A assignments and cannot write B assignments", async (actor) => {
    const db = await database();
    const inserted = await asStaffActor<{ id: string }>(db, IDS[actor], assignmentInsert, localAssignment);
    const id = inserted.rows[0].id;
    expect((await asStaffActor(db, IDS[actor], "update public.teacher_subject_assignments set section_id=null where id=$1 returning id", [id])).rows).toEqual([{ id }]);
    await blocked(db, () => asStaffActor(db, IDS[actor], "update public.teacher_subject_assignments set is_class_teacher=true where id=$1 returning id", [id]));
    expect((await asStaffActor(db, IDS[actor], "delete from public.teacher_subject_assignments where id=$1 returning id", [id])).rows).toEqual([{ id }]);
    await blocked(db, () => asStaffActor(db, IDS[actor], assignmentInsert, [ROWS.B.teacher, ROWS.B.year, ROWS.privateClassB, ROWS.privateSectionB, ROWS.B.subject, false]));
    await blocked(db, () => asStaffActor(db, IDS[actor], "update public.teacher_subject_assignments set is_class_teacher=false where id=$1 returning id", [ROWS.B.assignment]));
    await blocked(db, () => asStaffActor(db, IDS[actor], "delete from public.teacher_subject_assignments where id=$1 returning id", [ROWS.B.assignment]));
  });

  it.each(["teacher", "year", "class", "section", "subject"] as const)("rejects a mismatched %s on INSERT and UPDATE rather than relying on individual FKs", async (field) => {
    const db = await database();
    const index = { teacher: 0, year: 1, class: 2, section: 3, subject: 4 }[field]!;
    const foreign = [ROWS.B.teacher, ROWS.B.year, ROWS.privateClassB, ROWS.privateSectionB, ROWS.B.subject][index];
    const values = [...localAssignment];
    values[index] = foreign;
    await blocked(db, () => asStaffActor(db, IDS.adminA, assignmentInsert, values));
    const own = await asStaffActor<{ id: string }>(db, IDS.adminA, assignmentInsert, localAssignment);
    const column = ["teacher_id", "academic_year_id", "class_id", "section_id", "subject_id"][index];
    await blocked(db, () => asStaffActor(db, IDS.adminA, `update public.teacher_subject_assignments set ${column}=$1 where id=$2 returning id`, [foreign, own.rows[0].id]));
  });

  it("rejects a section from another class in the same school", async () => {
    const db = await database();
    await blocked(db, () => asStaffActor(db, IDS.principalA, assignmentInsert, [ROWS.A.teacher, ROWS.A.year, ROWS.privateClassA, ROWS.A.section, ROWS.A.subject, false]));
  });

  it("retains super-admin cross-school management but never permits an incoherent tuple", async () => {
    const db = await database();
    const inserted = await asStaffActor<{ id: string }>(db, IDS.superAdmin, assignmentInsert, [ROWS.B.teacher, ROWS.B.year, ROWS.privateClassB, ROWS.privateSectionB, ROWS.B.subject, false]);
    expect(inserted.rows).toHaveLength(1);
    await blocked(db, () => asStaffActor(db, IDS.superAdmin, assignmentInsert, [ROWS.A.teacher, ROWS.B.year, ROWS.privateClassA, ROWS.privateSectionA, ROWS.A.subject, false]));
  });
});

describe("teacher identity and academic-master containment", () => {
  it.each(["teacherA", "parentA", "studentA"] as const)("%s cannot change teacher identity or create a self-linked teacher", async (actor) => {
    const db = await database();
    await blocked(db, () => asStaffActor(db, IDS[actor], "update public.teachers set profile_id=$1 where id=$2 returning id", [IDS[actor], ROWS.A.teacher]));
    await blocked(db, () => asStaffActor(db, IDS[actor], "insert into public.teachers(school_id,profile_id,employee_id) values($1,$2,'UNAUTHORIZED') returning id", [IDS.schoolA, IDS[actor]]));
    await blocked(db, () => asStaffActor(db, IDS[actor], "delete from public.teachers where id=$1 returning id", [ROWS.A.teacher]));
  });

  it.each(["teacherA", "parentA", "studentA"] as const)("%s cannot mutate masters or cascade-delete approved assignments through a year", async (actor) => {
    const db = await database();
    await blocked(db, () => asStaffActor(db, IDS[actor], "update public.classes set name='Hijacked class' where id=$1 returning id", [ROWS.A.class]));
    await blocked(db, () => asStaffActor(db, IDS[actor], "update public.sections set class_id=$1 where id=$2 returning id", [ROWS.privateClassA, ROWS.A.section]));
    await blocked(db, () => asStaffActor(db, IDS[actor], "update public.subjects set name='Hijacked subject' where id=$1 returning id", [ROWS.A.subject]));
    // Use a dedicated valid year with a child assignment and no fee structure,
    // so a fee FK cannot accidentally hide an authorized-master-delete bug.
    const year = temporaryId(700);
    await db.query("insert into public.academic_years(id,school_id,name,start_date,end_date) values($1,$2,'Historic fixture','2024-04-01','2025-03-31')", [year, IDS.schoolA]);
    await db.query(assignmentInsert, [ROWS.A.teacher, year, ROWS.privateClassA, ROWS.privateSectionA, ROWS.A.subject, false]);
    await blocked(db, () => asStaffActor(db, IDS[actor], "delete from public.academic_years where id=$1 returning id", [year]));
  });

  it("preserves own-profile display updates and narrow teacher-phone RPC while protecting authority fields", async () => {
    const db = await database();
    expect((await asStaffActor(db, IDS.teacherA, "update public.profiles set full_name='Teacher display name' where id=$1 returning id", [IDS.teacherA])).rows).toHaveLength(1);
    await blocked(db, () => asStaffActor(db, IDS.teacherA, "update public.profiles set school_id=$1 where id=$2 returning id", [IDS.schoolB, IDS.teacherA]));
    await blocked(db, () => asStaffActor(db, IDS.teacherA, "update public.profiles set is_active=false where id=$1 returning id", [IDS.teacherA]));
    await blocked(db, () => asStaffActor(db, IDS.teacherA, "update public.profiles set email='changed@example.test' where id=$1 returning id", [IDS.teacherA]));
    await blocked(db, () => asStaffActor(db, IDS.teacherA, "update public.teachers set registered_mobile='123' where id=$1 returning id", [ROWS.A.teacher]));
    await asStaffActor(db, IDS.teacherA, "select public.update_my_teacher_phone($1)", [" 9876512345 "]);
    expect((await db.query("select registered_mobile from public.teachers where id=$1", [ROWS.A.teacher])).rows).toEqual([{ registered_mobile: "9876512345" }]);
  });

  it("lets supervisors edit ordinary school metadata but not protected school/class identity fields", async () => {
    const db = await database();
    expect((await asStaffActor(db, IDS.principalA, "update public.classes set name='Renamed local class' where id=$1 returning id", [ROWS.A.class])).rows).toHaveLength(1);
    expect((await asStaffActor(db, IDS.principalA, "update public.teachers set full_name='Renamed local teacher' where id=$1 returning id", [ROWS.A.teacher])).rows).toHaveLength(1);
    expect((await asStaffActor(db, IDS.adminA, "update public.teachers set profile_id=null where id=$1 returning id", [ROWS.A.teacher])).rows).toHaveLength(1);
    expect((await asStaffActor(db, IDS.adminA, "update public.teachers set profile_id=$1 where id=$2 returning id", [IDS.teacherA, ROWS.A.teacher])).rows).toHaveLength(1);
    await blocked(db, () => asStaffActor(db, IDS.superAdmin, "update public.classes set school_id=$1 where id=$2 returning id", [IDS.schoolB, ROWS.A.class]));
    await blocked(db, () => asStaffActor(db, IDS.superAdmin, "update public.teachers set school_id=$1 where id=$2 returning id", [IDS.schoolB, ROWS.A.teacher]));
    await blocked(db, () => asStaffActor(db, IDS.adminA, "update public.sections set class_id=$1,name='Unique reparent attempt' where id=$2 returning id", [ROWS.privateClassA, ROWS.A.section]));
    await blocked(db, () => asStaffActor(db, IDS.adminA, "update public.teachers set id=$1 where id=$2 returning id", [temporaryId(999), ROWS.A.teacher]));
  });
});

describe("governed teacher attendance and registration", () => {
  it("allows supervisor assignment approval followed by real teacher attendance and atomic registration with the complete name", async () => {
    const db = await database();
    await asStaffActor(db, IDS.principalA, "update public.teacher_subject_assignments set is_class_teacher=false where id=$1", [ROWS.A.assignment]);
    await asStaffActor(db, IDS.principalA, assignmentInsert, [...localAssignment.slice(0, 5), true]);
    expect((await markPrivatePupil(db)).rows).toEqual([{ student_id: ROWS.privateStudentA }]);
    const result = await asStaffActor<{ student_id: string; class_id: string; section_id: string }>(db, IDS.teacherA,
      "select * from public.register_student_for_class_teacher($1)", ["  Amina   Noor   Rahman  "]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ class_id: ROWS.privateClassA, section_id: ROWS.privateSectionA });
    const id = result.rows[0].student_id;
    expect((await db.query("select first_name,middle_name,last_name from public.students where id=$1", [id])).rows).toEqual([{ first_name: "Amina", middle_name: "Noor", last_name: "Rahman" }]);
    expect((await db.query("select academic_year_id,class_id,section_id from public.enrollments where student_id=$1", [id])).rows).toEqual([{ academic_year_id: ROWS.A.year, class_id: ROWS.privateClassA, section_id: ROWS.privateSectionA }]);
  });

  it.each(["parentA", "studentA", "accountantA", "receptionA", "mixedTeacher"] as const)("does not let %s use registration without their own coherent class-teacher authority", async (actor) => {
    const db = await database();
    await blocked(db, () => asStaffActor(db, IDS[actor], "select * from public.register_student_for_class_teacher('Unauthorized pupil')"));
  });

  it("fails closed for inactive identity, missing same-school teacher role, ambiguous current year and overlong names", async () => {
    const db = await database();
    await blocked(db, () => asStaffActor(db, IDS.teacherA, "select * from public.register_student_for_class_teacher($1)", ["N".repeat(1001)]));
    await db.query("update public.profiles set is_active=false where id=$1", [IDS.teacherA]);
    await blocked(db, () => asStaffActor(db, IDS.teacherA, "select * from public.register_student_for_class_teacher('Inactive identity')"));
    await db.query("update public.profiles set is_active=true where id=$1", [IDS.teacherA]);
    await db.query("delete from public.user_roles where user_id=$1 and role='teacher'", [IDS.teacherA]);
    await blocked(db, () => asStaffActor(db, IDS.teacherA, "select * from public.register_student_for_class_teacher('Missing role')"));
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'teacher')", [IDS.teacherA, IDS.schoolB]);
    await blocked(db, () => asStaffActor(db, IDS.teacherA, "select * from public.register_student_for_class_teacher('Wrong school role')"));
    await db.query("update public.user_roles set school_id=$1 where user_id=$2 and role='teacher'", [IDS.schoolA, IDS.teacherA]);
    await asStaffActor(db, IDS.adminA, "insert into public.academic_years(school_id,name,start_date,end_date,is_current) values($1,'Also current','2027-04-01','2028-03-31',true)", [IDS.schoolA]);
    await blocked(db, () => asStaffActor(db, IDS.teacherA, "select * from public.register_student_for_class_teacher('Ambiguous year')"));
  });
});

describe("governance migration safety", () => {
  it("refuses existing incoherent assignments atomically instead of silently rewriting school data", async () => {
    const db = await database({ applyMigration: false });
    await db.query("update public.teacher_subject_assignments set subject_id=$1 where id=$2", [ROWS.B.subject, ROWS.A.assignment]);
    const before = await state(db);
    await expect(db.exec(await readTeachingGovernanceSql())).rejects.toThrow();
    await db.exec("rollback");
    expect(await state(db)).toEqual(before);
  });

  it("replays without changing rows and preserves the first role-permission hotfix", async () => {
    const db = await database();
    const before = await state(db);
    await db.exec(await readTeachingGovernanceSql());
    expect(await state(db)).toEqual(before);
    const firstVerifier = await readFile(new URL("../../supabase/manual/verify-role-permissions.sql", import.meta.url), "utf8");
    const checks = (await db.query<{ check_name: string; passes: boolean }>(firstVerifier)).rows;
    expect(checks).toHaveLength(15);
    expect(checks.filter((check) => check.passes !== true)).toEqual([]);
  });
});
