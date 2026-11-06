// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { ASSESSMENT_IDS, createAssessmentAccessDatabase } from "./assessment-access-fixture";
import { asStaffActor, STAFF_IDS, STAFF_ROWS } from "./staff-scope-fixture";

type Database = Awaited<ReturnType<typeof createAssessmentAccessDatabase>>;
type Version = { id: string; assessment_id: string; student_id: string; updated_at: string; marks_obtained: string; remarks: string | null };
const databases: Database[] = [];
async function database() { const db = await createAssessmentAccessDatabase(); databases.push(db); return db; }
afterEach(async () => { await Promise.all(databases.splice(0).map((db) => db.close())); });
const loadSql = "select id,assessment_id,student_id,updated_at::text,marks_obtained::text,remarks from public.teacher_assessment_marks where assessment_id=$1";
// Same atomic predicates sent by saveChangedMarks through PostgREST, exercised
// here with real recovered constraints, triggers, and the current access patch.
const updateSql = `update public.teacher_assessment_marks set marks_obtained=$1,remarks=$2
  where id=$3 and assessment_id=$4 and student_id=$5 and updated_at=$6::timestamptz
  and marks_obtained=$7::numeric and remarks is not distinct from $8::text returning id`;
const params = (version: Version, value: number) => [value, null, version.id, version.assessment_id, version.student_id, version.updated_at, version.marks_obtained, version.remarks];

describe("assessment conditional writes under recovered SQL/RLS", () => {
  it("rejects a stale loaded version after another request commits without changing the newer row", async () => {
    const db = await database();
    const version = (await asStaffActor<Version>(db, STAFF_IDS.teacherA, loadSql, [ASSESSMENT_IDS.a])).rows[0];
    await asStaffActor(db, STAFF_IDS.teacherA, "update public.teacher_assessment_marks set marks_obtained=43,remarks='Other session' where id=$1", [version.id]);
    const newer = (await db.query("select * from public.teacher_assessment_marks where id=$1", [version.id])).rows;
    expect((await asStaffActor(db, STAFF_IDS.teacherA, updateSql, params(version, 40))).rows).toEqual([]);
    expect((await db.query("select * from public.teacher_assessment_marks where id=$1", [version.id])).rows).toEqual(newer);
    const refreshed = (await asStaffActor<Version>(db, STAFF_IDS.teacherA, loadSql, [ASSESSMENT_IDS.a])).rows[0];
    expect((await asStaffActor(db, STAFF_IDS.teacherA, updateSql, params(refreshed, 40))).rows).toEqual([{ id: version.id }]);
  });

  it("preserves the first accepted insert when another request still thinks that pupil is unmarked", async () => {
    const db = await database();
    await asStaffActor(db, STAFF_IDS.teacherA, "delete from public.teacher_assessment_marks where assessment_id=$1", [ASSESSMENT_IDS.a]);
    const sql = "insert into public.teacher_assessment_marks(assessment_id,student_id,marks_obtained) values($1,$2,$3) returning id";
    await asStaffActor(db, STAFF_IDS.teacherA, sql, [ASSESSMENT_IDS.a, STAFF_ROWS.A.student, 42]);
    await expect(asStaffActor(db, STAFF_IDS.teacherA, sql, [ASSESSMENT_IDS.a, STAFF_ROWS.A.student, 30])).rejects.toMatchObject({ code: "23505" });
    expect((await db.query("select marks_obtained from public.teacher_assessment_marks where assessment_id=$1", [ASSESSMENT_IDS.a])).rows).toEqual([{ marks_obtained: "42.00" }]);
  });

  it("does not overwrite a replacement mark with the old deleted row's identity", async () => {
    const db = await database();
    const version = (await asStaffActor<Version>(db, STAFF_IDS.teacherA, loadSql, [ASSESSMENT_IDS.a])).rows[0];
    await asStaffActor(db, STAFF_IDS.teacherA, "delete from public.teacher_assessment_marks where id=$1", [version.id]);
    await asStaffActor(db, STAFF_IDS.teacherA, "insert into public.teacher_assessment_marks(assessment_id,student_id,marks_obtained) values($1,$2,44)", [ASSESSMENT_IDS.a, STAFF_ROWS.A.student]);
    expect((await asStaffActor(db, STAFF_IDS.teacherA, updateSql, params(version, 40))).rows).toEqual([]);
    expect((await db.query("select marks_obtained from public.teacher_assessment_marks where assessment_id=$1", [ASSESSMENT_IDS.a])).rows).toEqual([{ marks_obtained: "44.00" }]);
  });
});
