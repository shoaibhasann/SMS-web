// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asStaffActor, STAFF_IDS as ids, STAFF_ROWS as records } from "./staff-scope-fixture";
import { ASSESSMENT_IDS as assessments, createAssessmentAccessDatabase, readAssessmentAccessSql } from "./assessment-access-fixture";

type Database = Awaited<ReturnType<typeof createAssessmentAccessDatabase>>;
let db: Database | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

function assessmentRows(actor: string, assessment = assessments.a) {
  return asStaffActor(db!, actor, "select id,name,maximum_marks from public.teacher_assessments where id=$1", [assessment]);
}
function markRows(actor: string, assessment = assessments.a) {
  return asStaffActor(db!, actor, "select student_id,marks_obtained,remarks from public.teacher_assessment_marks where assessment_id=$1", [assessment]);
}
function insertAssessment(actor: string, overrides: Partial<Record<"school" | "year" | "class" | "section" | "subject" | "teacher", string | null>> = {}) {
  const scope = { school: ids.schoolA, ...records.A, ...overrides };
  return asStaffActor<{ id: string }>(db!, actor, `insert into public.teacher_assessments
    (school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,name,assessment_date,maximum_marks)
    values($1,$2,$3,$4,$5,$6,'New assessment','2026-11-05',50) returning id`, [
    scope.school, scope.year, scope.class, scope.section, scope.subject, scope.teacher,
  ]);
}
async function assertDenied(actor: string) {
  const snapshot = await db!.query("select * from public.teacher_assessments where id=$1", [assessments.a]);
  const marks = await db!.query("select * from public.teacher_assessment_marks where assessment_id=$1", [assessments.a]);
  expect((await assessmentRows(actor)).rows).toEqual([]);
  expect((await markRows(actor)).rows).toEqual([]);
  expect((await asStaffActor(db!, actor, "update public.teacher_assessments set name='Forbidden' where id=$1 returning id", [assessments.a])).rows).toEqual([]);
  expect((await asStaffActor(db!, actor, "delete from public.teacher_assessments where id=$1 returning id", [assessments.a])).rows).toEqual([]);
  expect((await asStaffActor(db!, actor, "update public.teacher_assessment_marks set marks_obtained=1 where assessment_id=$1 returning id", [assessments.a])).rows).toEqual([]);
  expect((await asStaffActor(db!, actor, "delete from public.teacher_assessment_marks where assessment_id=$1 returning id", [assessments.a])).rows).toEqual([]);
  await expect(insertAssessment(actor)).rejects.toMatchObject({ code: "42501" });
  await expect(asStaffActor(db!, actor, `insert into public.teacher_assessment_marks(assessment_id,student_id,marks_obtained)
    values($1,$2,1)`, [assessments.a, records.A.student])).rejects.toMatchObject({ code: "42501" });
  expect((await db!.query("select * from public.teacher_assessments where id=$1", [assessments.a])).rows).toEqual(snapshot.rows);
  expect((await db!.query("select * from public.teacher_assessment_marks where assessment_id=$1", [assessments.a])).rows).toEqual(marks.rows);
}

describe("recovered live assessment exploit", () => {
  it("reproduces retained-assignment and inactive-profile access before the patch, then denies both", async () => {
    db = await createAssessmentAccessDatabase({ applyMigration: false });
    expect((await db.query("select policyname from pg_policies where tablename in ('teacher_assessments','teacher_assessment_marks')")).rows).toHaveLength(12);
    await db.exec(`grant select(name),insert(name),update(name),references(id) on public.teacher_assessments to anon;
      grant references(student_id) on public.teacher_assessment_marks to authenticated`);
    expect((await db.query(`select has_table_privilege('authenticated','public.teacher_assessment_marks','TRUNCATE') as truncate,
      has_column_privilege('anon','public.teacher_assessments','name','UPDATE') as stray_column`)).rows)
      .toEqual([{ truncate: true, stray_column: true }]);
    await db.query("delete from public.user_roles where user_id=$1 and role='teacher'", [ids.teacherA]);
    expect((await assessmentRows(ids.teacherA)).rows).toHaveLength(1);
    expect((await asStaffActor(db, ids.teacherA, "update public.teacher_assessment_marks set remarks='Legacy bypass' where assessment_id=$1 returning id", [assessments.a])).rows).toHaveLength(1);
    await db.query("update public.profiles set is_active=false where id=$1", [ids.adminA]);
    expect((await assessmentRows(ids.adminA)).rows).toHaveLength(1);
    expect((await markRows(ids.adminA)).rows).toHaveLength(1);
    await db.exec(await readAssessmentAccessSql());
    await assertDenied(ids.teacherA);
    await assertDenied(ids.adminA);
    expect((await db.query(`select has_any_column_privilege('anon','public.teacher_assessments','SELECT,INSERT,UPDATE,REFERENCES') as anon_columns,
      has_any_column_privilege('authenticated','public.teacher_assessment_marks','REFERENCES') as references`)).rows)
      .toEqual([{ anon_columns: false, references: false }]);
    expect((await db.query("select id from public.teacher_subject_assignments where id=$1", [records.A.assignment])).rows).toHaveLength(1);
  }, 30_000);
});

describe("assessment access follows current school membership", () => {
  beforeEach(async () => { db = await createAssessmentAccessDatabase(); }, 30_000);

  it("allows assigned teachers to create, grade, reload and delete within their scope", async () => {
    expect((await assessmentRows(ids.teacherA)).rows).toHaveLength(1);
    expect((await markRows(ids.teacherA)).rows).toEqual([{ student_id: records.A.student, marks_obtained: "35.00", remarks: null }]);
    const id = (await insertAssessment(ids.teacherA)).rows[0].id;
    await asStaffActor(db!, ids.teacherA, "insert into public.teacher_assessment_marks(assessment_id,student_id,marks_obtained) values($1,$2,40)", [id, records.A.student]);
    await asStaffActor(db!, ids.teacherA, "update public.teacher_assessment_marks set marks_obtained=44,remarks='Verified' where assessment_id=$1", [id]);
    expect((await markRows(ids.teacherA, id)).rows).toEqual([{ student_id: records.A.student, marks_obtained: "44.00", remarks: "Verified" }]);
    expect((await db!.query("select updated_by from public.teacher_assessment_marks where assessment_id=$1", [id])).rows).toEqual([{ updated_by: ids.teacherA }]);
    expect((await asStaffActor(db!, ids.teacherA, "delete from public.teacher_assessments where id=$1 returning id", [id])).rows).toEqual([{ id }]);
    expect((await db!.query("select id from public.teacher_assessment_marks where assessment_id=$1", [id])).rows).toEqual([]);
  });

  it("denies removed teacher roles immediately with retained assignments and restores access without rewriting history", async () => {
    const history = (await markRows(ids.teacherA)).rows;
    await db!.query("delete from public.user_roles where user_id=$1 and role='teacher' and school_id=$2", [ids.teacherA, ids.schoolA]);
    await assertDenied(ids.teacherA);
    await db!.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'teacher')", [ids.teacherA, ids.schoolA]);
    expect((await markRows(ids.teacherA)).rows).toEqual(history);
  });

  it("denies inactive teachers without deleting any assessment, assignment or mark", async () => {
    await db!.query("update public.profiles set is_active=false where id=$1", [ids.teacherA]);
    await assertDenied(ids.teacherA);
    await db!.query("update public.profiles set is_active=true where id=$1", [ids.teacherA]);
    expect((await markRows(ids.teacherA)).rows).toHaveLength(1);
    expect((await db!.query("select id from public.teacher_subject_assignments where id=$1", [records.A.assignment])).rows).toHaveLength(1);
  });

  it("does not substitute another school's teacher role, or a same-school non-teacher role", async () => {
    await db!.query("delete from public.user_roles where user_id=$1 and role='teacher'", [ids.teacherA]);
    await db!.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'teacher'),($1,$3,'accountant')", [ids.teacherA, ids.schoolB, ids.schoolA]);
    await assertDenied(ids.teacherA);
    expect((await markRows(ids.teacherB, assessments.b)).rows).toHaveLength(1);
    // A genuine B teacher's unrelated A accountant role must not block B access.
    expect((await markRows(ids.mixedTeacher, assessments.mixed)).rows).toHaveLength(1);
    expect((await markRows(ids.mixedTeacher)).rows).toEqual([]);
  });

  it("keeps SchoolAdmin and global SuperAdmin authority without granting Principal or other-school administrators", async () => {
    expect((await assessmentRows(ids.adminA)).rows).toHaveLength(1);
    expect((await markRows(ids.superAdmin)).rows).toHaveLength(1);
    await assertDenied(ids.principalA);
    await assertDenied(ids.adminB);
    await db!.query("update public.profiles set is_active=false where id=$1", [ids.adminA]);
    await assertDenied(ids.adminA);
    await db!.query("update public.profiles set is_active=false where id=$1", [ids.superAdmin]);
    await assertDenied(ids.superAdmin);
  });

  it("rejects a school-scoped super_admin corruption instead of granting global access", async () => {
    // Trusted SQL models malformed historical role data; the role governance
    // API separately prevents creation of this invalid role shape.
    const constraints = await db!.query<{ name: string }>(`select conname as name from pg_constraint
      where conrelid='public.user_roles'::regclass and contype='c' and pg_get_constraintdef(oid) like '%super_admin%'`);
    for (const row of constraints.rows) await db!.exec(`alter table public.user_roles drop constraint "${row.name.replaceAll('"', '""')}"`);
    await db!.query("update public.user_roles set school_id=$2 where user_id=$1 and role='super_admin'", [ids.superAdmin, ids.schoolB]);
    await assertDenied(ids.superAdmin);
  });

  it("denies stale assignments removed from the authorized class or section", async () => {
    await db!.query("delete from public.teacher_subject_assignments where id=$1", [records.A.assignment]);
    await assertDenied(ids.teacherA);
    expect((await assessmentRows(ids.adminA)).rows).toHaveLength(1);
  });

  it("denies unassigned same-school sections and subjects while allowing an administrator to create them", async () => {
    const section = "20000000-0000-0000-0000-000000000010";
    const subject = "20000000-0000-0000-0000-000000000011";
    await db!.query("insert into public.sections(id,school_id,class_id,name) values($1,$2,$3,'B')", [section, ids.schoolA, records.A.class]);
    await db!.query("insert into public.subjects(id,school_id,name) values($1,$2,'History')", [subject, ids.schoolA]);
    await expect(insertAssessment(ids.teacherA, { section })).rejects.toMatchObject({ code: "42501" });
    await expect(insertAssessment(ids.teacherA, { subject })).rejects.toMatchObject({ code: "42501" });
    expect((await insertAssessment(ids.adminA, { section, subject })).rows).toHaveLength(1);
  });

  it("requires live membership even if a later permissive policy is overly broad", async () => {
    await db!.exec(`create policy unexpected_assessment_all on public.teacher_assessments for all to authenticated using(true) with check(true);
      create policy unexpected_marks_all on public.teacher_assessment_marks for all to authenticated using(true) with check(true)`);
    await db!.query("delete from public.user_roles where user_id=$1 and role='teacher'", [ids.teacherA]);
    await db!.query("update public.profiles set is_active=false where id=$1", [ids.adminA]);
    await assertDenied(ids.teacherA);
    await assertDenied(ids.adminA);
  });

  it("rejects foreign year/class/section/subject/teacher references even for SchoolAdmin", async () => {
    for (const [column, foreign] of [
      ["year", records.B.year], ["class", records.B.class], ["section", records.B.section],
      ["subject", records.B.subject], ["teacher", records.B.teacher], ["section", records.privateSectionA],
    ] as const) await expect(insertAssessment(ids.adminA, { [column]: foreign })).rejects.toMatchObject({ code: "42501" });
    expect((await db!.query("select id from public.teacher_assessments")).rows).toHaveLength(3);
  });

  it("preserves but hides malformed historical placements and foreign-student marks", async () => {
    await db!.query("update public.teacher_assessments set subject_id=$2 where id=$1", [assessments.a, records.B.subject]);
    expect((await assessmentRows(ids.adminA)).rows).toEqual([]);
    expect((await markRows(ids.superAdmin)).rows).toEqual([]);
    expect((await db!.query("select id from public.teacher_assessments where id=$1", [assessments.a])).rows).toHaveLength(1);
    await db!.query("update public.teacher_assessments set subject_id=$2 where id=$1", [assessments.a, records.A.subject]);
    await db!.query("update public.students set school_id=$2 where id=$1", [records.A.student, ids.schoolB]);
    expect((await markRows(ids.adminA)).rows).toEqual([]);
    expect((await db!.query("select id from public.teacher_assessment_marks where assessment_id=$1", [assessments.a])).rows).toHaveLength(1);
  });

  it("rejects a foreign student despite a corrupt enrollment matching assessment class/year", async () => {
    await db!.query("insert into public.enrollments(student_id,academic_year_id,class_id,section_id,status) values($1,$2,$3,$4,'active')", [records.B.student, records.A.year, records.A.class, records.A.section]);
    await expect(asStaffActor(db!, ids.adminA, "insert into public.teacher_assessment_marks(assessment_id,student_id,marks_obtained) values($1,$2,20)", [assessments.a, records.B.student])).rejects.toMatchObject({ code: "42501" });
    expect((await asStaffActor(db!, ids.adminB, "select public.teacher_assessment_student_is_enrolled($1,$2) as enrolled", [assessments.a, records.A.student])).rows).toEqual([{ enrolled: false }]);
  });

  it("keeps former-student marks readable and prevents relocating saved marks", async () => {
    await db!.query("update public.enrollments set status='transferred' where id=$1", [records.A.enrollment]);
    expect((await markRows(ids.teacherA)).rows).toHaveLength(1);
    await expect(asStaffActor(db!, ids.teacherA, "update public.teacher_assessment_marks set remarks='New grade' where assessment_id=$1", [assessments.a])).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db!, ids.adminA, "update public.teacher_assessments set section_id=null where id=$1", [assessments.a])).rejects.toMatchObject({ code: "42501" });
    expect((await markRows(ids.adminA)).rows).toHaveLength(1);
  });

  it("preserves saved class history while allowing a coherent ungraded assessment edit", async () => {
    const oldAssessment = (await db!.query("select * from public.teacher_assessments where id=$1", [assessments.a])).rows;
    const oldMarks = (await db!.query("select * from public.teacher_assessment_marks where assessment_id=$1", [assessments.a])).rows;
    await expect(asStaffActor(db!, ids.adminA, "update public.teacher_assessments set class_id=$2,section_id=$3 where id=$1", [assessments.a, records.privateClassA, records.privateSectionA])).rejects.toMatchObject({ code: "42501" });
    expect((await db!.query("select * from public.teacher_assessments where id=$1", [assessments.a])).rows).toEqual(oldAssessment);
    expect((await db!.query("select * from public.teacher_assessment_marks where assessment_id=$1", [assessments.a])).rows).toEqual(oldMarks);
    const id = (await insertAssessment(ids.adminA)).rows[0].id;
    expect((await asStaffActor(db!, ids.adminA, `update public.teacher_assessments set class_id=$2,section_id=$3
      where id=$1 returning class_id,section_id`, [id, records.privateClassA, records.privateSectionA])).rows)
      .toEqual([{ class_id: records.privateClassA, section_id: records.privateSectionA }]);
  });

  it("retains class-wide assignments and mark limits", async () => {
    await db!.query("update public.teacher_subject_assignments set section_id=null,is_class_teacher=false where id=$1", [records.A.assignment]);
    const id = (await insertAssessment(ids.teacherA, { section: null })).rows[0].id;
    await asStaffActor(db!, ids.teacherA, "insert into public.teacher_assessment_marks(assessment_id,student_id,marks_obtained) values($1,$2,50)", [id, records.A.student]);
    await expect(asStaffActor(db!, ids.teacherA, "update public.teacher_assessment_marks set marks_obtained=51 where assessment_id=$1", [id])).rejects.toMatchObject({ code: "22023" });
    await expect(asStaffActor(db!, ids.teacherA, "update public.teacher_assessments set maximum_marks=49 where id=$1", [id])).rejects.toThrow("Maximum marks cannot be lower");
    expect((await markRows(ids.teacherA, id)).rows[0].marks_obtained).toBe("50.00");
  });

  it("blocks anonymous access and TRUNCATE, including stray column grants; keeps public helpers invoker-only", async () => {
    await expect(asStaffActor(db!, null, "select id from public.teacher_assessments", [], "anon")).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db!, null, "select public.teacher_assessment_can_manage($1)", [assessments.a], "anon")).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db!, ids.teacherA, "truncate public.teacher_assessment_marks")).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db!, ids.adminA, "select app_private.lock_assessment_write_scope($1,$2,$3,$4,$5,$6)", [records.A.teacher, ids.schoolA, records.A.year, records.A.class, records.A.section, records.A.subject])).rejects.toMatchObject({ code: "42501" });
    const acl = await db!.query(`select has_table_privilege('authenticated','public.teacher_assessments','TRUNCATE') as truncate,
      has_any_column_privilege('anon','public.teacher_assessments','SELECT,INSERT,UPDATE,REFERENCES') as anon_columns,
      (select bool_and(not prosecdef) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname in ('teacher_assessment_can_view','teacher_assessment_can_manage','teacher_assessment_is_assigned','teacher_assessment_is_school_admin','teacher_assessment_student_is_enrolled')) as invoker`);
    expect(acl.rows).toEqual([{ truncate: false, anon_columns: false, invoker: true }]);
  });
});
