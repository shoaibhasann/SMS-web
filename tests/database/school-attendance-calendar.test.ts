// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite, today: string, yesterday: string, tomorrow: string, weekday: number;
const principal = randomUUID();
type Day = { day: string; configured: boolean; is_working: boolean | null; source: string; label: string | null;
  policy_revision: number | null; exception_revision: number | null; correction_window_days: number | null };
type Calendar = { user_id: string; school_id: string; revision: number; can_edit: boolean; days: Day[]; policies: unknown[]; exceptions: unknown[]; policy_count: number; exception_count: number };
type Ack = { user_id: string; school_id: string; revision: number; request_id: string; replayed: boolean };
type Context = Day & { user_id: string; can_request_correction: boolean; can_mark_holiday: boolean };
async function actor<T>(user: string | null, sql: string, args: unknown[] = [], options: { role?: "authenticated" | "anon" | "service_role"; aal?: string; session?: string } = {}) {
  await db.exec("savepoint calendar_actor");
  try {
    await db.exec(`set local role ${options.role ?? "authenticated"}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [user ?? "", JSON.stringify({ sub: user, session_id: options.session ?? user, aal: options.aal ?? "aal2", role: options.role ?? "authenticated" })]);
    const result = await db.query<{ value: T }>(sql, args);
    await db.exec("reset role;release savepoint calendar_actor");
    await db.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true)");
    return result.rows[0]?.value;
  } catch (error) { await db.exec("rollback to savepoint calendar_actor;release savepoint calendar_actor"); throw error; }
}
const denied = (promise: Promise<unknown>, code = "42501") => expect(promise).rejects.toMatchObject({ code });
const read = (user = id.adminA, school = id.schoolA, from = today, to = from, options = {}) =>
  actor<Calendar>(user, "select public.get_school_attendance_calendar($1,$2,$3) as value", [school, from, to], options);
const policy = (opts: { user?: string; school?: string; revision?: number; day?: string; days?: number[] | null; window?: number; request?: string; reason?: string; aal?: string } = {}) =>
  actor<Ack>(opts.user ?? id.adminA, "select public.save_school_attendance_policy($1,$2,$3,$4::integer[],$5,$6,$7) as value",
    [opts.school ?? id.schoolA, opts.revision ?? 0, opts.day ?? today, opts.days === undefined ? [0, 1, 2, 3, 4, 5, 6] : opts.days,
      opts.window ?? 2, opts.reason ?? "Approved working week", opts.request ?? randomUUID()], { aal: opts.aal });
const exception = (opts: { user?: string; revision?: number; day?: string; mode?: string; label?: string | null; request?: string } = {}) =>
  actor<Ack>(opts.user ?? id.adminA, "select public.save_school_attendance_exception($1,$2,$3,$4,$5,'Approved calendar exception',$6) as value",
    [id.schoolA, opts.revision ?? 1, opts.day ?? today, opts.mode ?? "holiday", opts.label === undefined ? "School holiday" : opts.label, opts.request ?? randomUUID()]);
const context = (user = id.teacherA, day = today, school = id.schoolA, year = id.yearA, classId = id.classA, section = id.sectionA) =>
  actor<Context>(user, "select public.get_attendance_day_context($1,$2,$3,$4,$5) as value", [school, year, classId, section, day]);
const mark = (user = id.teacherA, status = "present", pupil = id.pupilA) => actor<string>(user,
  "insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status,marked_by) values($1,$2,$3,$4,$5,$6,$7) returning id as value",
  [id.schoolA, id.yearA, id.sectionA, pupil, today, status, user]);
const request = (opts: { pupil?: string; beforeId?: string | null; beforeRevision?: number | null; status?: string; request?: string; day?: string; user?: string } = {}) =>
  actor<string>(opts.user ?? id.teacherA, "select public.request_attendance_correction($1,$2,$3,$4,$5,$6,$7,$8,'Verified teacher correction',$9) as value",
    [id.schoolA, id.yearA, id.sectionA, opts.pupil ?? id.pupilA, opts.day ?? yesterday,
      opts.beforeId === undefined ? id.attendanceA : opts.beforeId, opts.beforeRevision === undefined ? 1 : opts.beforeRevision, opts.status ?? "present", opts.request ?? randomUUID()]);
const review = (key: string, user = id.adminA) => actor<string>(user, "select public.review_attendance_correction($1,'approved','Reviewed attendance evidence') as value", [key]);
async function gate(days = [0, 1, 2, 3, 4, 5, 6]) {
  const device = randomUUID(), secret = randomBytes(32).toString("base64url");
  await actor(id.adminA, "select public.create_gate_device($1,$2,'Calendar QA gate',$3,'23:59',$4::integer[]) as value", [id.schoolA, device, secret, days]);
  await actor(id.adminA, "select public.map_gate_student($1,$2,'pupil-card',$3) as value", [device, randomUUID(), id.pupilA]);
  return { device, secret, ingest: (event = randomUUID(), direction = "IN") => actor<{ status: string; reason: string; duplicate: boolean }>(null,
    "select public.ingest_gate_attendance_event($1,$2,$3,'pupil-card',$4,$5) as value", [device, secret, event, direction, `${today}T00:00:01+05:30`], { role: "service_role" }) };
}
beforeAll(async () => {
  db = await createRecoveryDatabase(); await seedRecoveryData(db);
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'principal-calendar@qa.invalid',now())", [principal]);
  await db.query("update public.profiles set school_id=$2 where id=$1", [principal, id.schoolA]);
  await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'principal')", [principal, id.schoolA]);
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
  for (const user of [id.adminA, id.adminB, id.teacherA, principal]) {
    const factor = randomUUID();
    await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status) values($1,$2,'totp','verified')", [factor, user]);
    await db.query("update auth.sessions set aal='aal2',factor_id=$2 where id=$1", [user, factor]);
  }
  const day = (await db.query<{ today: string; yesterday: string; tomorrow: string; weekday: number }>(`select
    (now() at time zone 'Asia/Kolkata')::date::text as today,((now() at time zone 'Asia/Kolkata')::date-1)::text as yesterday,
    ((now() at time zone 'Asia/Kolkata')::date+1)::text as tomorrow,extract(dow from now() at time zone 'Asia/Kolkata')::integer as weekday`)).rows[0];
  ({ today, yesterday, tomorrow, weekday } = day);
  await db.query("update public.academic_years set start_date=$1::date-366,end_date=$1::date+366", [today]);
  await db.query("update public.attendance set attendance_date=$1", [yesterday]);
}, 60000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

describe("native school calendar authority", () => {
  it("leaves all schools explicitly unconfigured without changing old marks, fees or child links", async () => {
    const before = (await db.query("select (select jsonb_agg(to_jsonb(a) order by id) from public.attendance a) as marks,(select jsonb_agg(to_jsonb(f) order by id) from public.student_fees f) as fees,(select jsonb_agg(to_jsonb(l) order by student_id,parent_id) from public.student_parents l) as links")).rows;
    expect((await read()).days).toEqual([{ day: today, configured: false, is_working: null, source: "unconfigured", label: null, policy_revision: null, exception_revision: null, correction_window_days: null }]);
    await policy({ day: tomorrow });
    expect((await db.query("select (select jsonb_agg(to_jsonb(a) order by id) from public.attendance a) as marks,(select jsonb_agg(to_jsonb(f) order by id) from public.student_fees f) as fees,(select jsonb_agg(to_jsonb(l) order by student_id,parent_id) from public.student_parents l) as links")).rows).toEqual(before);
  });
  it("allows Admin and Principal while keeping Teacher reads readonly", async () => {
    expect((await read(id.teacherA)).can_edit).toBe(false);
    expect((await policy({ user: principal })).revision).toBe(1);
    expect((await read(principal)).can_edit).toBe(true);
    expect((await context(principal)).can_mark_holiday).toBe(true);
    expect((await context()).can_mark_holiday).toBe(false);
    await denied(policy({ user: id.teacherA, revision: 1 }));
    await denied(exception({ user: id.teacherA }));
  });
  it.each([id.guardianA, id.studentUserA, id.claimantA, id.adminB])("denies unrelated/family actor %s", async user => {
    await denied(read(user)); await denied(policy({ user }));
  });
  it("denies missing, foreign and revoked native sessions and forged AAL2 claims", async () => {
    await denied(read(id.adminA, id.schoolA, today, today, { session: randomUUID() }));
    await denied(read(id.adminA, id.schoolA, today, today, { session: id.adminB }));
    await denied(policy({ aal: "aal1" }));
    await db.query("update auth.sessions set aal='aal1',factor_id=null where id=$1", [id.adminA]);
    await denied(policy());
  });
  it("denies Holiday authority and calendar writes after a verified factor is revoked", async () => {
    await db.query("update auth.mfa_factors set status='unverified' where user_id=$1", [id.adminA]);
    await denied(policy()); await denied(mark(id.adminA, "holiday"));
  });
  it("requires AAL2 even when the school has no mandatory MFA policy or enrolled factor", async () => {
    await db.query("update auth.sessions set aal='aal1',factor_id=null where id=$1", [principal]);
    await db.query("delete from auth.mfa_factors where user_id=$1", [principal]);
    expect((await read(principal, id.schoolA, today, today, { aal: "aal1" })).can_edit).toBe(false);
    await denied(policy({ user: principal, aal: "aal1" }));
  });
  it("denies removed roles, inactive/coherently foreign profiles and super-admin-only authority", async () => {
    await db.query("delete from public.user_roles where user_id=$1", [id.adminA]);
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,null,'super_admin')", [id.adminA]);
    await denied(policy());
    await db.query("update public.profiles set school_id=$2 where id=$1", [principal, id.schoolB]);
    await denied(policy({ user: principal }));
  });
  it("keeps unchecked policy resolvers, receipts and raw legacy holiday writes inaccessible", async () => {
    await denied(actor(id.teacherA, "select app_private.resolve_attendance_calendar_day($1,$2) as value", [id.schoolA, today]));
    await denied(actor(id.adminA, "select * from app_private.school_attendance_calendar_receipts"));
    await denied(actor(id.teacherA, "insert into public.school_holidays(school_id,academic_year_id,holiday_date,title) values($1,$2,$3,'Unauthorized holiday')", [id.schoolA, id.yearA, tomorrow]));
    expect((await db.query(`select has_table_privilege('authenticated','public.school_holidays','INSERT,UPDATE,DELETE') as legacy,
      has_function_privilege('anon','public.save_school_attendance_policy(uuid,bigint,date,integer[],integer,text,uuid)','EXECUTE') as anonymous,
      has_function_privilege('service_role','public.save_school_attendance_policy(uuid,bigint,date,integer[],integer,text,uuid)','EXECUTE') as server`)).rows).toEqual([{ legacy: false, anonymous: false, server: false }]);
  });
});

describe("immutable versions, exceptions and reliable retries", () => {
  it.each([{ days: [] }, { days: [1, 1] }, { days: [7] }, { days: null }, { window: -1 }, { window: 366 }, { reason: "bad" }])("rejects invalid policy %j", async invalid => {
    await denied(policy(invalid), "22023"); expect((await read()).revision).toBe(0);
  });
  it("bounds date reads and rejects past policy/exception publication", async () => {
    await denied(policy({ day: yesterday }), "22023");
    await denied(read(id.adminA, id.schoolA, "2026-01-01", "2027-01-02"), "22023");
    await denied(exception({ revision: 0 }), "22023");
    await policy(); await denied(exception({ day: yesterday }), "22023");
  });
  it("resolves weekly closures, working overrides, Holiday overrides and inherit without deleting history", async () => {
    await policy({ days: [(weekday + 1) % 7] });
    expect((await read()).days[0]).toMatchObject({ is_working: false, source: "weekday", policy_revision: 1 });
    await exception({ mode: "working", label: "Special teaching day" });
    expect((await read()).days[0]).toMatchObject({ is_working: true, source: "exception", exception_revision: 2 });
    await exception({ revision: 2 });
    expect((await read()).days[0]).toMatchObject({ is_working: false, source: "exception", label: "School holiday", exception_revision: 3 });
    await exception({ revision: 3, mode: "inherit", label: null });
    const saved = await read();
    expect(saved.days[0]).toMatchObject({ is_working: false, source: "weekday", label: null, exception_revision: 4 });
    expect(saved.exception_count).toBe(3);
  });
  it("selects the nearest effective policy, leaving earlier days unconfigured", async () => {
    await policy({ day: tomorrow, days: [weekday], window: 0 });
    expect((await read()).days[0].configured).toBe(false);
    expect((await read(id.adminA, id.schoolA, tomorrow)).days[0]).toMatchObject({ configured: true, correction_window_days: 0 });
    await policy({ revision: 1, day: today, window: 2 });
    expect((await read()).days[0].policy_revision).toBe(2);
    expect((await read(id.adminA, id.schoolA, tomorrow)).days[0].policy_revision).toBe(1);
  });
  it("requires a policy effective on an exception day", async () => {
    await policy({ day: tomorrow }); await denied(exception(), "22023");
    await exception({ day: tomorrow });
  });
  it("denies stale revisions and changed payload ID reuse while allowing exact retry after new evidence", async () => {
    const key = randomUUID(); await policy({ request: key }); await mark();
    expect(await policy({ request: key })).toMatchObject({ revision: 1, replayed: true });
    await denied(policy({ request: key, window: 1 }), "PT409");
    await denied(policy({ revision: 0, day: tomorrow }), "PT409");
    await denied(policy({ revision: 1 }), "PT409");
    await denied(exception(), "PT409");
    expect((await read()).policy_count).toBe(1);
  });
  it("locks today after even held gate evidence and leaves future updates possible", async () => {
    const terminal = await gate(); await terminal.ingest(randomUUID(), "OUT");
    await denied(policy(), "PT409");
    expect((await policy({ day: tomorrow })).revision).toBe(1);
  });
  it("caps returned history at 50 while resolving from every retained version", async () => {
    for (let revision = 0; revision < 51; revision++) await policy({ revision, day: tomorrow });
    const saved = await read(); expect(saved.policy_count).toBe(51); expect(saved.policies).toHaveLength(50);
    expect((await read(id.adminA, id.schoolA, tomorrow)).days[0].policy_revision).toBe(51);
  });
});

describe("shared manual/gate/monitor day policy", () => {
  it("rejects manual marks on a closed day for Teacher and Office without creating absent/holiday rows", async () => {
    await policy({ days: [(weekday + 1) % 7] });
    await denied(mark()); await denied(mark(id.adminA)); await denied(mark(id.adminA, "holiday"));
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.attendance where attendance_date=$1", [today])).rows[0].n).toBe(0);
    const monitor = await actor<{ calendar_day: Day; sections: unknown[]; session_state: string; year: { id: string } }>(id.adminA,
      "select public.get_attendance_submission_monitor($1) as value", [id.schoolA]);
    expect(monitor.calendar_day.is_working).toBe(false); expect(monitor.sections).toEqual([]);
    expect(monitor.session_state).toBe("active"); expect(monitor.year.id).toBe(id.yearA);
  });
  it("denies Teacher-created or changed Holiday marks even with an unconfigured calendar", async () => {
    await denied(mark(id.teacherA, "holiday"));
    const key = await mark(id.adminA, "holiday");
    await denied(actor(id.teacherA, "update public.attendance set status='present',marked_by=$1 where id=$2 returning id as value", [id.teacherA, key]));
    expect((await db.query<{ status: string }>("select status from public.attendance where id=$1", [key])).rows[0].status).toBe("holiday");
  });
  it("allows normal native manual marks on a working day and fences a following holiday edit", async () => {
    await policy(); await mark(); await denied(exception(), "PT409");
    expect((await context()).is_working).toBe(true);
  });
  it("makes configured working days authoritative over a closed legacy device weekday and records provenance", async () => {
    await policy({ days: [weekday] }); const terminal = await gate([(weekday + 1) % 7]);
    expect(await terminal.ingest()).toMatchObject({ status: "accepted", reason: "marked_present" });
    expect((await db.query("select calendar_policy_revision::int as policy,calendar_exception_revision from app_private.gate_events where device_id=$1", [terminal.device])).rows)
      .toEqual([{ policy: 1, calendar_exception_revision: null }]);
  });
  it("holds both gate directions on a school holiday despite an always-open device", async () => {
    await policy(); await exception(); const terminal = await gate();
    expect(await terminal.ingest()).toMatchObject({ status: "held_review", reason: "non_working_day" });
    expect(await terminal.ingest(randomUUID(), "OUT")).toMatchObject({ status: "held_review", reason: "non_working_day" });
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.attendance where attendance_date=$1", [today])).rows[0].n).toBe(0);
  });
  it("keeps unconfigured legacy gate weekdays and exact original receipt retries", async () => {
    const terminal = await gate([(weekday + 1) % 7]), event = randomUUID();
    expect(await terminal.ingest(event)).toMatchObject({ status: "held_review", reason: "non_working_day" });
    expect(await terminal.ingest(event)).toMatchObject({ duplicate: true });
  });
  it("rejects foreign class/section day contexts and non-requester Office correction authority", async () => {
    await denied(context(id.teacherA, today, id.schoolB, id.yearB, id.classB, id.sectionB));
    await denied(context(id.teacherA, today, id.schoolA, id.yearA, id.classB, id.sectionA), "22023");
    expect((await context(id.adminA, yesterday)).can_request_correction).toBe(false);
    await denied(request({ user: id.adminA }));
  });
});

describe("governed Teacher correction window and Holiday decisions", () => {
  it("uses the TODAY-active window for a retained unconfigured historical day", async () => {
    await policy({ window: 2 });
    expect(await context(id.teacherA, yesterday)).toMatchObject({ configured: false, correction_window_days: null, can_request_correction: true });
    expect(await request()).toBeTypeOf("string");
  });
  it("disables new historical requests at zero but grandfathers an exact pending retry and independent review", async () => {
    await policy({ window: 2 }); const key = randomUUID(); await request({ request: key });
    await policy({ revision: 1, window: 0 });
    expect((await context(id.teacherA, yesterday)).can_request_correction).toBe(false);
    expect(await request({ request: key })).toBe(key);
    await denied(request({ pupil: id.unlinkedPupilA, beforeId: id.attendanceUnlinkedA }));
    expect(await review(key)).toBe("approved");
    expect((await db.query<{ status: string }>("select status from public.attendance where id=$1", [id.attendanceA])).rows[0].status).toBe("present");
  });
  it("rejects an older date beyond the window and rejects requests to/from Holiday", async () => {
    await policy({ window: 1 });
    const old = (await db.query<{ value: string }>("select ($1::date-2)::text as value", [today])).rows[0].value;
    await denied(request({ day: old, beforeId: null, beforeRevision: null }));
    await denied(request({ status: "holiday" }));
    await db.query("update public.attendance set status='holiday' where id=$1", [id.attendanceA]);
    await denied(request({ beforeRevision: 2 }));
  });
  it("rechecks current native Teacher role on old pending retries and current Office role on review", async () => {
    const key = randomUUID(); await request({ request: key });
    await db.query("delete from public.user_roles where user_id=$1", [id.teacherA]);
    await denied(request({ request: key }));
    await denied(review(key, id.adminB));
  });
  it("preserves the whole-row optimistic review conflict rather than replacing an edited historical mark", async () => {
    const key = await request(); await db.query("update public.attendance set status='late' where id=$1", [id.attendanceA]);
    await denied(review(key), "PT409");
  });
  it("grandfathers a legacy pending Holiday request but requires native AAL2 Office approval", async () => {
    const key = randomUUID();
    await db.query(`insert into app_private.attendance_corrections(id,school_id,academic_year_id,section_id,student_id,attendance_date,
      requested_by,request_reason,requested_status,before_record) select $1,school_id,academic_year_id,section_id,student_id,attendance_date,
      $2,'Verified teacher correction','holiday',to_jsonb(a) from public.attendance a where id=$3`, [key, id.teacherA, id.attendanceA]);
    expect(await request({ request: key, status: "holiday" })).toBe(key);
    await db.query("update auth.sessions set aal='aal1',factor_id=null where id=$1", [principal]);
    await db.query("delete from auth.mfa_factors where user_id=$1", [principal]);
    await denied(actor(principal, "select public.review_attendance_correction($1,'approved','Reviewed attendance evidence') as value", [key], { aal: "aal1" }));
    expect(await review(key)).toBe("approved");
    expect((await db.query<{ status: string }>("select status from public.attendance where id=$1", [id.attendanceA])).rows[0].status).toBe("holiday");
  });
});
