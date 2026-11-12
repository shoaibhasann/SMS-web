// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite, today: string, dates: string[], start: string;
const principal = randomUUID();
type Row = { day: string; status: "working" | "holiday"; label: string };
type Preview = { user_id: string; school_id: string; academic_year_id: string; revision: number; preview_token: string; can_import: boolean;
  rows: (Row & { row_number: number; issue: string | null; attendance_count: number; pupils_with_marks: number; present_count: number; holiday_count: number })[];
  summary: { total_rows: number; valid_rows: number; working_rows: number; holiday_rows: number; attendance_records: number; pupils_with_marks: number } };
type Ack = { user_id: string; revision: number; request_id: string; imported_rows: number; working_rows: number; holiday_rows: number; replayed: boolean };
type Context = { revision: number; can_import: boolean; years: { id: string }[]; history: { request_id: string; revision: number; reason: string; actor_id: string; actor_name: string | null }[] };
async function actor<T>(user: string | null, sql: string, args: unknown[] = [], options: { role?: "authenticated" | "anon" | "service_role"; aal?: string; session?: string } = {}) {
  await db.exec("savepoint historical_calendar_actor");
  try {
    await db.exec(`set local role ${options.role ?? "authenticated"}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [user ?? "", JSON.stringify({ sub: user, session_id: options.session ?? user, aal: options.aal ?? "aal2", role: options.role ?? "authenticated" })]);
    const result = await db.query<{ value: T }>(sql, args);
    await db.exec("reset role;release savepoint historical_calendar_actor");
    await db.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true)");
    return result.rows[0]?.value;
  } catch (error) { await db.exec("rollback to savepoint historical_calendar_actor;release savepoint historical_calendar_actor"); throw error; }
}
const denied = (promise: Promise<unknown>, code = "42501") => expect(promise).rejects.toMatchObject({ code });
const rows = (days = dates.slice(0, 6)): Row[] => days.map((day, index) => ({ day, status: index === 3 ? "holiday" : "working", label: index === 3 ? "Verified historical holiday" : "Verified school working day" }));
const context = (user = id.adminA, school = id.schoolA, options = {}) => actor<Context>(user,
  "select public.get_historical_attendance_calendar_context($1) as value", [school], options);
const preview = (input: unknown = rows(), user = id.adminA, school = id.schoolA, year = id.yearA, options = {}) => actor<Preview>(user,
  "select public.preview_historical_attendance_calendar($1,$2,$3::jsonb) as value", [school, year, JSON.stringify(input)], options);
const commit = (view: Preview, input: Row[] = rows(), opts: { user?: string; school?: string; year?: string; request?: string; revision?: number; token?: string; ack?: boolean; reason?: string; aal?: string } = {}) => actor<Ack>(opts.user ?? id.adminA,
  "select public.import_historical_attendance_calendar($1,$2,$3::jsonb,$4,$5,$6,$7,$8) as value", [opts.school ?? id.schoolA, opts.year ?? id.yearA,
    JSON.stringify(input), opts.revision ?? view.revision, opts.token ?? view.preview_token, opts.ack ?? true, opts.reason ?? "Verified historical school register", opts.request ?? randomUUID()], { aal: opts.aal });
async function mark(day: string, status = "present", student = id.pupilA, year = id.yearA) {
  await db.query("insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status) values($1,$2,$3,$4,$5,$6)",
    [id.schoolA, year, id.sectionA, student, day, status]);
}
const policy = () => actor(id.adminA, "select public.save_school_attendance_policy($1,0,$2,array[0,1,2,3,4,5,6],2,'Approved current school week',$3) as value", [id.schoolA, today, randomUUID()]);
const summary = () => actor<{ year_summary: { state: string; working_days: number; closed_days: number; percentage: number | null; unconfigured_days: number } }>(id.guardianA,
  "select public.get_family_attendance_summary('parent',$1,null) as value", [id.pupilA], { aal: "aal1" });
const snapshot = async () => (await db.query(`select (select jsonb_agg(to_jsonb(a) order by id) from public.attendance a) as marks,
 (select jsonb_agg(to_jsonb(f) order by id) from public.student_fees f) as fees,
 (select jsonb_agg(to_jsonb(l) order by student_id,parent_id) from public.student_parents l) as links`)).rows;
beforeAll(async () => {
  db = await createRecoveryDatabase(); await seedRecoveryData(db);
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'principal-history@qa.invalid',now())", [principal]);
  await db.query("update public.profiles set school_id=$2 where id=$1", [principal, id.schoolA]);
  await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'principal')", [principal, id.schoolA]);
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
  for (const user of [id.adminA, id.adminB, id.teacherA, principal]) {
    const factor = randomUUID();
    await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status) values($1,$2,'totp','verified')", [factor, user]);
    await db.query("update auth.sessions set aal='aal2',factor_id=$2 where id=$1", [user, factor]);
  }
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

describe("historical calendar import authority", () => {
  it.each([id.teacherA, id.guardianA, id.studentUserA, id.claimantA, id.adminB])("denies import context, preview and commit to %s", async user => {
    const view = await preview();
    await denied(context(user)); await denied(preview(rows(), user)); await denied(commit(view, rows(), { user }));
  });
  it("permits same-school Principal and gives non-MFA office context a readonly state", async () => {
    expect((await context(principal)).can_import).toBe(true);
    await db.query("delete from auth.mfa_factors where user_id=$1", [principal]);
    await db.query("update auth.sessions set aal='aal1',factor_id=null where user_id=$1", [principal]);
    expect((await context(principal, id.schoolA, { aal: "aal1" })).can_import).toBe(false);
    await denied(preview(rows(), principal, id.schoolA, id.yearA, { aal: "aal1" }));
  });
  it("requires a live native AAL2 session and verified native factor, including after preview", async () => {
    const view = await preview();
    await denied(preview(rows(), id.adminA, id.schoolA, id.yearA, { aal: "aal1" }));
    await denied(preview(rows(), id.adminA, id.schoolA, id.yearA, { session: id.adminB }));
    await db.query("update auth.mfa_factors set status='unverified' where user_id=$1", [id.adminA]);
    await denied(commit(view));
  });
  it("denies inactive/removed office access and super-admin-only claims", async () => {
    await db.query("delete from public.user_roles where user_id=$1", [id.adminA]);
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,null,'super_admin')", [id.adminA]);
    await denied(context()); await denied(preview());
    await db.query("update public.profiles set is_active=false where id=$1", [principal]);
    await denied(context(principal));
  });
  it("keeps raw history, normalization and unchecked resolver private from every API role", async () => {
    for (const role of ["authenticated", "anon", "service_role"] as const) await denied(actor(id.adminA,
      "select * from app_private.school_attendance_historical_days", [], { role }));
    await denied(actor(id.adminA, "select app_private.normalize_historical_attendance_calendar_rows($1) as value", [JSON.stringify(rows())]));
    const permissions = (await db.query(`select p.prosecdef as definer,has_function_privilege('authenticated',p.oid,'EXECUTE') as browser,
      has_function_privilege('anon',p.oid,'EXECUTE') as anonymous,has_function_privilege('service_role',p.oid,'EXECUTE') as server
      from pg_proc p where p.oid=to_regprocedure('public.import_historical_attendance_calendar(uuid,uuid,jsonb,bigint,text,boolean,text,uuid)')`)).rows;
    expect(permissions).toEqual([{ definer: false, browser: true, anonymous: false, server: false }]);
  });
});

describe("authoritative preview and gap-only validation", () => {
  it.each([null, {}, [], Array.from({ length: 367 }, () => ({ day: "2026-01-01", status: "working", label: "School day" })),
    [{ day: "2026-02-30", status: "working", label: "Day" }], [{ day: "2026-1-01", status: "working", label: "Day" }],
    [{ day: "2026-01-01", status: "present", label: "Day" }], [{ day: "2026-01-01", status: "working", label: " " }],
    [{ day: "2026-01-01", status: "working", label: "Day\nOops" }], [{ day: "2026-01-01", status: "working", label: "x".repeat(121) }],
    [{ day: "2026-01-01", status: "working", label: "Day", extra: true }],
  ])("rejects malformed source %#", async input => { await denied(preview(input), "22023"); });
  it("rejects oversized normalized JSON before allocating rows", async () => {
    await denied(preview([{ day: "2026-01-01", status: "working", label: "x".repeat(131072) }]), "22023");
  });
  it("returns row issues for duplicates, nonpast dates and out-of-year dates without writes", async () => {
    const input = [rows()[0], rows()[0], { day: today, status: "working" as const, label: "Today" },
      { day: "2000-01-01", status: "holiday" as const, label: "Outside" }];
    const view = await preview(input);
    expect(view.can_import).toBe(false); expect(view.summary.valid_rows).toBe(0);
    expect(view.rows.map(row => row.issue)).toEqual(["Duplicate date in this CSV.", "Duplicate date in this CSV.",
      "Only dates before today can be imported.", "Date is outside the selected academic year."]);
    await denied(commit(view, input), "22023");
    expect((await context()).revision).toBe(0);
  });
  it("rejects foreign, missing and unsupported academic years; lists only supported own-school years", async () => {
    await denied(preview(rows(), id.adminA, id.schoolA, id.yearB));
    await denied(preview(rows(), id.adminA, id.schoolA, randomUUID()));
    expect((await context()).years.map(y => y.id)).toContain(id.yearA);
    expect((await context()).years.map(y => y.id)).not.toContain(id.yearB);
    await db.query("update public.academic_years set end_date=start_date+366 where id=$1", [id.yearA]);
    expect((await context()).years).toEqual([]); await denied(preview(), "22023");
  });
  it("includes retained marks across all academic years in the school's exact date impact", async () => {
    const anotherYear = randomUUID();
    await db.query("insert into public.academic_years(id,school_id,name,start_date,end_date) values($1,$2,'Historical overlapping QA',$3,$4)", [anotherYear, id.schoolA, start, today]);
    await mark(dates[0]); await mark(dates[1], "holiday", id.pupilA, anotherYear);
    const view = await preview();
    expect(view.rows[0]).toMatchObject({ attendance_count: 1, present_count: 1, holiday_count: 0, pupils_with_marks: 1 });
    expect(view.rows[1]).toMatchObject({ attendance_count: 1, present_count: 0, holiday_count: 1, pupils_with_marks: 1 });
    expect(view.summary).toEqual({ total_rows: 6, valid_rows: 6, working_rows: 5, holiday_rows: 1, attendance_records: 2, pupils_with_marks: 1 });
  });
  it("does not overwrite an existing effective policy, even when the submitted status matches", async () => {
    await db.query(`insert into app_private.school_attendance_policy_versions(school_id,revision,effective_from,working_days,correction_window_days,reason,actor_id,request_id)
      values($1,1,$2,array[0,1,2,3,4,5,6],2,'Verified existing calendar',$3,$4)`, [id.schoolA, start, id.adminA, randomUUID()]);
    const view = await preview(rows().slice(0, 1));
    expect(view.can_import).toBe(false); expect(view.rows[0].issue).toMatch(/already has/);
    await denied(commit(view, rows().slice(0, 1)), "22023");
    expect((await context()).revision).toBe(1);
  });
  it("blocks any configured day, including a matching historical import, atomically", async () => {
    const one = rows().slice(0, 1); await commit(await preview(one), one);
    const both = rows().slice(0, 2), view = await preview(both);
    expect(view.rows[0].issue).toMatch(/already has/); expect(view.rows[1].issue).toBeNull();
    await denied(commit(view, both), "22023");
    expect((await db.query("select count(*)::int as n from app_private.school_attendance_historical_days")).rows).toEqual([{ n: 1 }]);
  });
});

describe("historical correction and import serialization", () => {
  it("acquires the shared calendar fence before correction or attendance row locks, then rechecks office access", async () => {
    const body = (await db.query<{ source: string }>("select prosrc as source from pg_proc where oid='app_private.review_attendance_correction(uuid,text,text)'::regprocedure")).rows[0].source;
    const fence = body.indexOf("pg_advisory_xact_lock_shared");
    const rowLock = body.indexOf("where id = p_request_id for update;");
    const markLock = body.indexOf("where student_id = correction.student_id and attendance_date = correction.attendance_date for update;");
    const recheck = body.indexOf("actor_id:=app_private.attendance_calendar_actor(correction.school_id);", fence);
    expect(fence).toBeGreaterThan(0); expect(fence).toBeLessThan(rowLock); expect(rowLock).toBeLessThan(markLock);
    expect(recheck).toBeGreaterThan(fence); expect(recheck).toBeLessThan(rowLock);
    expect(body.slice(recheck, rowLock)).toContain("role in('school_admin','principal')");
  });
  it("keeps missing-mark review authorized and rejects its now-stale calendar preview", async () => {
    const source = rows().slice(0, 1), view = await preview(source), key = randomUUID();
    await actor(id.teacherA, `select public.request_attendance_correction($1,$2,$3,$4,$5,null,null,'present','Verified missing school register entry',$6) as value`,
      [id.schoolA, id.yearA, id.sectionA, id.pupilA, start, key]);
    await denied(actor(id.teacherA, "select public.review_attendance_correction($1,'approved','Verified independent review') as value", [key]));
    expect(await actor(id.adminA, "select public.review_attendance_correction($1,'approved','Verified independent review') as value", [key])).toBe("approved");
    expect(await actor(id.adminA, "select public.review_attendance_correction($1,'approved','Verified independent review') as value", [key])).toBe("approved");
    await denied(commit(view, source), "PT409");
    const fresh = await preview(source);
    expect(fresh.rows[0]).toMatchObject({ present_count: 1, pupils_with_marks: 1, attendance_count: 1 });
    expect((await commit(fresh, source)).imported_rows).toBe(1);
  });
});

describe("atomic publication, exact retries and official reporting", () => {
  it("preserves all canonical marks/fees/links, unlocks only verified historical days and leaves gaps unknown", async () => {
    await policy();
    for (const [index, status] of ["present", "late", "half_day", "present", "leave", "absent", "present"].entries()) await mark(dates[index], status);
    const before = await snapshot();
    expect((await summary()).year_summary).toMatchObject({ state: "calendar_unconfigured", unconfigured_days: 6, percentage: null });
    const view = await preview(), result = await commit(view);
    expect(result).toMatchObject({ revision: 2, imported_rows: 6, working_rows: 5, holiday_rows: 1, replayed: false });
    expect(await snapshot()).toEqual(before);
    expect((await summary()).year_summary).toMatchObject({ state: "complete", working_days: 6, closed_days: 1, percentage: 58.33 });
    const calendar = await actor<{ days: { configured: boolean; source: string; import_revision?: number; policy_revision: number | null }[] }>(id.adminA,
      "select public.get_school_attendance_calendar($1,$2::date-1,$3) as value", [id.schoolA, start, today]);
    expect(calendar.days[0]).toMatchObject({ configured: false, source: "unconfigured" });
    expect(calendar.days[1]).toMatchObject({ configured: true, source: "import", import_revision: 2, policy_revision: null });
    expect(calendar.days.at(-1)).toMatchObject({ configured: true, source: "weekday", policy_revision: 1 });
  });
  it("requires explicit impact acknowledgement and a valid audit reason", async () => {
    const view = await preview();
    await denied(commit(view, rows(), { ack: false }), "22023");
    await denied(commit(view, rows(), { reason: "bad" }), "22023");
    await denied(commit(view, rows(), { reason: "Bad\nreason" }), "22023");
    expect((await context()).history).toEqual([]);
  });
  it("binds the commit to exact preview source, year, current marks and current calendar revision", async () => {
    const view = await preview();
    await denied(commit(view, rows().map((r, i) => i === 0 ? { ...r, label: "Different" } : r)), "PT409");
    await denied(commit(view, rows(), { user: principal }), "PT409");
    await mark(dates[0]); await denied(commit(view), "PT409");
    const fresh = await preview(); await policy(); await denied(commit(fresh), "PT409");
    expect((await context()).history).toEqual([]);
  });
  it("rejects the original token if academic-year bounds changed after preview", async () => {
    const view = await preview();
    await db.query("update public.academic_years set end_date=end_date-1 where id=$1", [id.yearA]);
    await denied(commit(view), "PT409");
  });
  it("permits exact same-actor request replay without duplicate dates/receipts even after later marks", async () => {
    const view = await preview(), key = randomUUID(), first = await commit(view, rows(), { request: key });
    await mark(dates[0]);
    expect(await commit(view, rows(), { request: key })).toEqual({ ...first, replayed: true });
    await denied(commit(view, rows(), { request: key, reason: "Different request evidence" }), "PT409");
    const saved = await context(); expect(saved.revision).toBe(1); expect(saved.history).toHaveLength(1);
    expect(saved.history[0]).toMatchObject({ request_id: key, revision: 1, reason: "Verified historical school register" });
  });
  it("names the importing actor from the same school in history, never only a UUID", async () => {
    await db.query("update public.profiles set full_name='Priya Principal' where id=$1", [principal]);
    await commit(await preview(rows(), principal), rows(), { user: principal });
    expect((await context()).history[0]).toMatchObject({ actor_id: principal, actor_name: "Priya Principal" });
    await db.query("update public.profiles set school_id=$1 where id=$2", [id.schoolB, principal]);
    expect((await context()).history[0]).toMatchObject({ actor_id: principal, actor_name: null });
  });
  it("allows Principal publication and isolates a different school's revision and dates", async () => {
    const view = await preview(rows(), principal);
    expect((await commit(view, rows(), { user: principal })).revision).toBe(1);
    expect((await context(id.adminB, id.schoolB)).revision).toBe(0);
    const foreign = await preview(rows(), id.adminB, id.schoolB, id.yearB);
    expect((await commit(foreign, rows(), { user: id.adminB, school: id.schoolB, year: id.yearB })).revision).toBe(1);
  });
  it("keeps legacy pupil Holiday on imported working day inconsistent rather than fabricating a credit", async () => {
    await policy(); for (const day of dates) await mark(day, day === dates[0] ? "holiday" : "present");
    await commit(await preview());
    expect((await summary()).year_summary).toMatchObject({ state: "inconsistent", percentage: null });
    expect((await db.query("select status from public.attendance where student_id=$1 and attendance_date=$2", [id.pupilA, start])).rows).toEqual([{ status: "holiday" }]);
  });
});
