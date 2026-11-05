// @vitest-environment node

import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asStaffActor, createStaffScopeDatabase, STAFF_IDS, STAFF_ROWS } from "./staff-scope-fixture";

const directory = new URL("../../supabase/migrations/", import.meta.url);
const { A, B } = STAFF_ROWS;
const { schoolA, adminA, adminB, principalA, teacherA, parentA, studentA } = STAFF_IDS;
const destinationClass = STAFF_ROWS.privateClassA;
const destinationSection = STAFF_ROWS.privateSectionA;
const nextYear = randomUUID();
const overlapYear = randomUUID();
const moveReason = "Update the class placement";
const placeSql = "select public.change_roster_placement($1,$2,$3,$4,$5,$6,$7,$8,$9) as id";

describe("audited roster placement changes", () => {
  let db: Awaited<ReturnType<typeof createStaffScopeDatabase>>;
  let today: string;
  let yesterday: string;
  let nextYearStart: string;

  beforeAll(async () => {
    db = await createStaffScopeDatabase({
      includeTeachingRpcs: true, applyGovernance: true, includeGuardianInvitations: true,
    });
    const files = await readdir(directory);
    for (const suffix of [
      "_repair_school_policy_helper.sql", "_guardian_invitations.sql", "_govern_attendance_corrections.sql",
      "_withdraw_roster_enrollment.sql", "_change_roster_placement.sql",
      "_attendance_optimistic_conflict_http_status.sql",
    ]) {
      const file = files.find((name) => name.endsWith(suffix));
      if (!file) throw new Error("Missing migration " + suffix);
      await db.exec(await readFile(new URL(file, directory), "utf8"));
    }
    const { rows: [dates] } = await db.query<{ today: string; yesterday: string; next_year: string }>(
      "select d::text as today, (d-1)::text as yesterday, (d+31)::text as next_year from (select (now() at time zone 'Asia/Kolkata')::date d) x",
    );
    ({ today, yesterday, next_year: nextYearStart } = dates);
    await db.query("update public.academic_years set start_date=$1::date-30,end_date=$1::date+30 where id in ($2,$3)", [today, A.year, B.year]);
    await db.query("update public.attendance set attendance_date=$1 where student_id=$2", [yesterday, A.student]);
    await db.query(
      "insert into public.academic_years(id,school_id,name,start_date,end_date,is_current) values($1,$3,'Next session',$4::date+31,$4::date+395,false),($2,$3,'Overlapping session',$4::date+15,$4::date+200,false)",
      [nextYear, overlapYear, schoolA, today],
    );
  }, 30000);

  afterAll(async () => { await db?.close(); });

  const placement = (
    actor = adminA as string, {
      year = A.year, classId = destinationClass, section = destinationSection, enrollment = A.enrollment,
      sourceClass = A.class, sourceSection = A.section, reason = moveReason, key = randomUUID(),
    }: { year?: string; classId?: string; section?: string; enrollment?: string; sourceClass?: string;
      sourceSection?: string; reason?: string; key?: string } = {},
  ) => asStaffActor<{ id: string }>(db, actor, placeSql,
    [schoolA, enrollment, sourceClass, sourceSection, year, classId, section, reason, key]);

  const historicalRoster = (actor: string, day: string, classId: string = A.class, section: string = A.section) =>
    asStaffActor(db, actor, "select id,roll_no from public.list_attendance_register_students($1,$2,$3,$4,$5) order by id",
      [schoolA, A.year, classId, section, day]);

  it("preserves original dated attendance and receipts, and validates both move scopes", async () => {
    const key = randomUUID();
    const attendance = "select id,status,section_id,revision::integer from public.attendance where student_id=$1 and attendance_date=$2";
    const previous = (await db.query<{ id: string; revision: number }>(attendance, [A.student, yesterday])).rows[0];
    const feeSql = "select id, student_id, student_fee_id, amount from public.fee_payments where id=$1";
    const previousFee = (await db.query(feeSql, [A.payment])).rows;
    const correctionSql = "select public.request_attendance_correction($1,$2,$3,$4,$5,$6,$7,'late',$8,$9) as id";
    const requestCorrection = async (correctionKey: string) => (await asStaffActor<{ id: string }>(
      db, teacherA, correctionSql,
      [schoolA, A.year, A.section, A.student, yesterday, previous.id, previous.revision, "Verify late arrival", correctionKey],
    )).rows[0].id;
    const markToday = (actor: string, sectionId: string = A.section) => asStaffActor(
      db, actor, "insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status,marked_by) values($1,$2,$3,$4,$5,'present',$6) returning id",
      [schoolA, A.year, sectionId, A.student, today, actor],
    );

    await expect(placement(adminB)).rejects.toMatchObject({ code: "42501" });
    await expect(placement(teacherA)).rejects.toMatchObject({ code: "42501" });
    await expect(placement(adminA, { year: B.year, classId: B.class, section: B.section })).rejects.toMatchObject({ code: "22023" });
    await expect(placement(adminA, { classId: B.class, section: B.section })).rejects.toMatchObject({ code: "22023" });
    await expect(placement(adminA, { sourceSection: destinationSection })).rejects.toMatchObject({ code: "22023" });
    await expect(placement(adminA, { reason: "  " })).rejects.toMatchObject({ code: "22023" });
    await expect(placement(adminA, { classId: A.class, section: A.section })).rejects.toMatchObject({ code: "22023" });
    await expect(asStaffActor(db, adminA, "update public.enrollments set section_id=$2 where id=$1", [A.enrollment, destinationSection]))
      .rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, adminA, "delete from public.enrollments where id=$1", [A.enrollment]))
      .rejects.toMatchObject({ code: "42501" });

    const pending = await requestCorrection(randomUUID());
    await expect(placement()).rejects.toThrow("Resolve pending attendance corrections");
    await asStaffActor(db, principalA, "select public.review_attendance_correction($1,'rejected','Keep the original mark')", [pending]);

    expect((await markToday(teacherA)).rows).toHaveLength(1);
    await expect(placement()).rejects.toThrow("Attendance already exists for today");
    await db.query("delete from public.attendance where student_id=$1 and attendance_date=$2", [A.student, today]);

    expect((await placement(adminA, { key })).rows).toEqual([{ id: A.enrollment }]);
    expect((await placement(adminA, { key, reason: "  Update  the class placement  " })).rows).toEqual([{ id: A.enrollment }]);
    await expect(placement(adminA, { key, reason: "A different move reason" })).rejects.toMatchObject({ code: "23505" });
    await expect(placement(adminA, { classId: A.class, section: A.section, sourceClass: destinationClass, sourceSection: destinationSection }))
      .rejects.toThrow("already changed placement today");
    expect((await db.query("select id,class_id,section_id,roll_no from public.enrollments where student_id=$1 and academic_year_id=$2", [A.student, A.year])).rows)
      .toEqual([{ id: A.enrollment, class_id: destinationClass, section_id: destinationSection, roll_no: null }]);
    const history = "select * from public.list_roster_placement_changes($1,$2,$3,$4)";
    expect((await asStaffActor(db, principalA, history, [schoolA, A.year, A.class, A.section])).rows)
      .toEqual([expect.objectContaining({ request_id: key, change_kind: "move", effective_date: expect.anything(),
        admission_no: "STUDENT-A", reason: moveReason, changed_by_name: "adminA" })]);
    await expect(asStaffActor(db, adminB, history, [schoolA, A.year, A.class, A.section])).rejects.toMatchObject({ code: "42501" });

    expect((await historicalRoster(teacherA, yesterday)).rows).toEqual([{ id: A.student, roll_no: "1" }]);
    expect((await historicalRoster(teacherA, today)).rows).toEqual([]);
    expect((await historicalRoster(adminA, today, destinationClass, destinationSection)).rows).toContainEqual({ id: A.student, roll_no: null });
    await expect(historicalRoster(teacherA, yesterday, destinationClass, destinationSection)).rejects.toMatchObject({ code: "42501" });
    await expect(historicalRoster(adminB, yesterday)).rejects.toMatchObject({ code: "42501" });
    await expect(historicalRoster(parentA, yesterday)).rejects.toMatchObject({ code: "42501" });
    await expect(markToday(teacherA)).rejects.toMatchObject({ code: "42501" });
    expect((await markToday(adminA, destinationSection)).rows).toHaveLength(1);
    expect((await asStaffActor(db, teacherA, attendance, [A.student, today])).rows).toEqual([]);
    for (const actor of [teacherA, parentA, studentA]) {
      expect((await asStaffActor(db, actor, attendance, [A.student, yesterday])).rows).toEqual([previous]);
    }
    expect((await asStaffActor(db, parentA, feeSql, [A.payment])).rows).toEqual(previousFee);
    const correctionAfterMove = await requestCorrection(randomUUID());
    const approved = await asStaffActor(db, principalA, "select public.review_attendance_correction($1,'approved','Verified against register') as state", [correctionAfterMove]);
    expect(approved.rows).toEqual([{ state: "approved" }]);
    expect((await db.query(attendance, [A.student, yesterday])).rows).toEqual([
      { ...previous, status: "late", revision: previous.revision + 1 },
    ]);
  });

  it("stages one destination, supports audited restaging and cancels staging on withdrawal", async () => {
    const key = randomUUID();
    const source = { sourceClass: destinationClass, sourceSection: destinationSection, enrollment: STAFF_ROWS.privateEnrollmentA };
    const pupil = STAFF_ROWS.privateStudentA;
    const target = { ...source, year: nextYear, classId: A.class, section: A.section };
    await expect(placement(adminA, { ...target, year: overlapYear })).rejects.toMatchObject({ code: "22023" });
    await expect(asStaffActor(db, adminA,
      "insert into public.enrollments(student_id,academic_year_id,class_id,section_id,status) values($1,$2,$3,$4,'staged')",
      [pupil, nextYear, A.class, A.section])).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, adminA,
      "insert into public.enrollments(student_id,academic_year_id,class_id,section_id) values($1,$2,$3,$4)",
      [pupil, nextYear, A.class, A.section])).rejects.toMatchObject({ code: "42501" });

    const [{ id }] = (await placement(principalA, { ...target, key })).rows;
    expect(id).not.toBe(source.enrollment);
    expect((await placement(principalA, { ...target, key })).rows).toEqual([{ id }]);
    await expect(placement(principalA, target)).rejects.toMatchObject({ code: "23505" });
    const updatedTarget = { ...target, classId: destinationClass, section: destinationSection };
    expect((await placement(principalA, updatedTarget)).rows).toEqual([{ id }]);
    expect((await placement(principalA, { ...target, key })).rows).toEqual([{ id }]);
    await expect(placement(principalA, updatedTarget)).rejects.toMatchObject({ code: "23505" });
    const rows = "select id,status,academic_year_id,section_id from public.enrollments where student_id=$1 order by status";
    expect((await db.query(rows, [pupil])).rows).toEqual([
      { id: source.enrollment, status: "active", academic_year_id: A.year, section_id: destinationSection },
      { id, status: "staged", academic_year_id: nextYear, section_id: destinationSection },
    ]);
    expect((await asStaffActor(db, adminA,
      "select effective_date::text from public.list_roster_placement_changes($1,$2,$3,$4)",
      [schoolA, A.year, destinationClass, destinationSection])).rows).toEqual([{ effective_date: nextYearStart }, { effective_date: nextYearStart }]);
    await expect(asStaffActor(db, adminA, "update public.enrollments set status='active' where id=$1", [id]))
      .rejects.toMatchObject({ code: "42501" });

    await asStaffActor(db, adminA, "select public.withdraw_roster_enrollment($1,$2,$3,$4,$5,$6)",
      [schoolA, A.year, destinationClass, destinationSection, pupil, "Family relocation"]);
    expect((await db.query(rows, [pupil])).rows).toEqual([
      { id, status: "cancelled", academic_year_id: nextYear, section_id: destinationSection },
      { id: source.enrollment, status: "withdrawn", academic_year_id: A.year, section_id: destinationSection },
    ]);
    expect((await db.query("select count(*)::int as count from app_private.roster_placement_changes where student_id=$1", [pupil])).rows)
      .toEqual([{ count: 2 }]);
  });

  it("keeps staged and cancelled placements and their class content private to office staff", async () => {
    const classId = randomUUID();
    const sectionId = randomUUID();
    const enrollmentId = randomUUID();
    const logId = randomUUID();
    const activityId = randomUUID();
    const materialId = randomUUID();
    const timetableId = randomUUID();
    await db.query("insert into public.classes(id,school_id,name) values($1,$2,'Future class')", [classId, schoolA]);
    await db.query("insert into public.sections(id,school_id,class_id,name) values($1,$2,$3,'Future section')", [sectionId, schoolA, classId]);
    await db.query("insert into public.enrollments(id,student_id,academic_year_id,class_id,section_id,status) values($1,$2,$3,$4,$5,'staged')",
      [enrollmentId, A.student, nextYear, classId, sectionId]);
    await db.query("insert into public.teacher_subject_assignments(teacher_id,academic_year_id,class_id,section_id,subject_id) values($1,$2,$3,$4,$5)",
      [A.teacher, nextYear, classId, sectionId, A.subject]);
    await db.query(`insert into public.class_logs
      (id,school_id,academic_year_id,class_id,section_id,teacher_id,subject_id,log_date,topic,status)
      values($1,$2,$3,$4,$5,$6,$7,$8,'Future log','published')`,
    [logId, schoolA, nextYear, classId, sectionId, A.teacher, A.subject, nextYearStart]);
    await db.query("insert into public.class_activities(id,class_log_id,activity_type,title) values($1,$2,'homework','Future activity')", [activityId, logId]);
    await db.query("insert into public.study_materials(id,school_id,class_id,section_id,title,published_at) values($1,$2,$3,$4,'Future material',now())",
      [materialId, schoolA, classId, sectionId]);
    await db.query(`insert into public.timetables
      (id,school_id,academic_year_id,class_id,section_id,teacher_id,subject_id,day_of_week,period_no)
      values($1,$2,$3,$4,$5,$6,$7,1,1)`, [timetableId, schoolA, nextYear, classId, sectionId, A.teacher, A.subject]);

    const probes = [
      ["select id from public.enrollments where id=$1", enrollmentId],
      ["select id from public.class_logs where id=$1", logId],
      ["select id from public.class_activities where id=$1", activityId],
      ["select id from public.study_materials where id=$1", materialId],
      ["select id from public.timetables where id=$1", timetableId],
    ];
    for (const status of ["staged", "cancelled", "active"]) {
      await db.query("update public.enrollments set status=$2 where id=$1", [enrollmentId, status]);
      expect((await asStaffActor(db, adminA, probes[0][0], [enrollmentId])).rows).toEqual([{ id: enrollmentId }]);
      expect((await asStaffActor(db, teacherA, probes[0][0], [enrollmentId])).rows)
        .toEqual(status === "active" ? [{ id: enrollmentId }] : []);
      for (const actor of [parentA, studentA]) {
        for (const [query, id] of probes) {
          expect((await asStaffActor(db, actor, query, [id])).rows).toEqual(status === "active" ? [{ id }] : []);
        }
      }
    }
  });
});
