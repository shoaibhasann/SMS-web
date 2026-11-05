// @vitest-environment node

import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asStaffActor, createStaffScopeDatabase, STAFF_IDS as actor, STAFF_ROWS as fixture } from "./staff-scope-fixture";

const migrations = new URL("../../supabase/migrations/", import.meta.url);
const monitorSql = "select public.get_attendance_submission_monitor($1) as monitor";
const updateSql = "select public.update_attendance_submission_cutoff($1,$2,$3,$4) as setting";
type Section = { section_id: string; expected_count: number; marked_count: number; unmarked_count: number; status: string; is_pending: boolean };
type Monitor = { day: string; as_of: string; cutoff_time: string | null; cutoff_at: string | null; cutoff_reached: boolean; revision: number; can_edit: boolean; session_state: string; year: { id: string } | null; roster_issue_count: number; sections: Section[] };

async function createMonitorDatabase() {
  const db = await createStaffScopeDatabase({ includeTeachingRpcs: true, applyGovernance: true });
  try {
    const files = await readdir(migrations);
    const file = files.find((name) => name.endsWith("_school_attendance_cutoff_monitor.sql"));
    if (!file) throw Error("Missing attendance cutoff migration");
    await db.exec(await readFile(new URL(file, migrations), "utf8"));
    // Calendar follows the actual database date, without changing server time.
    await db.query(`update public.academic_years set start_date = (statement_timestamp() at time zone 'Asia/Kolkata')::date - 30,
      end_date = (statement_timestamp() at time zone 'Asia/Kolkata')::date + 30`);
    return db;
  } catch (error) { await db.close(); throw error; }
}

function getMonitor(db: Awaited<ReturnType<typeof createMonitorDatabase>>, user: string, school = actor.schoolA) {
  return asStaffActor<{ monitor: Monitor }>(db, user, monitorSql, [school]).then(({ rows }) => rows[0].monitor);
}

describe("school attendance cutoff permissions and versioned changes", () => {
  let db: Awaited<ReturnType<typeof createMonitorDatabase>>;
  beforeEach(async () => { db = await createMonitorDatabase(); }, 30_000);
  afterEach(async () => { await db?.close(); });

  it("denies unauthorized roles and private table access while principals can monitor", async () => {
    for (const user of [actor.teacherA, actor.parentA, actor.studentA, actor.adminB, actor.outsider]) {
      await expect(getMonitor(db, user)).rejects.toMatchObject({ code: "42501" });
      await expect(asStaffActor(db, user, updateSql, [actor.schoolA, "09:30", 0, "QA cutoff setting"]))
        .rejects.toMatchObject({ code: "42501" });
    }
    await expect(asStaffActor(db, null, monitorSql, [actor.schoolA], "anon")).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, null, updateSql, [actor.schoolA, "09:30", 0, "QA cutoff setting"], "anon"))
      .rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, actor.adminA, "select * from app_private.attendance_submission_settings"))
      .rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, actor.adminA, "insert into app_private.attendance_submission_settings(school_id,revision,updated_by) values($1,1,$2)", [actor.schoolA, actor.adminA]))
      .rejects.toMatchObject({ code: "42501" });
    expect((await getMonitor(db, actor.principalA)).can_edit).toBe(false);
    await expect(asStaffActor(db, actor.principalA, updateSql, [actor.schoolA, "09:30", 0, "QA cutoff setting"]))
      .rejects.toMatchObject({ code: "42501" });
    expect((await getMonitor(db, actor.superAdmin)).can_edit).toBe(true);
    await db.query("update public.profiles set is_active=false where id=$1", [actor.adminA]);
    await expect(getMonitor(db, actor.adminA)).rejects.toMatchObject({ code: "42501" });
    await db.query("update public.profiles set is_active=true where id=$1", [actor.adminA]);
  });

  it("validates, audits changes and detects stale settings while supporting unset cutoff", async () => {
    const initial = await getMonitor(db, actor.adminA);
    expect(initial).toMatchObject({ cutoff_time: null, cutoff_at: null, cutoff_reached: false, revision: 0, can_edit: true });
    for (const cutoff of ["9:00", "24:00", "10:30:00", "09:61", ""]) {
      await expect(asStaffActor(db, actor.adminA, updateSql, [actor.schoolA, cutoff, 0, "QA setting"]))
        .rejects.toMatchObject({ code: "22023" });
    }
    await expect(asStaffActor(db, actor.adminA, updateSql, [actor.schoolA, "09:30", 0, "bad"]))
      .rejects.toMatchObject({ code: "22023" });
    const saved = await asStaffActor(db, actor.adminA, updateSql, [actor.schoolA, "09:30", 0, "School confirmed morning deadline"]);
    expect(saved.rows).toEqual([{ setting: { cutoff_time: "09:30", revision: 1 } }]);
    expect((await getMonitor(db, actor.adminA)).cutoff_time).toBe("09:30");
    expect((await getMonitor(db, actor.adminB, actor.schoolB)).cutoff_time).toBeNull();
    await expect(asStaffActor(db, actor.adminA, updateSql, [actor.schoolA, "10:00", 0, "Stale edit should be rejected"]))
      .rejects.toMatchObject({ code: "55000" });
    await asStaffActor(db, actor.adminA, updateSql, [actor.schoolA, "09:30", 1, "Repeat with no setting change"]);
    expect((await getMonitor(db, actor.adminA)).revision).toBe(1);
    await asStaffActor(db, actor.adminA, updateSql, [actor.schoolA, null, 1, "School disabled attendance cutoff"]);
    expect(await getMonitor(db, actor.adminA)).toMatchObject({ cutoff_time: null, cutoff_reached: false, revision: 2 });
    const { rows } = await db.query("select revision,previous_cutoff_time::text,cutoff_time::text,changed_by,reason from app_private.attendance_submission_settings_audit order by revision");
    expect(rows).toEqual([
      { revision: 1, previous_cutoff_time: null, cutoff_time: "09:30:00", changed_by: actor.adminA, reason: "School confirmed morning deadline" },
      { revision: 2, previous_cutoff_time: "09:30:00", cutoff_time: null, changed_by: actor.adminA, reason: "School disabled attendance cutoff" },
    ]);
  });
});

describe("current-day attendance monitor", () => {
  let db: Awaited<ReturnType<typeof createMonitorDatabase>>;
  beforeEach(async () => { db = await createMonitorDatabase(); }, 30_000);
  afterEach(async () => { await db?.close(); });

  it("counts exact current roster marks, derives partial/complete and leaves unmarked pupils untouched", async () => {
    const before = await getMonitor(db, actor.adminA);
    const firstSection = before.sections.find((section) => section.section_id === fixture.A.section)!;
    expect(firstSection).toMatchObject({ expected_count: 1, marked_count: 0, unmarked_count: 1, status: "unmarked", is_pending: false });
    const pupil = randomUUID();
    await db.query("insert into public.students(id,school_id,admission_no,first_name) values($1,$2,'CUTOFF-SECOND','Second pupil')", [pupil, actor.schoolA]);
    await db.query("insert into public.enrollments(student_id,academic_year_id,class_id,section_id) values($1,$2,$3,$4)", [pupil, fixture.A.year, fixture.A.class, fixture.A.section]);
    await db.query("insert into public.sections(id,school_id,class_id,name) values($1,$2,$3,'Empty')", [randomUUID(), actor.schoolA, fixture.A.class]);
    const prior = (await db.query("select count(*)::int as count from public.attendance")).rows;
    const current = await getMonitor(db, actor.adminA);
    expect(current.sections).toHaveLength(2);
    expect(current.sections.find((section) => section.section_id === fixture.A.section)).toMatchObject({ expected_count: 2, marked_count: 0, status: "unmarked" });
    expect((await db.query("select count(*)::int as count from public.attendance")).rows).toEqual(prior);
    await db.query(`insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status,marked_by)
      values($1,$2,$3,$4,(statement_timestamp() at time zone 'Asia/Kolkata')::date,'present',$5)`,
    [actor.schoolA, fixture.A.year, fixture.A.section, fixture.A.student, actor.teacherA]);
    expect((await getMonitor(db, actor.adminA)).sections.find((section) => section.section_id === fixture.A.section))
      .toMatchObject({ expected_count: 2, marked_count: 1, unmarked_count: 1, status: "partial" });
    const currentTime = new Date(current.as_of).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour12: false });
    const canTestBefore = currentTime < "23:59:00";
    if (canTestBefore) {
      await asStaffActor(db, actor.adminA, updateSql, [actor.schoolA, "23:59", 0, "QA future cutoff"]);
      expect((await getMonitor(db, actor.adminA)).sections.every((section) => !section.is_pending)).toBe(true);
    }
    await asStaffActor(db, actor.adminA, updateSql, [actor.schoolA, "00:00", canTestBefore ? 1 : 0, "QA expired cutoff"]);
    expect((await getMonitor(db, actor.adminA)).sections.find((section) => section.section_id === fixture.A.section))
      .toMatchObject({ status: "partial", is_pending: true, marked_count: 1, unmarked_count: 1 });
    await db.query(`insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status,marked_by)
      values($1,$2,$3,$4,(statement_timestamp() at time zone 'Asia/Kolkata')::date,'holiday',$5)`,
    [actor.schoolA, fixture.A.year, fixture.A.section, pupil, actor.teacherA]);
    expect((await getMonitor(db, actor.adminA)).sections.find((section) => section.section_id === fixture.A.section))
      .toMatchObject({ status: "complete", is_pending: false, marked_count: 2, unmarked_count: 0 });
  });

  it("flags invalid enrollment mappings and excludes inactive/staged roster and incorrect marks", async () => {
    const bad = randomUUID();
    await db.query("insert into public.students(id,school_id,admission_no,first_name) values($1,$2,'BAD-CUTOFF','Missing section')", [bad, actor.schoolA]);
    await db.query("insert into public.enrollments(student_id,academic_year_id,class_id) values($1,$2,$3)", [bad, fixture.A.year, fixture.A.class]);
    expect((await getMonitor(db, actor.adminA)).roster_issue_count).toBe(1);
    await db.query("update public.enrollments set section_id=$2 where student_id=$1", [bad, fixture.B.section]);
    expect((await getMonitor(db, actor.adminA)).roster_issue_count).toBe(1);
    await db.query("update public.enrollments set status='staged' where student_id=$1", [bad]);
    expect((await getMonitor(db, actor.adminA)).roster_issue_count).toBe(0);
    await db.query("update public.classes set is_active=false where id=$1", [fixture.privateClassA]);
    expect((await getMonitor(db, actor.adminA)).roster_issue_count).toBe(1);
    await db.query("update public.students set status='inactive' where id=$1", [fixture.privateStudentA]);
    expect((await getMonitor(db, actor.adminA)).roster_issue_count).toBe(0);
    const unlinkedPupil = randomUUID();
    await db.query("insert into public.students(id,school_id,admission_no,first_name) values($1,$2,'OTHER-MARK','Wrong section mark')", [unlinkedPupil, actor.schoolA]);
    await db.query("insert into public.enrollments(student_id,academic_year_id,class_id,section_id) values($1,$2,$3,$4)", [unlinkedPupil, fixture.A.year, fixture.A.class, fixture.A.section]);
    await db.query(`insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status,marked_by)
      values($1,$2,$3,$4,(statement_timestamp() at time zone 'Asia/Kolkata')::date,'present',$5)`,
    [actor.schoolA, fixture.A.year, fixture.privateSectionA, unlinkedPupil, actor.teacherA]);
    expect((await getMonitor(db, actor.adminA)).sections.find((section) => section.section_id === fixture.A.section))
      .toMatchObject({ expected_count: 2, marked_count: 0, unmarked_count: 2, status: "unmarked", is_pending: false });
  });

  it("reports missing, ambiguous and out-of-session years without misleading section progress", async () => {
    await db.query("update public.academic_years set start_date=(statement_timestamp() at time zone 'Asia/Kolkata')::date+1 where id=$1", [fixture.A.year]);
    expect(await getMonitor(db, actor.adminA)).toMatchObject({ session_state: "outside_dates", sections: [] });
    await db.query("update public.academic_years set is_current=false where id=$1", [fixture.A.year]);
    expect(await getMonitor(db, actor.adminA)).toMatchObject({ session_state: "missing", year: null, sections: [] });
    await db.query("update public.academic_years set is_current=true where id=$1", [fixture.A.year]);
    await db.query("insert into public.academic_years(school_id,name,start_date,end_date,is_current) values($1,'Ambiguous',current_date-30,current_date+30,true)", [actor.schoolA]);
    expect(await getMonitor(db, actor.adminA)).toMatchObject({ session_state: "ambiguous", year: null, sections: [] });
  });
});
