// @vitest-environment node

import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asStaffActor, createStaffScopeDatabase, STAFF_IDS as actor, STAFF_ROWS } from "./staff-scope-fixture";

const directory = new URL("../../supabase/migrations/", import.meta.url);
const { A, B } = STAFF_ROWS;
const substitute = randomUUID();
const createSql = "select public.create_substitute_attendance_coverage($1,$2,$3,$4,$5,$6,$7) as id";
const listSql = "select public.list_my_effective_attendance_assignments() as assignments";
const setupSql = "select public.get_substitute_attendance_setup($1) as setup";
const revokeSql = "select public.revoke_substitute_attendance_coverage($1,$2,$3) as revoked";

describe("temporary attendance-only class-teacher coverage", () => {
  let db: Awaited<ReturnType<typeof createStaffScopeDatabase>>;
  let today: string;
  let yesterday: string;
  let tomorrow: string;

  beforeAll(async () => {
    db = await createStaffScopeDatabase({ includeTeachingRpcs: true, applyGovernance: true, includeGuardianInvitations: true });
    const files = await readdir(directory);
    for (const suffix of [
      "_repair_school_policy_helper.sql", "_guardian_invitations.sql", "_govern_attendance_corrections.sql",
      "_withdraw_roster_enrollment.sql", "_change_roster_placement.sql", "_substitute_attendance_coverage.sql",
    ]) {
      const file = files.find((name) => name.endsWith(suffix));
      if (!file) throw new Error("Missing migration " + suffix);
      await db.exec(await readFile(new URL(file, directory), "utf8"));
    }
    const dates = (await db.query<{ today: string; yesterday: string; tomorrow: string }>(
      "select d::text as today,(d-1)::text as yesterday,(d+1)::text as tomorrow from (select (now() at time zone 'Asia/Kolkata')::date d) x",
    )).rows[0];
    ({ today, yesterday, tomorrow } = dates);
    await db.query("update public.academic_years set start_date=$1::date-30,end_date=$1::date+30 where id in ($2,$3)", [today, A.year, B.year]);
    await db.query("update public.attendance set attendance_date=$1 where student_id=$2", [yesterday, A.student]);
    await db.query("update public.profiles set school_id=$2 where id=$1", [actor.outsider, actor.schoolA]);
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'teacher')", [actor.outsider, actor.schoolA]);
    await db.query("insert into public.teachers(id,school_id,profile_id,employee_id,full_name) values($1,$2,$3,'SUBSTITUTE-QA','QA Substitute')", [substitute, actor.schoolA, actor.outsider]);
  }, 30000);

  beforeEach(async () => {
    await db.exec("delete from app_private.substitute_attendance_coverages");
    await db.query("delete from public.attendance where attendance_date=$1", [today]);
    await db.query("update public.profiles set is_active=true,school_id=$2 where id=$1", [actor.outsider, actor.schoolA]);
    await db.query("update public.teacher_subject_assignments set is_class_teacher=true where id=$1", [A.assignment]);
    await db.query("update public.classes set is_active=true where id=$1", [A.class]);
  });
  afterAll(async () => { await db?.close(); });

  const create = (user: string = actor.adminA, options: {
    school?: string; source?: string; teacher?: string; start?: string; end?: string; reason?: string; id?: string;
  } = {}) => asStaffActor<{ id: string }>(db, user, createSql, [options.school ?? actor.schoolA,
    options.source ?? A.assignment, options.teacher ?? substitute, options.start ?? today,
    options.end ?? tomorrow, options.reason ?? "Cover the absent class teacher", options.id ?? randomUUID()]);
  const assignments = async (user: string = actor.outsider) => (await asStaffActor<{ assignments: {
    id: string; teacher_id: string; coverage_id: string | null; starts_on: string | null; ends_on: string | null;
  }[] }>(db, user, listSql)).rows[0].assignments;
  const mark = (user: string = actor.outsider, pupil = A.student as string, section = A.section as string) => asStaffActor(
    db, user, "insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status,marked_by) values($1,$2,$3,$4,$5,'present',$6) returning id,status,revision",
    [actor.schoolA, A.year, section, pupil, today, user],
  );
  const marks = (user: string = actor.outsider) => asStaffActor(db, user,
    "select student_id,attendance_date::text,status,revision from public.attendance where school_id=$1 order by attendance_date", [actor.schoolA]);
  const roster = (user: string = actor.outsider, day = today) => asStaffActor(db, user,
    "select id from public.list_attendance_register_students($1,$2,$3,$4,$5)", [actor.schoolA, A.year, A.class, A.section, day]);
  const revoke = (id: string, user: string = actor.principalA, reason = "Original teacher returned") => asStaffActor<{ revoked: boolean }>(
    db, user, revokeSql, [actor.schoolA, id, reason],
  );

  it("limits office actions to the target school's active Admin/Principal and rejects direct private access", async () => {
    for (const user of [actor.adminB, actor.teacherA, actor.parentA, actor.accountantA, actor.receptionA, actor.outsider]) {
      await expect(create(user)).rejects.toMatchObject({ code: "42501" });
      await expect(asStaffActor(db, user, setupSql, [actor.schoolA])).rejects.toMatchObject({ code: "42501" });
      await expect(revoke(randomUUID(), user)).rejects.toMatchObject({ code: "42501" });
    }
    await expect(asStaffActor(db, null, setupSql, [actor.schoolA], "anon")).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, actor.adminA, "select * from app_private.substitute_attendance_coverages")).rejects.toMatchObject({ code: "42501" });
    const id = (await create(actor.principalA)).rows[0].id;
    expect((await revoke(id, actor.adminA)).rows[0].revoked).toBe(true);
    await db.query("update public.profiles set is_active=false where id=$1", [actor.principalA]);
    try { await expect(create(actor.principalA)).rejects.toMatchObject({ code: "42501" }); }
    finally { await db.query("update public.profiles set is_active=true where id=$1", [actor.principalA]); }
  });

  it("validates dates, same-school identities, distinct source teacher, reasons and exact idempotent requests", async () => {
    for (const options of [{ start: yesterday }, { start: tomorrow, end: today }, { end: "infinity" }, { reason: "bad" }, { teacher: A.teacher }]) {
      await expect(create(actor.adminA, options)).rejects.toMatchObject({ code: "22023" });
    }
    await expect(create(actor.adminA, { teacher: B.teacher })).rejects.toMatchObject({ code: "42501" });
    await expect(create(actor.adminA, { source: B.assignment })).rejects.toMatchObject({ code: "42501" });
    await expect(create(actor.adminA, { end: "2100-01-01" })).rejects.toMatchObject({ code: "22023" });
    await db.query("update public.teacher_subject_assignments set is_class_teacher=false where id=$1", [A.assignment]);
    await expect(create()).rejects.toMatchObject({ code: "42501" });
    await db.query("update public.teacher_subject_assignments set is_class_teacher=true where id=$1", [A.assignment]);
    const id = randomUUID();
    expect((await create(actor.adminA, { id })).rows[0].id).toBe(id);
    expect((await create(actor.adminA, { id })).rows[0].id).toBe(id);
    await expect(create(actor.adminA, { id, reason: "Different request payload" })).rejects.toMatchObject({ code: "23505" });
    await expect(create()).rejects.toMatchObject({ code: "23505" });
    await expect(create(actor.principalA, { id })).rejects.toMatchObject({ code: "23505" });
    const audit = (await db.query<{ created_by: string; reason: string }>("select created_by,reason from app_private.substitute_attendance_coverages where id=$1", [id])).rows[0];
    expect(audit).toEqual({ created_by: actor.adminA, reason: "Cover the absent class teacher" });
  });

  it("reads only the covered roster/date window, saves today, and keeps permanent assignment and old marks intact", async () => {
    const oldMarks = (await marks(actor.teacherA)).rows;
    expect(await assignments()).toEqual([]);
    const id = (await create()).rows[0].id;
    expect(await assignments()).toEqual([expect.objectContaining({ id: A.assignment, teacher_id: substitute, coverage_id: id, starts_on: today, ends_on: tomorrow })]);
    expect(await assignments(actor.teacherA)).toEqual([expect.objectContaining({ id: A.assignment, coverage_id: null })]);
    expect((await roster()).rows).toEqual([{ id: A.student }]);
    await expect(roster(actor.outsider, yesterday)).rejects.toMatchObject({ code: "42501" });
    expect((await marks()).rows).toEqual([]);
    expect((await asStaffActor(db, actor.outsider, "select id from public.students order by id")).rows).toEqual([{ id: A.student }]);
    expect((await asStaffActor(db, actor.outsider, "select id from public.enrollments order by id")).rows).toEqual([{ id: A.enrollment }]);
    expect((await asStaffActor(db, actor.outsider, "select id from public.teacher_subject_assignments")).rows).toEqual([]);
    for (const table of ["class_logs", "class_activities", "student_fees", "fee_payments", "study_materials"]) {
      expect((await asStaffActor(db, actor.outsider, `select * from public.${table}`)).rows).toEqual([]);
    }
    const saved = (await mark()).rows[0];
    expect(saved).toMatchObject({ status: "present", revision: 0 });
    expect((await marks()).rows).toEqual([{ student_id: A.student, attendance_date: today, status: "present", revision: 0 }]);
    const changed = await asStaffActor(db, actor.outsider, "update public.attendance set status='late',marked_by=$1 where id=$2 returning revision", [actor.outsider, saved.id]);
    expect(changed.rows).toEqual([{ revision: 1 }]);
    expect((await marks(actor.teacherA)).rows).toEqual([
      ...oldMarks,
      { student_id: A.student, attendance_date: today, status: "late", revision: 1 },
    ]);
    await expect(mark(actor.outsider, STAFF_ROWS.privateStudentA, STAFF_ROWS.privateSectionA)).rejects.toMatchObject({ code: "42501" });
    expect((await db.query("select teacher_id,is_class_teacher from public.teacher_subject_assignments where id=$1", [A.assignment])).rows)
      .toEqual([{ teacher_id: A.teacher, is_class_teacher: true }]);
  });

  it("revokes immediately without deleting history or changing original teacher rights; repeat revokes retain audit", async () => {
    const id = (await create()).rows[0].id;
    await mark();
    expect((await revoke(id)).rows[0].revoked).toBe(true);
    const firstAudit = (await db.query("select revoked_by,revoked_at,revoke_reason from app_private.substitute_attendance_coverages where id=$1", [id])).rows;
    expect((await revoke(id, actor.adminA, "Repeat revoke should not overwrite")).rows[0].revoked).toBe(false);
    expect((await db.query("select revoked_by,revoked_at,revoke_reason from app_private.substitute_attendance_coverages where id=$1", [id])).rows).toEqual(firstAudit);
    expect(await assignments()).toEqual([]);
    expect((await marks()).rows).toEqual([]);
    expect((await asStaffActor(db, actor.outsider, "select id from public.students")).rows).toEqual([]);
    await expect(roster()).rejects.toMatchObject({ code: "42501" });
    expect((await marks(actor.teacherA)).rows).toHaveLength(2);
    expect((await asStaffActor(db, actor.outsider, "update public.attendance set status='absent',marked_by=$1 where student_id=$2 returning id", [actor.outsider, A.student])).rows).toEqual([]);
    const replacement = (await create(actor.principalA)).rows[0].id;
    expect(replacement).not.toBe(id);
    expect(await assignments()).toEqual([expect.objectContaining({ coverage_id: replacement })]);
  });

  it("fails closed for scheduled, expired, inactive-identity and changed-source coverage", async () => {
    const id = (await create()).rows[0].id;
    await db.query("update app_private.substitute_attendance_coverages set starts_on=$2,ends_on=$2 where id=$1", [id, tomorrow]);
    expect(await assignments()).toEqual([]);
    await expect(roster()).rejects.toMatchObject({ code: "42501" });
    await db.query("update app_private.substitute_attendance_coverages set starts_on=$2,ends_on=$2 where id=$1", [id, yesterday]);
    expect(await assignments()).toEqual([]);
    await expect(mark()).rejects.toMatchObject({ code: "42501" });
    await db.query("update app_private.substitute_attendance_coverages set starts_on=$2,ends_on=$3 where id=$1", [id, today, tomorrow]);
    await db.query("update public.profiles set is_active=false where id=$1", [actor.outsider]);
    expect(await assignments()).toEqual([]);
    await db.query("update public.profiles set is_active=true where id=$1", [actor.outsider]);
    await db.query("update public.teacher_subject_assignments set is_class_teacher=false where id=$1", [A.assignment]);
    expect(await assignments()).toEqual([]);
    await expect(roster()).rejects.toMatchObject({ code: "42501" });
    const setup = (await asStaffActor<{ setup: { coverages: { id: string; status: string }[] } }>(db, actor.adminA, setupSql, [actor.schoolA])).rows[0].setup;
    expect(setup.coverages).toEqual([expect.objectContaining({ id, status: "invalid" })]);
  });

  it("locks coverage in the authenticated write guard even if a permissive policy authorizes a stale row", async () => {
    const id = (await create()).rows[0].id;
    await revoke(id);
    // A broad policy simulates authorization already evaluated before revocation.
    // The separate locking guard must still reject the authenticated save.
    await db.exec("create policy qa_stale_authorization on public.attendance for all to authenticated using(true) with check(true)");
    try {
      await expect(mark()).rejects.toMatchObject({ code: "42501", message: "Substitute attendance coverage is unavailable for this date and class." });
    } finally { await db.exec("drop policy qa_stale_authorization on public.attendance"); }
    expect((await db.query("select id from public.attendance where attendance_date=$1", [today])).rows).toEqual([]);
  });

  it("keeps active and invalid assignments manageable beyond the bounded historical page", async () => {
    const id = (await create()).rows[0].id;
    await db.query(`insert into app_private.substitute_attendance_coverages
      (id,school_id,source_assignment_id,source_teacher_id,substitute_teacher_id,academic_year_id,class_id,section_id,subject_id,
        starts_on,ends_on,reason,created_by,created_at,revoked_at,revoked_by,revoke_reason)
      select gen_random_uuid(),school_id,source_assignment_id,source_teacher_id,substitute_teacher_id,academic_year_id,class_id,section_id,subject_id,
        starts_on,ends_on,reason,created_by,clock_timestamp()+n*interval '1 second',clock_timestamp(),created_by,'QA historical revocation'
      from app_private.substitute_attendance_coverages cross join generate_series(1,105) n where id=$1`, [id]);
    const setup = (await asStaffActor<{ setup: { coverages: { id: string; status: string }[] } }>(db, actor.adminA, setupSql, [actor.schoolA])).rows[0].setup;
    expect(setup.coverages).toHaveLength(101);
    expect(setup.coverages).toContainEqual(expect.objectContaining({ id, status: "active" }));
    await db.query("update public.teacher_subject_assignments set is_class_teacher=false where id=$1", [A.assignment]);
    const invalidSetup = (await asStaffActor<{ setup: { coverages: { id: string; status: string }[] } }>(db, actor.adminA, setupSql, [actor.schoolA])).rows[0].setup;
    expect(invalidSetup.coverages).toContainEqual(expect.objectContaining({ id, status: "invalid" }));
    expect((await revoke(id)).rows[0].revoked).toBe(true);
  });

  it("does not move temporary authority when the source section changes or the original assignment is removed", async () => {
    await create();
    await db.query("update public.teacher_subject_assignments set class_id=$2,section_id=$3 where id=$1", [A.assignment, STAFF_ROWS.privateClassA, STAFF_ROWS.privateSectionA]);
    try {
      expect(await assignments()).toEqual([]);
      await expect(roster()).rejects.toMatchObject({ code: "42501" });
      expect((await asStaffActor(db, actor.outsider, "select id from public.students")).rows).toEqual([]);
    } finally {
      await db.query("update public.teacher_subject_assignments set class_id=$2,section_id=$3 where id=$1", [A.assignment, A.class, A.section]);
    }
    await db.query("delete from public.teacher_subject_assignments where id=$1", [A.assignment]);
    try {
      expect(await assignments()).toEqual([]);
      await expect(roster()).rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.query("insert into public.teacher_subject_assignments(id,teacher_id,academic_year_id,class_id,section_id,subject_id,is_class_teacher) values($1,$2,$3,$4,$5,$6,true)",
        [A.assignment, A.teacher, A.year, A.class, A.section, A.subject]);
    }
  });

  it("does not grant substitutes historical corrections even when the old day is inside their active window", async () => {
    const id = (await create()).rows[0].id;
    await db.query("update app_private.substitute_attendance_coverages set starts_on=$2 where id=$1", [id, yesterday]);
    expect((await roster(actor.outsider, yesterday)).rows).toEqual([{ id: A.student }]);
    const previous = (await db.query<{ id: string; revision: number }>("select id,revision from public.attendance where student_id=$1 and attendance_date=$2", [A.student, yesterday])).rows[0];
    await expect(asStaffActor(db, actor.outsider, "select public.request_attendance_correction($1,$2,$3,$4,$5,$6,$7,'late','Verify late arrival',$8)",
      [actor.schoolA, A.year, A.section, A.student, yesterday, previous.id, previous.revision, randomUUID()])).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, actor.outsider, "update public.attendance set status='late',marked_by=$1 where id=$2", [actor.outsider, previous.id])).rejects.toMatchObject({ code: "42501" });
    expect((await asStaffActor(db, actor.teacherA, "select public.request_attendance_correction($1,$2,$3,$4,$5,$6,$7,'late','Verify late arrival',$8) as id",
      [actor.schoolA, A.year, A.section, A.student, yesterday, previous.id, previous.revision, randomUUID()])).rows[0].id).toEqual(expect.any(String));
  });
});
