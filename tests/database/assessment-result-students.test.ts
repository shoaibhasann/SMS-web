// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

const uuid = (suffix: number) => `76000000-0000-0000-0000-${String(suffix).padStart(12, "0")}`;
const otherSection = uuid(1), idleTeacher = uuid(2), idleTeacherRecord = uuid(3), peerMark = uuid(4);
let db: PGlite;

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  await db.query("insert into public.sections(id,school_id,class_id,name) values($1,$2,$3,'Recovery B')", [otherSection, id.schoolA, id.classA]);
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'idle-teacher@result.invalid',now())", [idleTeacher]);
  await db.query("update public.profiles set school_id=$2,full_name='Unassigned teacher' where id=$1", [idleTeacher, id.schoolA]);
  await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'teacher')", [idleTeacher, id.schoolA]);
  await db.query("insert into public.teachers(id,school_id,profile_id,employee_id,full_name) values($1,$2,$3,'RESULT-IDLE','Unassigned teacher')", [idleTeacherRecord, id.schoolA, idleTeacher]);
  await db.query("insert into public.teacher_assessment_marks(id,assessment_id,student_id,marks_obtained) values($1,$2,$3,61)", [peerMark, id.assessmentA, id.unlinkedPupilA]);
  // Same-session move exactly as change_roster_placement writes it: the enrollment's section is updated in place.
  await db.query("update public.enrollments set section_id=$2 where student_id=$1", [id.pupilA, otherSection]);
  await db.exec("insert into auth.sessions(id,user_id) select id,id from auth.users on conflict(id) do nothing");
}, 60_000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

async function actor<Row extends Record<string, unknown> = Record<string, unknown>>(
  user: string | null, sql: string, params: unknown[] = [], role: "authenticated" | "anon" = "authenticated",
) {
  await db.exec("savepoint result_students_actor");
  try {
    await db.exec(`set local role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [user ?? "", JSON.stringify({ sub: user, session_id: user })]);
    const result = await db.query<Row>(sql, params);
    await db.exec("reset role");
    await db.exec("release savepoint result_students_actor");
    return result;
  } catch (error) { await db.exec("rollback to savepoint result_students_actor; release savepoint result_students_actor"); throw error; }
}
const resultStudents = async (user: string | null, school = id.schoolA, assessments = [id.assessmentA], role: "authenticated" | "anon" = "authenticated") =>
  (await actor<{ id: string }>(user, "select * from public.list_assessment_result_students($1,$2) order by id", [school, assessments], role)).rows;

describe("teacher result report pupils after a same-session section move", () => {
  it("resolves every marked pupil through the assessment scope, not the pupil's current section", async () => {
    // Documents the RLS gap: the moved pupil's mark is visible but the pupil row is not.
    expect((await actor(id.teacherA, "select student_id from public.teacher_assessment_marks where assessment_id=$1", [id.assessmentA])).rows).toHaveLength(2);
    expect((await actor(id.teacherA, "select id from public.students where id = any($1)", [[id.pupilA, id.unlinkedPupilA]])).rows)
      .toEqual([{ id: id.unlinkedPupilA }]);
    expect(await resultStudents(id.teacherA)).toEqual([
      { id: id.pupilA, admission_no: "REC-A-001", first_name: "Synthetic recovery pupil", middle_name: null, last_name: null, roll_no: null },
      { id: id.unlinkedPupilA, admission_no: "REC-A-002", first_name: "Synthetic recovery pupil", middle_name: null, last_name: null, roll_no: null },
    ]);
    expect((await resultStudents(id.adminA)).map((row) => row.id)).toEqual([id.pupilA, id.unlinkedPupilA]);
  });

  it("returns only pupils that have a mark", async () => {
    await db.query("delete from public.teacher_assessment_marks where id=$1", [peerMark]);
    expect((await resultStudents(id.teacherA)).map((row) => row.id)).toEqual([id.pupilA]);
  });

  it("returns nothing outside the caller's assessment access", async () => {
    expect(await resultStudents(idleTeacher)).toEqual([]);
    expect(await resultStudents(id.adminB)).toEqual([]);
    expect(await resultStudents(id.adminB, id.schoolB)).toEqual([]);
    expect(await resultStudents(id.teacherA, id.schoolB)).toEqual([]);
    expect(await resultStudents(id.guardianA)).toEqual([]);
    expect(await resultStudents(id.studentUserA)).toEqual([]);
    await db.query("delete from public.user_roles where user_id=$1 and role='teacher'", [id.teacherA]);
    expect(await resultStudents(id.teacherA)).toEqual([]);
  });

  it("is not callable anonymously", async () => {
    await expect(resultStudents(null, id.schoolA, [id.assessmentA], "anon")).rejects.toMatchObject({ code: "42501" });
    expect((await db.query(`select has_function_privilege('anon','app_private.list_assessment_result_students(uuid,uuid[])','execute') as private_anon,
      has_function_privilege('anon','public.list_assessment_result_students(uuid,uuid[])','execute') as public_anon`)).rows)
      .toEqual([{ private_anon: false, public_anon: false }]);
  });
});
