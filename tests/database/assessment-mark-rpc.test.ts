// @vitest-environment node
import { readFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { ASSESSMENT_IDS as exams, createAssessmentAccessDatabase } from "./assessment-access-fixture";
import { asStaffActor, STAFF_IDS as actors, STAFF_ROWS as rows } from "./staff-scope-fixture";

type Database = Awaited<ReturnType<typeof createAssessmentAccessDatabase>>;
type Parent = { id: string; updated_at: string };
type Mark = { id: string; assessment_id: string; student_id: string; updated_at: string; marks_obtained: string; remarks: string | null };
type Saved = { id: string; assessment_id: string; student_id: string; updated_at: string; marks_obtained: number; remarks: string | null };
const databases: Database[] = [];
const directory = new URL("../../supabase/migrations/", import.meta.url);
const migration = new URL("20261105192540_optimistic_assessment_mark_writes.sql", directory);
const rpc = `select public.save_assessment_mark($1::uuid,$2::timestamptz,$3::uuid,$4::uuid,
  $5::timestamptz,$6::numeric,$7::text,$8::numeric,$9::text) as mark`;
const pupilB = "40000000-0000-0000-0000-000000000701";
const ungradedExam = "40000000-0000-0000-0000-000000000702";
const extraSubject = "40000000-0000-0000-0000-000000000703";

async function database() {
  const db = await createAssessmentAccessDatabase();
  databases.push(db);
  const sql = await readFile(migration, "utf8");
  if (!sql.trim()) throw new Error("Optimistic mark migration is empty.");
  await db.exec(sql);
  return db;
}
afterEach(async () => { await Promise.all(databases.splice(0).map((db) => db.close())); });

async function parent(db: Database, id = exams.a) {
  return (await db.query<Parent>("select id,updated_at::text from public.teacher_assessments where id=$1", [id])).rows[0];
}
async function mark(db: Database) {
  return (await db.query<Mark>(`select id,assessment_id,student_id,updated_at::text,marks_obtained::text,remarks
    from public.teacher_assessment_marks where assessment_id=$1`, [exams.a])).rows[0];
}
const args = (assessment: Parent, before: Mark | null, score: number, student = rows.A.student): unknown[] => [
  assessment.id, assessment.updated_at, student, before?.id ?? null, before?.updated_at ?? null,
  before?.marks_obtained ?? null, before?.remarks ?? null, score, null,
];
async function allMarks(db: Database) {
  return (await db.query("select * from public.teacher_assessment_marks order by id")).rows;
}

it("rejects a stale parent scale even when the loaded mark itself is unchanged", async () => {
  const db = await database();
  const assessment = await parent(db);
  const before = await mark(db);
  await asStaffActor(db, actors.teacherA, "update public.teacher_assessments set maximum_marks=100 where id=$1", [assessment.id]);
  const unchanged = await allMarks(db);
  await expect(asStaffActor(db, actors.teacherA, rpc, args(assessment, before, 40))).rejects.toMatchObject({ code: "40001" });
  expect(await allMarks(db)).toEqual(unchanged);
  const refreshed = await parent(db);
  const saved = await asStaffActor<{ mark: Saved }>(db, actors.teacherA, rpc, args(refreshed, before, 40));
  expect(saved.rows[0].mark).toMatchObject({ id: before.id, marks_obtained: 40 });
});

it("rejects unobserved subject relocation of an ungraded assessment before creating the first mark", async () => {
  const db = await database();
  await db.query("insert into public.subjects(id,school_id,name) values($1,$2,'Other assigned subject')", [extraSubject, actors.schoolA]);
  await db.query(`insert into public.teacher_subject_assignments(teacher_id,academic_year_id,class_id,section_id,subject_id)
    values($1,$2,$3,$4,$5)`, [rows.A.teacher, rows.A.year, rows.A.class, rows.A.section, extraSubject]);
  await db.query(`insert into public.teacher_assessments(id,school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,name,assessment_date,maximum_marks)
    values($1,$2,$3,$4,$5,$6,$7,'Ungraded exam','2026-11-05',50)`, [ungradedExam, actors.schoolA, rows.A.year, rows.A.class, rows.A.section, rows.A.subject, rows.A.teacher]);
  const original = await parent(db, ungradedExam);
  await asStaffActor(db, actors.teacherA, "update public.teacher_assessments set subject_id=$1 where id=$2", [extraSubject, ungradedExam]);
  const before = await allMarks(db);
  await expect(asStaffActor(db, actors.teacherA, rpc, args(original, null, 20))).rejects.toMatchObject({ code: "40001" });
  expect(await allMarks(db)).toEqual(before);
});

it("detects mark ABA and no-op updates inside one transaction with strictly increasing server timestamps", async () => {
  const db = await database();
  const assessment = await parent(db);
  const original = await mark(db);
  await asStaffActor(db, actors.teacherA, "update public.teacher_assessment_marks set marks_obtained=43 where id=$1", [original.id]);
  const changed = await mark(db);
  await db.exec("begin; set local role authenticated");
  try {
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [actors.teacherA]);
    await db.query("update public.teacher_assessment_marks set marks_obtained=35,updated_at=$1 where id=$2", [original.updated_at, original.id]);
    const restored = await mark(db);
    await db.query("update public.teacher_assessment_marks set marks_obtained=marks_obtained where id=$1", [original.id]);
    const noop = await mark(db);
    expect((await db.query("select $1::timestamptz>$2::timestamptz as newer", [restored.updated_at, changed.updated_at])).rows).toEqual([{ newer: true }]);
    expect((await db.query("select $1::timestamptz>$2::timestamptz as newer", [noop.updated_at, restored.updated_at])).rows).toEqual([{ newer: true }]);
    await db.exec("commit");
  } catch (error) { await db.exec("rollback"); throw error; }
  await expect(asStaffActor(db, actors.teacherA, rpc, args(assessment, original, 40))).rejects.toMatchObject({ code: "40001" });
  expect((await mark(db)).marks_obtained).toBe("35.00");
});

it("allows separate pupils to save under one unchanged parent version without promoting another pupil's baseline", async () => {
  const db = await database();
  await db.query("insert into public.students(id,school_id,admission_no,first_name) values($1,$2,'RPC-SECOND','Second pupil')", [pupilB, actors.schoolA]);
  await db.query("insert into public.enrollments(student_id,academic_year_id,class_id,section_id) values($1,$2,$3,$4)", [pupilB, rows.A.year, rows.A.class, rows.A.section]);
  const assessment = await parent(db);
  const before = await mark(db);
  const first = await asStaffActor<{ mark: Saved }>(db, actors.teacherA, rpc, args(assessment, before, 40));
  const second = await asStaffActor<{ mark: Saved }>(db, actors.teacherA, rpc, args(assessment, null, 25, pupilB));
  expect(first.rows[0].mark).toMatchObject({ id: before.id, marks_obtained: 40 });
  expect(second.rows[0].mark).toMatchObject({ student_id: pupilB, marks_obtained: 25 });
  expect(await parent(db)).toEqual(assessment);
  await expect(asStaffActor(db, actors.teacherA, rpc, args(assessment, null, 30, pupilB))).rejects.toMatchObject({ code: "23505" });
});

it("retains actor, school, assignment and anonymous boundaries on the invoker RPC", async () => {
  const db = await database();
  const assessment = await parent(db);
  const before = await mark(db);
  const originalRows = await allMarks(db);
  for (const actor of [null, actors.teacherB, actors.principalA, actors.parentA, actors.studentA]) {
    await expect(asStaffActor(db, actor, rpc, args(assessment, before, 40))).rejects.toThrow();
  }
  await db.query("update public.profiles set is_active=false where id=$1", [actors.teacherA]);
  await expect(asStaffActor(db, actors.teacherA, rpc, args(assessment, before, 40))).rejects.toThrow();
  await db.query("update public.profiles set is_active=true where id=$1", [actors.teacherA]);
  await db.query("delete from public.user_roles where user_id=$1 and role='teacher'", [actors.teacherA]);
  await expect(asStaffActor(db, actors.teacherA, rpc, args(assessment, before, 40))).rejects.toThrow();
  await expect(asStaffActor(db, null, rpc, args(assessment, before, 40), "anon")).rejects.toMatchObject({ code: "42501" });
  expect(await allMarks(db)).toEqual(originalRows);
});

it("requires a valid new-row intent and exact pupil identity before any row is created or changed", async () => {
  const db = await database();
  const assessment = await parent(db);
  const before = await mark(db);
  const originalRows = await allMarks(db);
  const inconsistentNew = args(assessment, null, 25);
  inconsistentNew[4] = before.updated_at;
  inconsistentNew[5] = before.marks_obtained;
  await expect(asStaffActor(db, actors.teacherA, rpc, inconsistentNew)).rejects.toThrow();
  const wrongPupil = args(assessment, before, 25, rows.B.student);
  await expect(asStaffActor(db, actors.teacherA, rpc, wrongPupil)).rejects.toThrow();
  expect(await allMarks(db)).toEqual(originalRows);
  expect((await db.query("select p.prosecdef,p.proconfig,has_function_privilege('anon',p.oid,'EXECUTE') as anon_exec from pg_proc p where p.oid='public.save_assessment_mark(uuid,timestamptz,uuid,uuid,timestamptz,numeric,text,numeric,text)'::regprocedure")).rows).toEqual([{ prosecdef: false, proconfig: ['search_path=""'], anon_exec: false }]);
});

it("preserves existing active school-admin and global-super-admin write authority", async () => {
  const db = await database();
  const assessment = await parent(db);
  const first = await mark(db);
  expect((await asStaffActor<{ mark: Saved }>(db, actors.adminA, rpc, args(assessment, first, 40))).rows[0].mark).toMatchObject({ id: first.id, marks_obtained: 40 });
  const second = await mark(db);
  expect((await asStaffActor<{ mark: Saved }>(db, actors.superAdmin, rpc, args(assessment, second, 45))).rows[0].mark).toMatchObject({ id: first.id, marks_obtained: 45 });
});

it("rejects nonfinite versions and normalizes legacy infinity tokens on the next parent or mark update", async () => {
  const db = await database();
  await db.query(`insert into public.teacher_assessments(id,school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,name,assessment_date,maximum_marks,updated_at)
    values($1,$2,$3,$4,$5,$6,$7,'Legacy timestamp','2026-11-05',50,'infinity')`, [ungradedExam, actors.schoolA, rows.A.year, rows.A.class, rows.A.section, rows.A.subject, rows.A.teacher]);
  const infinityParent = await parent(db, ungradedExam);
  expect(infinityParent.updated_at).toBe("infinity");
  await expect(asStaffActor(db, actors.teacherA, rpc, args(infinityParent, null, 20))).rejects.toMatchObject({ code: "22023" });
  await asStaffActor(db, actors.teacherA, "update public.teacher_assessments set name=name where id=$1", [ungradedExam]);
  expect((await db.query("select isfinite(updated_at) as finite from public.teacher_assessments where id=$1", [ungradedExam])).rows).toEqual([{ finite: true }]);
  const normalizedParent = await parent(db, ungradedExam);
  expect((await asStaffActor<{ mark: Saved }>(db, actors.teacherA, rpc, args(normalizedParent, null, 20))).rows[0].mark).toMatchObject({ assessment_id: ungradedExam, marks_obtained: 20 });

  const normalParent = await parent(db);
  const original = await mark(db);
  await db.query("delete from public.teacher_assessment_marks where id=$1", [original.id]);
  await db.query("insert into public.teacher_assessment_marks(assessment_id,student_id,marks_obtained,updated_at) values($1,$2,35,'infinity')", [exams.a, rows.A.student]);
  const infinityMark = await mark(db);
  expect(infinityMark.updated_at).toBe("infinity");
  await expect(asStaffActor(db, actors.teacherA, rpc, args(normalParent, infinityMark, 40))).rejects.toMatchObject({ code: "22023" });
  await asStaffActor(db, actors.teacherA, "update public.teacher_assessment_marks set marks_obtained=marks_obtained where id=$1", [infinityMark.id]);
  expect((await db.query("select isfinite(updated_at) as finite from public.teacher_assessment_marks where id=$1", [infinityMark.id])).rows).toEqual([{ finite: true }]);
  const normalizedMark = await mark(db);
  expect((await asStaffActor<{ mark: Saved }>(db, actors.teacherA, rpc, args(normalParent, normalizedMark, 40))).rows[0].mark).toMatchObject({ id: normalizedMark.id, marks_obtained: 40 });
});
