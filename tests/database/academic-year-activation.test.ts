// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asStaffActor, createStaffScopeDatabase, STAFF_IDS, STAFF_ROWS } from "./staff-scope-fixture";

describe("academic year activation", () => {
  const { schoolA, schoolB, adminA, adminB, teacherA } = STAFF_IDS;
  const { A, B, privateEnrollmentA } = STAFF_ROWS;
  const nextYear = randomUUID();
  const laterYear = randomUUID();
  let db: Awaited<ReturnType<typeof createStaffScopeDatabase>>;
  let today: string;

  beforeAll(async () => {
    db = await createStaffScopeDatabase({ includeTeachingRpcs: true, applyGovernance: true });
    const directory = new URL("../../supabase/migrations/", import.meta.url);
    const files = await readdir(directory);
    for (const suffix of ["_guard_academic_year_setup.sql", "_govern_attendance_corrections.sql", "_change_roster_placement.sql", "_activate_academic_year.sql"]) {
      const file = files.find((item) => item.endsWith(suffix));
      if (!file) throw Error(`Missing migration ${suffix}`);
      await db.exec(await readFile(new URL(file, directory), "utf8"));
    }
    const { rows } = await db.query<{ today: string }>("select ((now() at time zone 'Asia/Kolkata')::date)::text as today");
    today = rows[0].today;
    await db.query("update public.academic_years set start_date=$1::date-120,end_date=$1::date-1 where id=$2", [today, A.year]);
    await db.query(`insert into public.academic_years (id,school_id,name,start_date,end_date,is_current)
      values ($1,$2,'Next session',$3::date,$3::date+120,false),
             ($4,$2,'Later session',$3::date+121,$3::date+240,false)`, [nextYear, schoolA, today, laterYear]);
    await db.query("update public.enrollments set status='withdrawn' where id=$1", [privateEnrollmentA]);
  }, 30000);

  afterAll(async () => { await db?.close(); });

  const args = () => [schoolA, A.year, nextYear] as const;
  function activate(actor: string, target = nextYear) {
    return asStaffActor(db, actor, "select public.activate_academic_year($1,$2,$3,$4) as id",
      [schoolA, A.year, target, "School reviewed all placements"]);
  }

  it("restricts activation and rejects direct calendar switches", async () => {
    await expect(activate(teacherA)).rejects.toMatchObject({ code: "42501" });
    await expect(activate(adminB)).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, adminA, "select public.preview_academic_year_activation($1,$2,$3)", [schoolA, A.year, B.year]))
      .rejects.toMatchObject({ code: "22023" });
    await expect(activate(adminA, laterYear)).rejects.toThrow("include today");
    await expect(asStaffActor(db, adminA, "update public.academic_years set is_current=false where id=$1", [A.year]))
      .rejects.toMatchObject({ code: "42501" });
  });

  it("checks readiness again, activates placements once and preserves historical data", async () => {
    const preview = async () => (await asStaffActor<{ checks: unknown }>(db, adminA,
      "select public.preview_academic_year_activation($1,$2,$3) as checks", [...args()])).rows[0].checks;
    expect(await preview()).toMatchObject({ can_start_today: true, unplaced: 1, destination_count: 0 });
    await expect(activate(adminA)).rejects.toThrow("missing or invalid student placements");
    const enrollment = randomUUID();
    await db.query(`insert into public.enrollments (id,student_id,academic_year_id,class_id,section_id,status)
      values ($1,$2,$3,$4,$5,'staged')`, [enrollment, A.student, nextYear, A.class, A.section]);

    const correction = randomUUID();
    await db.query(`insert into app_private.attendance_corrections
      (id,school_id,academic_year_id,section_id,student_id,attendance_date,requested_by,request_reason,requested_status)
      values ($1,$2,$3,$4,$5,$6::date-2,$7,'Review register','present')`,
    [correction, schoolA, A.year, A.section, A.student, today, teacherA]);
    expect(await preview()).toMatchObject({ unplaced: 0, destination_count: 1, pending_corrections: 1 });
    await expect(activate(adminA)).rejects.toThrow("pending attendance corrections");
    await db.query("delete from app_private.attendance_corrections where id=$1", [correction]);

    expect((await activate(adminA)).rows).toEqual([{ id: nextYear }]);
    expect((await activate(adminA)).rows).toEqual([{ id: nextYear }]);
    expect((await db.query("select id from public.academic_years where school_id=$1 and is_current", [schoolA])).rows).toEqual([{ id: nextYear }]);
    expect((await db.query("select status from public.enrollments where id in ($1,$2) order by id", [A.enrollment, enrollment])).rows)
      .toEqual([{ status: "active" }, { status: "active" }]);
    expect((await db.query("select id from public.academic_years where school_id=$1 and is_current", [schoolB])).rows).toEqual([{ id: B.year }]);
    expect((await db.query("select promoted_count,actor_id from app_private.academic_year_activations")).rows)
      .toEqual([{ promoted_count: 1, actor_id: adminA }]);
    expect((await db.query("select academic_year_id from public.attendance where student_id=$1", [A.student])).rows)
      .toEqual([{ academic_year_id: A.year }]);
    expect((await db.query("select id from public.fee_payments where id=$1", [A.payment])).rows).toEqual([{ id: A.payment }]);

    await db.query(`insert into public.teacher_subject_assignments
      (teacher_id,academic_year_id,class_id,section_id,subject_id,is_class_teacher)
      values ($1,$2,$3,$4,$5,true)`, [A.teacher, nextYear, A.class, A.section, A.subject]);
    expect((await db.query("select id from public.teacher_subject_assignments where teacher_id=$1", [A.teacher])).rows).toHaveLength(2);
  });
});
