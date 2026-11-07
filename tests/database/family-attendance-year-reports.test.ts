// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite, today: string, currentStart: string, oldStart: string, oldEnd: string, days: string[], oldMonth: string;
const oldYear = randomUUID(), oldEnrollment = randomUUID();
type Period = { state: string; from: string | null; to: string | null; enrollment_days: number; working_days: number; closed_days: number;
  unconfigured_days: number; unmarked_days: number; invalid_days: number; earned_days: number; percentage: number | null };
type Summary = { year: { id: string; start_date: string; end_date: string } | null; month: string; session_state: string; year_summary: Period | null; month_summary: Period | null };
type Context = { user_id: string; student_id: string; school_id: string; current_year_id: string | null; current_session_state: string;
  years: { id: string; name: string; is_current: boolean }[] };
async function actor<T>(user: string | null, sql: string, args: unknown[] = [], options: { role?: "authenticated" | "anon" | "service_role"; aal?: string; session?: string } = {}) {
  await db.exec("savepoint family_year_actor");
  try {
    await db.exec(`set local role ${options.role ?? "authenticated"}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [user ?? "", JSON.stringify({ sub: user, session_id: options.session ?? user, aal: options.aal ?? "aal1", role: options.role ?? "authenticated" })]);
    const result = await db.query<{ value: T }>(sql, args);
    await db.exec("reset role;release savepoint family_year_actor");
    await db.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true)");
    return result.rows[0]?.value;
  } catch (error) { await db.exec("rollback to savepoint family_year_actor;release savepoint family_year_actor"); throw error; }
}
const denied = (promise: Promise<unknown>, code = "42501") => expect(promise).rejects.toMatchObject({ code });
const report = (year: string | null = oldYear, month: string | null = null, user = id.guardianA, role = "parent", pupil = id.pupilA, options = {}) =>
  actor<Summary>(user, "select public.get_family_attendance_report($1,$2,$3,$4) as value", [role, pupil, year, month], options);
const legacy = (month: string | null = null) => actor<Summary>(id.guardianA, "select public.get_family_attendance_summary('parent',$1,$2) as value", [id.pupilA, month]);
const context = (user = id.guardianA, role = "parent", pupil = id.pupilA, options = {}) => actor<Context>(user,
  "select public.get_family_attendance_report_context($1,$2) as value", [role, pupil], options);
async function policy() {
  await db.query(`insert into app_private.school_attendance_policy_versions(school_id,revision,effective_from,working_days,correction_window_days,reason,actor_id,request_id)
    values($1,1,$2,array[0,1,2,3,4,5,6],2,'Verified historical school calendar',$3,$4)`, [id.schoolA, oldStart, id.adminA, randomUUID()]);
}
async function mark(day: string, status: string, section = id.sectionA, year: string = oldYear) {
  await db.query("insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status) values($1,$2,$3,$4,$5,$6)",
    [id.schoolA, year, section, id.pupilA, day, status]);
}
async function complete(statuses = ["present", "late", "half_day", "present", "leave", "absent", "present"]) {
  for (const [index, status] of statuses.entries()) await mark(days[index], status);
}
async function withdrawal(enrollment: string, year: string, when: string) {
  await db.query("update public.enrollments set status='withdrawn' where id=$1", [enrollment]);
  await db.query(`insert into app_private.enrollment_withdrawals(enrollment_id,student_id,school_id,academic_year_id,class_id,section_id,reason,withdrawn_by,withdrawn_at)
    values($1,$2,$3,$4,$5,$6,'Verified school withdrawal evidence',$7,$8::date::timestamp at time zone 'Asia/Kolkata')`,
    [enrollment, id.pupilA, id.schoolA, year, id.classA, id.sectionA, id.adminA, when]);
}
const snapshot = async () => (await db.query(`select (select jsonb_agg(to_jsonb(a) order by id) from public.attendance a) as marks,
 (select jsonb_agg(to_jsonb(f) order by id) from public.student_fees f) as fees,
 (select jsonb_agg(to_jsonb(e) order by id) from public.enrollments e) as enrollments,
 (select jsonb_agg(to_jsonb(l) order by student_id,parent_id) from public.student_parents l) as links,
 (select jsonb_agg(to_jsonb(h) order by school_id,day) from app_private.school_attendance_historical_days h) as historical_calendar`)).rows;
beforeAll(async () => {
  db = await createRecoveryDatabase(); await seedRecoveryData(db);
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
  const factor = randomUUID();
  await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status) values($1,$2,'totp','verified')", [factor, id.adminA]);
  await db.query("update auth.sessions set aal='aal2',factor_id=$1 where user_id=$2", [factor, id.adminA]);
  const clock = (await db.query<{ today: string; current_start: string; old_start: string; old_end: string; old_month: string; days: string[] }>(`select d::text as today,(d-6)::text as current_start,
    (d-16)::text as old_start,(d-10)::text as old_end,date_trunc('month',d-10)::date::text as old_month,
    array(select (d-16+n)::text from generate_series(0,6) n) as days from(select(now() at time zone 'Asia/Kolkata')::date as d) clock`)).rows[0];
  ({ today, current_start: currentStart, old_start: oldStart, old_end: oldEnd, old_month: oldMonth, days } = clock);
  await db.query("update public.academic_years set start_date=$1,end_date=$2::date+30", [currentStart, today]);
  await db.query("insert into public.academic_years(id,school_id,name,start_date,end_date) values($1,$2,'Previous verified QA year',$3,$4)", [oldYear, id.schoolA, oldStart, oldEnd]);
  await db.query("insert into public.enrollments(id,student_id,academic_year_id,class_id,section_id) values($1,$2,$3,$4,$5)", [oldEnrollment, id.pupilA, oldYear, id.classA, id.sectionA]);
  await db.query("update public.students set admission_date=$1 where id=$2", [oldStart, id.pupilA]);
  await db.query("update public.attendance set attendance_date=$1::date-2", [oldStart]);
}, 60_000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

describe("previous academic-year selection and compatibility", () => {
  it("keeps the current/mobile 3-argument response identical to the shared null/default and explicit current report", async () => {
    await policy();
    expect(await report(null)).toEqual(await legacy());
    expect(await report(id.yearA)).toEqual(await legacy());
    const value = await context();
    expect(value).toMatchObject({ user_id: id.guardianA, student_id: id.pupilA, school_id: id.schoolA, current_year_id: id.yearA, current_session_state: "active" });
    expect(value.years.map(y => [y.id, y.is_current])).toEqual([[id.yearA, true], [oldYear, false]]);
  });
  it("calculates completed-year official totals from its enrollment, historical calendar and canonical marks", async () => {
    const source = days.map((day, i) => ({ day, status: i === 3 ? "holiday" : "working", label: i === 3 ? "Historical school holiday" : "Historical working day" }));
    const view = await actor<{ revision: number; preview_token: string }>(id.adminA,
      "select public.preview_historical_attendance_calendar($1,$2,$3::jsonb) as value", [id.schoolA, oldYear, JSON.stringify(source)], { aal: "aal2" });
    await actor(id.adminA, "select public.import_historical_attendance_calendar($1,$2,$3::jsonb,$4,$5,true,'Verified old academic calendar',$6) as value",
      [id.schoolA, oldYear, JSON.stringify(source), view.revision, view.preview_token, randomUUID()], { aal: "aal2" });
    await complete(); const before = await snapshot();
    const parent = await report(), student = await report(oldYear, null, id.studentUserA, "student");
    expect(parent).toMatchObject({ year: { id: oldYear }, month: oldMonth, session_state: "active", year_summary: {
      state: "complete", from: oldStart, to: oldEnd, enrollment_days: 7, working_days: 6, closed_days: 1, earned_days: 3.5, percentage: 58.33 } });
    expect(student.year_summary).toEqual(parent.year_summary); expect(student.month_summary).toEqual(parent.month_summary);
    expect(await snapshot()).toEqual(before);
  });
  it("clamps the default month to the completed year and rejects an out-of-year month without falling back", async () => {
    expect((await report()).month).toBe(oldMonth);
    const outside = (await db.query<{ value: string }>("select(date_trunc('month',$1::date)-interval '1 month')::date::text as value", [oldStart])).rows[0].value;
    await denied(report(oldYear, outside), "22023");
    await denied(report(oldYear, days[0]), "22023");
  });
  it("offers a valid current option without an enrollment and reports not_enrolled for it", async () => {
    await db.query("delete from public.enrollments where student_id=$1 and academic_year_id=$2", [id.pupilA, id.yearA]);
    expect((await context()).years[0].id).toBe(id.yearA);
    expect((await report(id.yearA)).year_summary?.state).toBe("not_enrolled");
  });
  it("keeps past years usable when no current year exists and never auto-selects one", async () => {
    await db.query("update public.academic_years set is_current=false where id=$1", [id.yearA]);
    expect(await context()).toMatchObject({ current_year_id: null, current_session_state: "missing", years: [{ id: oldYear }] });
    expect(await report(null)).toEqual(await legacy()); expect((await report(null)).session_state).toBe("missing");
    expect((await report()).year?.id).toBe(oldYear);
  });
  it("keeps ambiguous and unsupported current states exact while hiding invalid current options", async () => {
    await db.exec("drop index public.academic_years_one_current_per_school");
    await db.query("update public.academic_years set is_current=true where id=$1", [oldYear]);
    expect(await context()).toMatchObject({ current_year_id: null, current_session_state: "ambiguous", years: [] });
    expect(await report(null)).toEqual(await legacy()); await denied(report(id.yearA));
    await db.query("update public.academic_years set is_current=false where id=$1", [oldYear]);
    await db.query("update public.academic_years set end_date=start_date+366 where id=$1", [id.yearA]);
    expect(await context()).toMatchObject({ current_year_id: id.yearA, current_session_state: "unsupported", years: [{ id: oldYear }] });
    expect(await report(null)).toEqual(await legacy()); await denied(report(id.yearA));
  });
  it("preserves future-current not_started for legacy/null but hides and denies explicit future selection", async () => {
    await db.query("update public.academic_years set start_date=$1::date+1,end_date=$1::date+30 where id=$2", [today, id.yearA]);
    expect(await context()).toMatchObject({ current_year_id: id.yearA, current_session_state: "active", years: [{ id: oldYear }] });
    expect(await report(null)).toEqual(await legacy()); expect((await report(null)).year_summary?.state).toBe("not_started");
    await denied(report(id.yearA));
  });
  it("lists only supported child-enrolled completed years and denies future, staged, unrelated, foreign or unknown IDs", async () => {
    const unknown = randomUUID(), unrelated = randomUUID(), staged = randomUUID(), future = randomUUID();
    for (const [year, name, first, last] of [[unrelated, "Other pupil year", oldStart, oldEnd], [staged, "Staged old year", oldStart, oldEnd], [future, "Future pupil year", today, null]]) {
      await db.query("insert into public.academic_years(id,school_id,name,start_date,end_date) values($1,$2,$3,$4,coalesce($5::date,$4::date+30))", [year, id.schoolA, name, first, last]);
    }
    await db.query("insert into public.enrollments(student_id,academic_year_id,class_id,section_id,status) values($1,$2,$3,$4,'staged'),($1,$5,$3,$4,'staged')", [id.pupilA, staged, id.classA, id.sectionA, future]);
    expect((await context()).years.map(y => y.id)).toEqual([id.yearA, oldYear]);
    for (const year of [unknown, unrelated, staged, future, id.yearB]) await denied(report(year));
    await db.query("update public.academic_years set end_date=$1 where id=$2", [today, oldYear]);
    expect((await context()).years.map(y => y.id)).toEqual([id.yearA]); await denied(report());
  });
  it("omits nonfinite and oversized past years without evaluating unsafe date differences", async () => {
    await db.query("update public.academic_years set start_date='-infinity' where id=$1", [oldYear]);
    expect((await context()).years.map(y => y.id)).toEqual([id.yearA]); await denied(report());
    await db.query("update public.academic_years set start_date=$1::date-366,end_date=$1 where id=$2", [oldEnd, oldYear]);
    expect((await context()).years.map(y => y.id)).toEqual([id.yearA]); await denied(report());
  });
});

describe("historical enrollment provenance and truthful rates", () => {
  it("keeps missing calendars, missing marks and inconsistent marks NULL instead of borrowing current-year records", async () => {
    await complete(); expect((await report()).year_summary).toMatchObject({ state: "calendar_unconfigured", percentage: null });
    await policy(); expect((await report()).year_summary).toMatchObject({ state: "complete", percentage: 64.29 });
    await db.query("delete from public.attendance where student_id=$1 and attendance_date=$2", [id.pupilA, days[0]]);
    expect((await report()).year_summary).toMatchObject({ state: "attendance_incomplete", unmarked_days: 1, percentage: null });
    await mark(days[0], "present", id.sectionA, id.yearA);
    expect((await report()).year_summary).toMatchObject({ state: "inconsistent", invalid_days: 1, percentage: null });
  });
  it("uses the archived enrollment's own audited withdrawal cutoff inclusively", async () => {
    await policy(); await complete(Array(7).fill("present")); await withdrawal(oldEnrollment, oldYear, days[2]);
    await db.query("update public.students set status='withdrawn' where id=$1", [id.pupilA]);
    expect((await report()).year_summary).toMatchObject({ state: "complete", from: oldStart, to: days[2], enrollment_days: 3, percentage: 100 });
    await db.query("update app_private.enrollment_withdrawals set section_id=$1 where enrollment_id=$2", [id.sectionB, oldEnrollment]);
    expect((await report()).year_summary).toMatchObject({ state: "enrollment_unverified", percentage: null });
  });
  it("permits a legitimate old active enrollment when a different later enrollment has native withdrawal proof", async () => {
    await policy(); await complete(Array(7).fill("present"));
    const later = (await db.query<{ id: string }>("select id from public.enrollments where student_id=$1 and academic_year_id=$2", [id.pupilA, id.yearA])).rows[0].id;
    await withdrawal(later, id.yearA, today); await db.query("update public.students set status='withdrawn' where id=$1", [id.pupilA]);
    expect((await report()).year_summary).toMatchObject({ state: "complete", to: oldEnd, percentage: 100 });
    expect((await db.query("select status from public.enrollments where id=$1", [oldEnrollment])).rows).toEqual([{ status: "active" }]);
    await db.query("delete from app_private.enrollment_withdrawals where enrollment_id=$1", [later]);
    expect((await report()).year_summary).toMatchObject({ state: "enrollment_unverified", percentage: null });
  });
  it("does not let unsupported current withdrawal flags validate an old active placement", async () => {
    await policy(); await complete(); await db.query("update public.students set status='withdrawn' where id=$1", [id.pupilA]);
    expect((await report()).year_summary).toMatchObject({ state: "enrollment_unverified", percentage: null });
    expect((await legacy()).year_summary).toMatchObject({ state: "enrollment_unverified", percentage: null });
  });
  it("uses dated source sections through an old class transfer, with a wrong historical section kept inconsistent", async () => {
    const nextSection = randomUUID();
    await db.query("insert into public.sections(id,school_id,class_id,name) values($1,$2,$3,'Historical moved section')", [nextSection, id.schoolA, id.classA]);
    await db.query(`insert into app_private.roster_placement_changes(school_id,request_id,student_id,source_enrollment_id,source_year_id,source_class_id,source_section_id,
      destination_enrollment_id,destination_year_id,destination_class_id,destination_section_id,change_kind,effective_date,reason,changed_by)
      values($1,$2,$3,$4,$5,$6,$7,$4,$5,$6,$8,'move',$9,'Verified archived section transfer',$10)`, [id.schoolA, randomUUID(), id.pupilA, oldEnrollment, oldYear, id.classA, id.sectionA, nextSection, days[3], id.adminA]);
    await db.query("update public.enrollments set section_id=$1 where id=$2", [nextSection, oldEnrollment]); await policy();
    for (const [i, day] of days.entries()) await mark(day, "present", i < 3 ? id.sectionA : nextSection);
    expect((await report()).year_summary).toMatchObject({ state: "complete", percentage: 100 });
    await db.query("update public.attendance set section_id=$1 where student_id=$2 and attendance_date=$3", [nextSection, id.pupilA, days[0]]);
    expect((await report()).year_summary).toMatchObject({ state: "inconsistent", invalid_days: 1, percentage: null });
  });
  it("preserves verified promotion start dates and rejects contradictory promotion evidence", async () => {
    const priorYear = randomUUID(), priorEnrollment = randomUUID();
    await db.query("insert into public.academic_years(id,school_id,name,start_date,end_date) values($1,$2,'Earlier provenance year',$3::date-30,$3::date-1)", [priorYear, id.schoolA, oldStart]);
    await db.query("insert into public.enrollments(id,student_id,academic_year_id,class_id,section_id) values($1,$2,$3,$4,$5)", [priorEnrollment, id.pupilA, priorYear, id.classA, id.sectionA]);
    await db.query(`insert into app_private.roster_placement_changes(school_id,request_id,student_id,source_enrollment_id,source_year_id,source_class_id,source_section_id,
      destination_enrollment_id,destination_year_id,destination_class_id,destination_section_id,change_kind,effective_date,reason,changed_by)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$6,$7,'promotion',$10,'Verified archived promotion',$11)`, [id.schoolA, randomUUID(), id.pupilA, priorEnrollment, priorYear, id.classA, id.sectionA, oldEnrollment, oldYear, days[2], id.adminA]);
    await db.query("update public.students set admission_date=null where id=$1", [id.pupilA]); await policy(); await complete(Array(7).fill("present"));
    expect((await report()).year_summary).toMatchObject({ state: "complete", from: days[2], enrollment_days: 5, percentage: 100 });
    await db.query("update app_private.roster_placement_changes set school_id=$1 where destination_enrollment_id=$2", [id.schoolB, oldEnrollment]);
    expect((await report()).year_summary).toMatchObject({ state: "enrollment_unverified", percentage: null });
  });
});

describe("native family authorization and private shared calculation", () => {
  it.each([[id.studentUserA, "student", id.unlinkedPupilA], [id.guardianA, "parent", id.unlinkedPupilA], [id.guardianA, "parent", id.pupilB],
    [id.studentUserB, "student", id.pupilA], [id.teacherA, "student", id.pupilA], [id.adminA, "parent", id.pupilA]])("denies foreign, unlinked and wrong-role callers %s", async (user, role, pupil) => {
    await denied(context(user, role, pupil)); await denied(report(oldYear, null, user, role, pupil));
  });
  it("denies revoked links/roles and stale, foreign or expired native sessions", async () => {
    await denied(report(oldYear, null, id.guardianA, "parent", id.pupilA, { session: randomUUID() }));
    await denied(context(id.guardianA, "parent", id.pupilA, { session: id.adminA }));
    await db.query("update auth.sessions set not_after=clock_timestamp()-interval '1 second' where user_id=$1", [id.guardianA]);
    await denied(context()); await denied(report());
    await db.query("update auth.sessions set not_after=null where user_id=$1", [id.guardianA]);
    await db.query("delete from public.student_parents where student_id=$1", [id.pupilA]);
    await denied(context()); await denied(report());
    await db.query("delete from public.user_roles where user_id=$1", [id.studentUserA]);
    await denied(context(id.studentUserA, "student"));
  });
  it("exposes only invoker wrappers to authenticated callers and keeps unchecked math/authorization helpers private", async () => {
    await denied(actor(id.guardianA, "select app_private.calculate_family_attendance_summary('parent',$1,$2,null) as value", [id.pupilA, oldYear]));
    await denied(actor(id.guardianA, "select app_private.family_attendance_report_school('parent',$1) as value", [id.pupilA]));
    expect((await db.query(`select p.proname,p.prosecdef as definer,has_function_privilege('authenticated',p.oid,'EXECUTE') as browser,
      has_function_privilege('anon',p.oid,'EXECUTE') as anonymous,has_function_privilege('service_role',p.oid,'EXECUTE') as server
      from pg_proc p where p.oid in(to_regprocedure('public.get_family_attendance_report(text,uuid,uuid,date)'),to_regprocedure('public.get_family_attendance_report_context(text,uuid)')) order by p.proname`)).rows)
      .toEqual([{ proname: "get_family_attendance_report", definer: false, browser: true, anonymous: false, server: false },
        { proname: "get_family_attendance_report_context", definer: false, browser: true, anonymous: false, server: false }]);
  });
  it("does not mutate retained marks, fees, enrollment or guardian links on successful and denied reads", async () => {
    await policy(); await complete(); const before = await snapshot();
    await context(); await report(); await report(null); await denied(report(id.yearB)); await denied(context(id.adminA));
    expect(await snapshot()).toEqual(before);
  });
});
