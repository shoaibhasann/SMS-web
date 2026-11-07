// @vitest-environment node
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite, today: string, start: string, dates: string[];
type Period = { from: string | null; to: string | null; state: string; enrollment_days: number; working_days: number; closed_days: number;
  unconfigured_days: number; marked_days: number; unmarked_days: number; invalid_days: number; present_days: number; late_days: number;
  half_days: number; leave_days: number; absent_days: number; earned_days: number; percentage: number | null };
type Summary = { user_id: string; student_id: string; school_id: string; role: string; server_today: string; timezone: string; month: string;
  calendar_revision: number; formula: string; session_state: string; year: { id: string; name: string; start_date: string; end_date: string } | null;
  month_summary: Period | null; year_summary: Period | null };
async function actor<T>(user: string | null, sql: string, args: unknown[] = [], options: { role?: string; session?: string; aal?: string } = {}) {
  await db.exec("savepoint rate_actor");
  try {
    await db.exec(`set local role ${options.role ?? "authenticated"}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [user ?? "", JSON.stringify({ sub: user, session_id: options.session ?? user, aal: options.aal ?? "aal1", role: options.role ?? "authenticated" })]);
    const result = await db.query<{ value: T }>(sql, args);
    await db.exec("reset role;release savepoint rate_actor");
    await db.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true)");
    return result.rows[0]?.value;
  } catch (error) { await db.exec("rollback to savepoint rate_actor;release savepoint rate_actor"); throw error; }
}
const summary = (user = id.guardianA, role = "parent", pupil = id.pupilA, month: string | null = null, options = {}) =>
  actor<Summary>(user, "select public.get_family_attendance_summary($1,$2,$3) as value", [role, pupil, month], options);
const denied = (promise: Promise<unknown>, code = "42501") => expect(promise).rejects.toMatchObject({ code });
async function policy(from = start, days = [0, 1, 2, 3, 4, 5, 6], revision = 1) {
  await db.query(`insert into app_private.school_attendance_policy_versions(school_id,revision,effective_from,working_days,correction_window_days,reason,actor_id,request_id)
    values($1,$2,$3,$4,2,'Trusted historical fixture',$5,$6)`, [id.schoolA, revision, from, days, id.adminA, randomUUID()]);
}
async function mark(day: string, status: string, section = id.sectionA, year = id.yearA) {
  await db.query(`insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status)
    values($1,$2,$3,$4,$5,$6)`, [id.schoolA, year, section, id.pupilA, day, status]);
}
async function holiday(day: string, mode = "holiday", revision = 2) {
  await db.query(`insert into app_private.school_attendance_day_exceptions(school_id,revision,day,mode,label,reason,actor_id,request_id)
    values($1,$2,$3,$4,$5,'Trusted dated fixture',$6,$7)`, [id.schoolA, revision, day, mode, mode === "inherit" ? null : "QA school day", id.adminA, randomUUID()]);
}
async function completeMarks() {
  for (const [index, status] of ["present", "late", "half_day", "present", "leave", "absent", "present"].entries()) await mark(dates[index], status);
}
beforeAll(async () => {
  db = await createRecoveryDatabase(); await seedRecoveryData(db);
  if (!(await db.query<{ exists: string | null }>("select to_regprocedure('public.get_family_attendance_summary(text,uuid,date)') as exists")).rows[0].exists) {
    await db.exec(await readFile(new URL("../../supabase/migrations/20261107114728_family_official_attendance_summary.sql", import.meta.url), "utf8"));
  }
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
  const clock = (await db.query<{ today: string; start: string; dates: string[] }>(`select (now() at time zone 'Asia/Kolkata')::date::text as today,
    ((now() at time zone 'Asia/Kolkata')::date-6)::text as start,
    array(select ((now() at time zone 'Asia/Kolkata')::date-6+day)::text from generate_series(0,6) day) as dates`)).rows[0];
  ({ today, start, dates } = clock);
  await db.query("update public.academic_years set start_date=$1,end_date=$2::date+30", [start, today]);
  await db.query("update public.students set admission_date=$1", [start]);
  await db.query("update public.attendance set attendance_date=$1::date-2", [start]);
}, 60_000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

describe("official daily attendance formula and reporting periods", () => {
  it("uses the entire working-day denominator, half-day credit, zero leave credit and retained holiday exclusion", async () => {
    await policy(); await holiday(dates[3]); await completeMarks();
    const parent = await summary(), student = await summary(id.studentUserA, "student");
    expect(parent).toMatchObject({ user_id: id.guardianA, student_id: id.pupilA, school_id: id.schoolA, role: "parent", server_today: today,
      timezone: "Asia/Kolkata", calendar_revision: 2, formula: "daily-v1", session_state: "active", year: { id: id.yearA } });
    expect(parent.year_summary).toMatchObject({ from: start, to: today, state: "complete", enrollment_days: 7, working_days: 6, closed_days: 1,
      unconfigured_days: 0, marked_days: 6, unmarked_days: 0, invalid_days: 0, present_days: 2, late_days: 1, half_days: 1,
      leave_days: 1, absent_days: 1, earned_days: 3.5, percentage: 58.33 });
    expect(student.year_summary).toEqual(parent.year_summary);
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.attendance where student_id=$1", [id.pupilA])).rows[0].n).toBe(8);
  });
  it("keeps unmarked working days pending instead of treating missing scans as Absent or hiding them from the denominator", async () => {
    await policy(); await mark(today, "present");
    expect((await summary()).year_summary).toMatchObject({ state: "attendance_incomplete", working_days: 7, marked_days: 1,
      unmarked_days: 6, absent_days: 0, earned_days: 1, percentage: null });
  });
  it("withholds an official percentage when any eligible historical day has no approved calendar", async () => {
    await policy(today); await completeMarks();
    expect((await summary()).year_summary).toMatchObject({ state: "calendar_unconfigured", unconfigured_days: 6, working_days: 1, percentage: null });
  });
  it("returns no working-day rate for an entirely closed enrolled period", async () => {
    const unrelatedWeekday = (Number((await db.query<{ dow: number }>("select extract(dow from $1::date)::int as dow", [today])).rows[0].dow) + 1) % 7;
    await db.query("update public.students set admission_date=$1 where id=$2", [today, id.pupilA]); await policy(start, [unrelatedWeekday]);
    expect((await summary()).year_summary).toMatchObject({ state: "no_working_days", enrollment_days: 1, closed_days: 1, working_days: 0, percentage: null });
  });
  it("uses a working override and latest inherited decision rather than a historical 50-row sample", async () => {
    await policy(); await holiday(today); await holiday(today, "inherit", 3); await completeMarks();
    expect((await summary()).year_summary).toMatchObject({ state: "complete", working_days: 7, earned_days: 4.5, percentage: 64.29 });
    for (let revision = 4; revision < 60; revision++) await policy(dates[6], [0, 1, 2, 3, 4, 5, 6], revision);
    expect((await summary()).year_summary?.working_days).toBe(7);
  });
  it("clamps month and session totals to admission and today, ignoring future marks", async () => {
    await policy(); await db.query("update public.students set admission_date=$1 where id=$2", [dates[5], id.pupilA]);
    await mark(dates[5], "absent"); await mark(today, "present");
    await mark((await db.query<{ value: string }>("select ($1::date+1)::text as value", [today])).rows[0].value, "present");
    expect((await summary()).year_summary).toMatchObject({ from: dates[5], to: today, enrollment_days: 2, working_days: 2, percentage: 50 });
  });
  it("does not use later import timestamps to move a known admission date", async () => {
    await policy(); await completeMarks(); await db.query("update public.enrollments set enrolled_at=now() where student_id=$1", [id.pupilA]);
    expect((await summary()).year_summary?.enrollment_days).toBe(7);
  });
  it("returns independent month totals across the session boundary without a 60-row history limit", async () => {
    const previousMonth = (await db.query<{ value: string }>("select (date_trunc('month',$1::date)-interval '3 months')::date::text as value", [today])).rows[0].value;
    await db.query("update public.attendance set attendance_date=$1::date-1 where id=$2", [previousMonth, id.attendanceA]);
    await db.query("update public.academic_years set start_date=$1 where id=$2", [previousMonth, id.yearA]);
    await db.query("update public.students set admission_date=$1 where id=$2", [previousMonth, id.pupilA]);
    await policy(previousMonth); await db.query(`insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status)
      select $1,$2,$3,$4,$5::date+day,'present' from generate_series(0,$6::date-$5::date) day
      where not exists(select 1 from public.attendance a where a.student_id=$4 and a.attendance_date=$5::date+day)`, [id.schoolA, id.yearA, id.sectionA, id.pupilA, previousMonth, today]);
    const data = await summary(id.guardianA, "parent", id.pupilA, previousMonth);
    expect(data.month_summary).toMatchObject({ state: "complete", percentage: 100, from: previousMonth });
    expect(data.year_summary?.enrollment_days).toBeGreaterThan(60);
  });
  it.each(["2026-11-02", "infinity", "0001-01-01"])("rejects invalid/out-of-session requested month %s", async month => {
    await denied(summary(id.guardianA, "parent", id.pupilA, month), "22023");
  });
});

describe("enrollment and retained data consistency", () => {
  it("withholds rates for unknown admission instead of guessing from ingestion time", async () => {
    await policy(); await db.query("update public.students set admission_date=null where id=$1", [id.pupilA]);
    expect((await summary()).year_summary).toMatchObject({ state: "enrollment_unverified", from: null, to: null, enrollment_days: 0, percentage: null });
  });
  it("returns a truthful no-enrollment state", async () => {
    await db.query("delete from public.enrollments where student_id=$1", [id.pupilA]);
    expect((await summary()).year_summary).toMatchObject({ state: "not_enrolled", enrollment_days: 0, percentage: null });
  });
  it.each([
    { label: "single coherent promotion", amended: false, conflictingDate: false },
    { label: "two coherent staging amendments on the same date", amended: true, conflictingDate: false },
    { label: "conflicting promotion dates", amended: true, conflictingDate: true },
  ])("reconciles $label without guessing enrollment dates", async ({ amended, conflictingDate }) => {
    const oldYear = randomUUID();
    await db.query("insert into public.academic_years(id,school_id,name,start_date,end_date) values($1,$2,'Earlier year',$3::date-365,$3::date-1)", [oldYear, id.schoolA, start]);
    const source = (await db.query<{ id: string }>("insert into public.enrollments(student_id,academic_year_id,class_id,section_id) values($1,$2,$3,$4) returning id", [id.pupilA, oldYear, id.classA, id.sectionA])).rows[0];
    const destination = (await db.query<{ id: string }>("select id from public.enrollments where student_id=$1 and academic_year_id=$2", [id.pupilA, id.yearA])).rows[0];
    const stagedClass = randomUUID(), stagedSection = randomUUID();
    if (amended) {
      await db.query("insert into public.classes(id,school_id,name) values($1,$2,'First staged class')", [stagedClass, id.schoolA]);
      await db.query("insert into public.sections(id,school_id,class_id,name) values($1,$2,$3,'First staged section')", [stagedSection, id.schoolA, stagedClass]);
    }
    for (const index of amended ? [0, 1] : [1]) {
      await db.query(`insert into app_private.roster_placement_changes(school_id,request_id,student_id,source_enrollment_id,source_year_id,source_class_id,source_section_id,
        destination_enrollment_id,destination_year_id,destination_class_id,destination_section_id,change_kind,effective_date,reason,changed_by)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'promotion',$12,'Trusted promotion fixture',$13)`, [id.schoolA, randomUUID(), id.pupilA, source.id, oldYear,
        id.classA, id.sectionA, destination.id, id.yearA, index === 0 ? stagedClass : id.classA, index === 0 ? stagedSection : id.sectionA,
        conflictingDate && index === 0 ? dates[5] : today, id.adminA]);
    }
    await db.query("update public.students set admission_date=null where id=$1", [id.pupilA]); await policy(); await mark(today, "present");
    expect((await summary()).year_summary).toMatchObject(conflictingDate
      ? { state: "enrollment_unverified", from: null, to: null, working_days: 0, percentage: null }
      : { state: "complete", from: today, to: today, working_days: 1, percentage: 100 });
  });
  it("includes the verified withdrawal day but excludes later school days", async () => {
    await policy(); await completeMarks();
    await db.query(`insert into app_private.enrollment_withdrawals(enrollment_id,student_id,school_id,academic_year_id,class_id,section_id,reason,withdrawn_by,withdrawn_at)
      select id,student_id,$1,academic_year_id,class_id,section_id,'Verified fixture withdrawal',$2,$3::date+time '12:00' at time zone 'Asia/Kolkata'
      from public.enrollments where student_id=$4 and academic_year_id=$5`, [id.schoolA, id.adminA, dates[2], id.pupilA, id.yearA]);
    await db.query("update public.enrollments set status='withdrawn' where student_id=$1 and academic_year_id=$2", [id.pupilA, id.yearA]);
    expect((await summary()).year_summary).toMatchObject({ state: "complete", from: start, to: dates[2], working_days: 3, earned_days: 2.5, percentage: 83.33 });
  });
  it("withholds an active enrollment with a retained past withdrawal instead of guessing re-admission intervals", async () => {
    await db.query(`insert into app_private.enrollment_withdrawals(enrollment_id,student_id,school_id,academic_year_id,class_id,section_id,reason,withdrawn_by,withdrawn_at)
      select id,student_id,$1,academic_year_id,class_id,section_id,'Retained withdrawal fixture',$2,now() from public.enrollments where student_id=$3 and academic_year_id=$4`,
      [id.schoolA, id.adminA, id.pupilA, id.yearA]);
    expect((await summary()).year_summary).toMatchObject({ state: "enrollment_unverified", enrollment_days: 0, percentage: null });
  });
  it("returns not-started for future admission without manufacturing zero attendance", async () => {
    await db.query("update public.students set admission_date=$1::date+1 where id=$2", [today, id.pupilA]);
    expect((await summary()).year_summary).toMatchObject({ state: "not_started", from: null, to: null, enrollment_days: 0, percentage: null });
  });
  it("does not reinterpret a pupil Holiday mark as a school calendar exemption", async () => {
    await policy(); await mark(today, "holiday");
    expect((await summary()).year_summary).toMatchObject({ state: "inconsistent", invalid_days: 1, working_days: 7, unmarked_days: 6, percentage: null });
  });
  it("rejects a working-day mark attributed to a different academic year", async () => {
    await policy(); await mark(today, "present", id.sectionA, id.yearB);
    expect((await summary()).year_summary).toMatchObject({ state: "inconsistent", invalid_days: 1, percentage: null });
  });
  it("validates retained marks against their historical section through a transfer", async () => {
    const newSection = randomUUID();
    await db.query("insert into public.sections(id,school_id,class_id,name) values($1,$2,$3,'Moved section')", [newSection, id.schoolA, id.classA]);
    const enrollment = (await db.query<{ id: string }>("select id from public.enrollments where student_id=$1 and academic_year_id=$2", [id.pupilA, id.yearA])).rows[0];
    await db.query(`insert into app_private.roster_placement_changes(school_id,request_id,student_id,source_enrollment_id,source_year_id,source_class_id,source_section_id,
      destination_enrollment_id,destination_year_id,destination_class_id,destination_section_id,change_kind,effective_date,reason,changed_by)
      values($1,$2,$3,$4,$5,$6,$7,$4,$5,$6,$8,'move',$9,'Trusted transfer fixture',$10)`, [id.schoolA, randomUUID(), id.pupilA, enrollment.id, id.yearA, id.classA, id.sectionA, newSection, dates[4], id.adminA]);
    await db.query("update public.enrollments set section_id=$1 where id=$2", [newSection, enrollment.id]); await policy();
    for (let i = 0; i < dates.length; i++) await mark(dates[i], "present", i < 4 ? id.sectionA : newSection);
    expect((await summary()).year_summary).toMatchObject({ state: "complete", working_days: 7, percentage: 100 });
    await db.query("update public.attendance set section_id=$1 where student_id=$2 and attendance_date=$3", [newSection, id.pupilA, dates[0]]);
    expect((await summary()).year_summary).toMatchObject({ state: "inconsistent", invalid_days: 1, percentage: null });
  });
  it("has no school, attendance, finance, link or calendar mutations on successful or failed reads", async () => {
    await policy(); await completeMarks();
    const capture = async () => (await db.query(`select (select jsonb_agg(to_jsonb(a) order by id) from public.attendance a) as attendance,
      (select jsonb_agg(to_jsonb(f) order by id) from public.student_fees f) as fees,
      (select jsonb_agg(to_jsonb(l) order by student_id,parent_id) from public.student_parents l) as links,
      (select jsonb_agg(to_jsonb(p) order by school_id,revision) from app_private.school_attendance_policy_versions p) as calendar`)).rows;
    const before = await capture(); await summary(); await denied(summary(id.guardianA, "parent", id.pupilB)); expect(await capture()).toEqual(before);
  });
});

describe("family authorization and academic-year boundaries", () => {
  it.each([[id.studentUserA, "student", id.unlinkedPupilA], [id.guardianA, "parent", id.unlinkedPupilA], [id.guardianA, "parent", id.pupilB],
    [id.studentUserB, "student", id.pupilA], [id.teacherA, "student", id.pupilA], [id.adminA, "parent", id.pupilA]])("denies non-own/unlinked/wrong-role %s", async (user, role, pupil) => {
    await denied(summary(user, role, pupil));
  });
  it("denies revoked links, removed roles, inactive or foreign school profiles", async () => {
    await db.query("delete from public.student_parents where parent_id=$1", [id.parentA]); await denied(summary());
    await db.query("update public.profiles set is_active=false where id=$1", [id.studentUserA]); await denied(summary(id.studentUserA, "student"));
  });
  it("denies missing, foreign and revoked native sessions", async () => {
    await denied(summary(id.guardianA, "parent", id.pupilA, null, { session: randomUUID() }));
    await denied(summary(id.guardianA, "parent", id.pupilA, null, { session: id.studentUserA }));
    await db.query("delete from auth.sessions where user_id=$1", [id.guardianA]); await denied(summary());
  });
  it("requires actual native MFA when an authenticator exists, regardless of spoofed AAL2 claims", async () => {
    const factor = randomUUID(); await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status) values($1,$2,'totp','verified')", [factor, id.guardianA]);
    await denied(summary()); await denied(summary(id.guardianA, "parent", id.pupilA, null, { aal: "aal2" }));
    await db.query("update auth.sessions set aal='aal2',factor_id=$2 where user_id=$1", [id.guardianA, factor]);
    expect((await summary(id.guardianA, "parent", id.pupilA, null, { aal: "aal2" })).user_id).toBe(id.guardianA);
  });
  it("denies inactive school and anonymous/service-role callers", async () => {
    await db.query("update public.schools set is_active=false where id=$1", [id.schoolA]); await denied(summary());
    await denied(actor(null, "select public.get_family_attendance_summary('student',$1,null) as value", [id.pupilA], { role: "anon" }));
    await denied(actor(id.studentUserA, "select public.get_family_attendance_summary('student',$1,null) as value", [id.pupilA], { role: "service_role" }));
  });
  it("reports missing current year without inventing an attendance denominator", async () => {
    await db.query("update public.academic_years set is_current=false where id=$1", [id.yearA]);
    expect(await summary()).toMatchObject({ session_state: "missing", year: null, month_summary: null, year_summary: null });
  });
  it("reports ambiguous current-year corruption without choosing one session", async () => {
    await db.exec("drop index public.academic_years_one_current_per_school");
    await db.query("insert into public.academic_years(school_id,name,start_date,end_date,is_current) values($1,'Ambiguous fixture',$2,$3,true)", [id.schoolA, start, today]);
    expect(await summary()).toMatchObject({ session_state: "ambiguous", year: null, month_summary: null, year_summary: null });
  });
  it("accepts 366 inclusive days, bounds an ended session and clamps the default to its final month", async () => {
    await db.query("update public.academic_years set start_date='2024-01-01',end_date='2024-12-31' where id=$1", [id.yearA]);
    const ended = await summary(); expect(ended).toMatchObject({ session_state: "active", month: "2024-12-01" });
    expect(ended.year_summary).toMatchObject({ state: "not_started", enrollment_days: 0, percentage: null });
    await db.query("update public.academic_years set end_date='2025-01-01' where id=$1", [id.yearA]);
    expect((await summary()).session_state).toBe("unsupported");
  });
  it("clamps default months forward for a future session while counting no future days", async () => {
    await db.query("update public.academic_years set start_date=$1::date+60,end_date=$1::date+120 where id=$2", [today, id.yearA]);
    const data = await summary(); expect(data.session_state).toBe("active");
    expect(data.month).toBe(data.year?.start_date.slice(0, 7) + "-01");
    expect(data.year_summary).toMatchObject({ state: "not_started", from: null, to: null, enrollment_days: 0, percentage: null });
  });
  it("withholds unbounded or invalid years and defaults to the nearest allowed month", async () => {
    await db.query("update public.academic_years set start_date=$1::date-400 where id=$2", [today, id.yearA]);
    expect(await summary()).toMatchObject({ session_state: "unsupported", month_summary: null, year_summary: null });
    await db.query("update public.academic_years set start_date='infinity',end_date='infinity' where id=$1", [id.yearA]);
    expect(await summary()).toMatchObject({ session_state: "unsupported", year: null });
  });
  it("keeps the public RPC invoker-only and all execution grants scoped", async () => {
    expect((await db.query(`select p.prosecdef as definer,p.provolatile,
      has_function_privilege('authenticated',p.oid,'EXECUTE') as browser,has_function_privilege('anon',p.oid,'EXECUTE') as anonymous,
      has_function_privilege('service_role',p.oid,'EXECUTE') as server from pg_proc p
      where p.oid='public.get_family_attendance_summary(text,uuid,date)'::regprocedure`)).rows)
      .toEqual([{ definer: false, provolatile: "v", browser: true, anonymous: false, server: false }]);
  });
});
