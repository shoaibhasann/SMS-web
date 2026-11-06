// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase, readRecoveryManifest, readRecoverySources } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite;
const secondGuardian = "76000000-0000-0000-0000-000000000001";
const secondParent = "76000000-0000-0000-0000-000000000002";
type FamilyRole = "parent" | "student";
type Notification = {
  id: string; kind: "absence" | "result_published" | "leave_decision";
  student_id: string; student_name: string; created_at: string; read_at: string | null;
  event_date: string; source_id: string; status: string; title: string; assessment_id: string | null;
};
type Cursor = { created_at: string; kind: string; id: string };
type Inbox = { notifications: Notification[]; unread_count: number; next_cursor: Cursor | null };

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  await db.exec("insert into auth.sessions(id,user_id) select id,id from auth.users");
  await db.query("update public.teacher_assessments set status='completed' where id=$1", [id.assessmentA]);
  await db.exec("begin");
  await actor(id.teacherA, "insert into public.teacher_assessment_marks(assessment_id,student_id,marks_obtained,remarks) values($1,$2,88,'Private peer note')", [id.assessmentA, id.unlinkedPupilA]);
  await db.exec("commit");
}, 60_000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

async function actor<Row extends Record<string, unknown> = Record<string, unknown>>(
  user: string | null, sql: string, params: unknown[] = [], role: "authenticated" | "anon" | "service_role" = "authenticated", session: string | null = user, connection = db,
) {
  await connection.exec("savepoint notification_actor");
  try {
    await connection.exec(`set local role ${role}`);
    await connection.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [user ?? "", JSON.stringify({ sub: user, session_id: session })]);
    const result = await connection.query<Row>(sql, params);
    await connection.exec("reset role");
    await connection.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true)");
    await connection.exec("release savepoint notification_actor");
    return result;
  } catch (error) { await connection.exec("rollback to savepoint notification_actor; release savepoint notification_actor"); throw error; }
}
const value = async <T>(user: string, sql: string, params: unknown[] = []) => (await actor<{ value: T }>(user, sql, params)).rows[0].value;
const inbox = (user = id.guardianA, role: FamilyRole = "parent", unreadOnly = false, limit = 30, cursor: Cursor | null = null) =>
  value<Inbox>(user, "select public.get_family_notification_inbox($1,$2,$3,$4,$5,$6) as value", [role, unreadOnly, limit, cursor?.created_at ?? null, cursor?.kind ?? null, cursor?.id ?? null]);
const count = (user = id.guardianA, role: FamilyRole = "parent") => value<number>(user, "select public.get_family_notification_unread_count($1)::int as value", [role]);
const mark = (event: Notification, user = id.guardianA, role: FamilyRole = "parent") => value<string | null>(user, "select public.mark_family_notification_read($1,$2,$3)::text as value", [role, event.kind, event.id]);
const markAll = (user = id.guardianA, role: FamilyRole = "parent") => value<number>(user, "select public.mark_all_family_notifications_read($1)::int as value", [role]);
const submitLeave = (student = id.pupilA, user = id.guardianA, start = "2026-11-10") => value<string>(user,
  "select public.submit_student_leave($1,$2::date,$2::date,'Private medical appointment',$3) as value", [student, start, randomUUID()]);
const reviewLeave = (request: string, decision = "approved") => value<string>(id.adminA,
  "select public.review_student_leave($1,$2,'Private school review') as value", [request, decision]);
async function requestResult() {
  const preview = await value<{ source_token: string }>(id.teacherA, "select public.preview_assessment_publication($1) as value", [id.assessmentA]);
  return value<string>(id.teacherA, "select public.request_assessment_publication($1,$2,$3) as value", [id.assessmentA, preview.source_token, randomUUID()]);
}
const reviewResult = (submission: string, decision = "published") => value<string>(id.adminA,
  "select public.review_assessment_publication($1,$2,'Private result review') as value", [submission, decision]);
async function publish() { const submission = await requestResult(); await reviewResult(submission); return submission; }
const resultTarget = (student = id.pupilA, assessment = id.assessmentA, user = id.guardianA, role: FamilyRole = "parent") =>
  value<Record<string, unknown> | null>(user, "select public.get_family_notification_result($1,$2,$3) as value", [role, student, assessment]);
const leaveTarget = (request: string, student = id.pupilA, user = id.guardianA, role: FamilyRole = "parent") =>
  value<Record<string, unknown> | null>(user, "select public.get_family_notification_leave($1,$2,$3) as value", [role, student, request]);
const denied = (work: Promise<unknown>) => expect(work).rejects.toMatchObject({ code: "42501" });
const invalid = (work: Promise<unknown>) => expect(work).rejects.toMatchObject({ code: "22023" });
const canonical = async (table: string) => (await db.query(`select to_jsonb(row) as row from ${table} row order by id`)).rows;
async function addGuardian() {
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'second@notifications.invalid',now())", [secondGuardian]);
  await db.query("update public.profiles set school_id=$2,full_name='Second guardian' where id=$1", [secondGuardian, id.schoolA]);
  await db.query("insert into auth.sessions(id,user_id) values($1,$1)", [secondGuardian]);
  await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'parent')", [secondGuardian, id.schoolA]);
  await db.query("insert into public.parents(id,school_id,profile_id) values($1,$2,$3)", [secondParent, id.schoolA, secondGuardian]);
  await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [id.pupilA, secondParent]);
}
async function seedManyDecisions(amount = 106) {
  // Trusted fixtures build distinct immutable sources. Every event still comes
  // from the actual pending -> reviewed AFTER trigger, never a fake alert write.
  await db.query(`insert into app_private.student_leave_requests(school_id,student_id,enrollment_id,academic_year_id,class_id,section_id,
    student_name,admission_no,academic_year_name,class_name,section_name,start_date,end_date,reason,requester_id,requester_name,idempotency_key,created_at)
    select $1,$2,e.id,e.academic_year_id,e.class_id,e.section_id,'Synthetic recovery pupil','REC-A-001','2026–27 Recovery',
      'Recovery class 6','Recovery A',date '2026-04-01'+d,date '2026-04-01'+d,'Private fixture reason',$3,'Synthetic guardian',gen_random_uuid(),
      timestamptz '2026-11-06 12:00:00+00' from public.enrollments e cross join generate_series(0,$4::int-1) d
      where e.student_id=$2`, [id.schoolA, id.pupilA, id.guardianA, amount]);
  await db.query(`update app_private.student_leave_requests set status='approved',reviewed_by=$1,reviewer_name='Synthetic admin',
    review_note='Private fixture review',reviewed_at='2026-11-06 12:00:00+00' where status='pending'`, [id.adminA]);
}

describe("family notifications under the complete recovered schema", () => {
  it("applies additively over actual pre-upgrade decisions without backfill or absence/history mutation", async () => {
    const prior = await createRecoveryDatabase({ applyPending: false });
    try {
      const sources = await readRecoverySources(await readRecoveryManifest());
      const upgrade = sources.find(source => source.version === "20261106144905")!;
      for (const source of sources.filter(source => source.kind === "pending" && source !== upgrade)) await prior.exec(source.sql);
      await seedRecoveryData(prior);
      await prior.exec("insert into auth.sessions(id,user_id) select id,id from auth.users; begin");
      const as = async <T>(user: string, sql: string, params: unknown[] = []) =>
        (await actor<{ value: T }>(user, sql, params, "authenticated", user, prior)).rows[0].value;
      const leave = await as<string>(id.guardianA, "select public.submit_student_leave($1,'2026-11-10','2026-11-10','Existing private reason',$2) as value", [id.pupilA, randomUUID()]);
      await as(id.adminA, "select public.review_student_leave($1,'approved','Existing office decision') as value", [leave]);
      await prior.query("update public.teacher_assessments set status='completed' where id=$1", [id.assessmentA]);
      await as(id.teacherA, "insert into public.teacher_assessment_marks(assessment_id,student_id,marks_obtained) values($1,$2,88) returning id as value", [id.assessmentA, id.unlinkedPupilA]);
      const preview = await as<{ source_token: string }>(id.teacherA, "select public.preview_assessment_publication($1) as value", [id.assessmentA]);
      const submission = await as<string>(id.teacherA, "select public.request_assessment_publication($1,$2,$3) as value", [id.assessmentA, preview.source_token, randomUUID()]);
      await as(id.adminA, "select public.review_assessment_publication($1,'published','Existing result decision') as value", [submission]);
      await prior.exec("update app_private.guardian_absence_alerts set read_at='2026-11-05 10:00:00+00'; commit");
      const protectedTables = ["app_private.guardian_absence_alerts", "app_private.student_leave_requests", "app_private.assessment_result_submissions", "public.attendance", "public.student_fees", "public.fee_payments"];
      const snapshots = await Promise.all(protectedTables.map(table => prior.query(`select to_jsonb(row) as row from ${table} row order by id`)));
      await prior.exec(upgrade.sql);
      for (const [index, table] of protectedTables.entries()) expect((await prior.query(`select to_jsonb(row) as row from ${table} row order by id`)).rows).toEqual(snapshots[index].rows);
      await prior.exec("begin");
      const parent = await as<Inbox>(id.guardianA, "select public.get_family_notification_inbox('parent') as value");
      expect(parent.notifications).toHaveLength(1); expect(parent.notifications[0]).toMatchObject({ kind: "absence", read_at: "2026-11-05T10:00:00+00:00" });
      expect(parent.unread_count).toBe(0);
      expect((await as<Inbox>(id.studentUserA, "select public.get_family_notification_inbox('student') as value")).notifications).toEqual([]);
      expect(await as(id.guardianA, "select public.get_family_notification_result('parent',$1,$2)->>'id' as value", [id.pupilA, id.assessmentA])).toBe(submission);
      expect((await prior.query<{ count: number }>("select count(*)::int as count from app_private.family_notifications")).rows[0].count).toBe(0);
      await prior.exec("rollback");
    } finally { await prior.close(); }
  }, 30_000);

  it("retains legacy absence IDs/read timestamps and returns no synthetic historical decision alerts", async () => {
    const original = await canonical("app_private.guardian_absence_alerts");
    expect((await inbox()).notifications).toHaveLength(1);
    expect((await inbox()).notifications[0]).toMatchObject({ kind: "absence", source_id: id.attendanceA, status: "absent" });
    expect(await canonical("app_private.guardian_absence_alerts")).toEqual(original);
    expect((await db.query<{ count: number }>("select count(*)::int as count from app_private.family_notifications")).rows[0].count).toBe(0);
    expect((await inbox(id.studentUserA, "student")).notifications).toEqual([]);
    const absence = (await inbox()).notifications[0]; await mark(absence);
    const legacy = await value<{ alerts: { id: string; read_at: string }[] }>(id.guardianA, "select public.get_guardian_absence_inbox() as value");
    expect(legacy.alerts[0]).toMatchObject({ id: absence.id, read_at: expect.any(String) });
  });

  it("delivers publication to own student and every eligible linked guardian exactly once, with no peer payload", async () => {
    await addGuardian();
    const attendance = await canonical("public.attendance"), fees = await canonical("public.student_fees");
    const submission = await requestResult();
    expect((await inbox()).notifications.map(n => n.kind)).toEqual(["absence"]);
    await reviewResult(submission); await reviewResult(submission);
    expect((await db.query<{ count: number }>("select count(*)::int as count from app_private.family_notifications")).rows[0].count).toBe(3);
    const event = (await inbox()).notifications.find(n => n.kind === "result_published")!;
    expect(event).toMatchObject({ source_id: submission, assessment_id: id.assessmentA, student_id: id.pupilA, status: "published", read_at: null });
    expect((await inbox(secondGuardian)).notifications[0]).toMatchObject({ source_id: submission });
    expect((await inbox(id.studentUserA, "student")).notifications[0]).toMatchObject({ source_id: submission });
    expect(Object.keys(event).sort()).toEqual(["id", "kind", "student_id", "student_name", "created_at", "read_at", "event_date", "source_id", "status", "title", "assessment_id"].sort());
    for (const privateValue of [id.unlinkedPupilA, "Private peer note", "Private result review", "REC-A-002", "marks_obtained", "payload"])
      expect(JSON.stringify(event)).not.toContain(privateValue);
    expect(await canonical("public.attendance")).toEqual(attendance); expect(await canonical("public.student_fees")).toEqual(fees);
  });

  it("does not send pending/rejected result requests or retroactive alerts to a newly linked guardian", async () => {
    const rejected = await requestResult(); await reviewResult(rejected, "rejected");
    expect((await inbox(id.studentUserA, "student")).notifications).toEqual([]);
    const published = await publish(); await addGuardian();
    expect((await inbox(secondGuardian)).notifications).toEqual([]);
    expect((await inbox()).notifications.some(n => n.source_id === published)).toBe(true);
    expect(await resultTarget(id.pupilA, id.assessmentA, secondGuardian)).toMatchObject({ id: published });
  });

  it("creates approved and rejected leave alerts atomically, excludes private reason/note, and supports safe target reads", async () => {
    const request = await submitLeave();
    expect(await leaveTarget(request)).toBeNull();
    expect((await inbox()).notifications.map(n => n.kind)).toEqual(["absence"]);
    await reviewLeave(request); await reviewLeave(request);
    const rejected = await submitLeave(id.pupilA, id.guardianA, "2026-11-11"); await reviewLeave(rejected, "rejected");
    const events = (await inbox()).notifications.filter(n => n.kind === "leave_decision");
    expect(events.map(n => n.status).sort()).toEqual(["approved", "rejected"]);
    expect(JSON.stringify(events)).not.toContain("Private");
    expect(await leaveTarget(request)).toMatchObject({ id: request, status: "approved", reason: "Private medical appointment", total_count: 1 });
    expect(await leaveTarget(request, id.pupilA, id.studentUserA, "student")).toMatchObject({ id: request });
    expect(await leaveTarget(randomUUID())).toBeNull();
    await denied(leaveTarget(request, id.unlinkedPupilA));
    await denied(leaveTarget(request, id.pupilB));
  });

  it("rolls a source decision and every recipient alert back together", async () => {
    const request = await submitLeave(), submission = await requestResult();
    await db.exec("savepoint source_rollback"); await reviewLeave(request); await reviewResult(submission);
    expect((await inbox()).notifications).toHaveLength(3);
    await db.exec("rollback to savepoint source_rollback; release savepoint source_rollback");
    expect((await inbox()).notifications).toHaveLength(1);
    expect(await leaveTarget(request)).toBeNull(); expect(await resultTarget()).toBeNull();
  });

  it("hides revoked child events immediately while preserving a sibling link and recipient rows", async () => {
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [id.unlinkedPupilA, id.parentA]);
    await reviewLeave(await submitLeave());
    const sibling = await submitLeave(id.unlinkedPupilA); await reviewLeave(sibling, "rejected");
    const original = await canonical("app_private.family_notifications");
    const revokedEvent = (await inbox()).notifications.find(n => n.student_id === id.pupilA && n.kind === "leave_decision")!;
    await db.query("delete from public.student_parents where parent_id=$1 and student_id=$2", [id.parentA, id.pupilA]);
    expect((await inbox()).notifications.map(n => n.source_id)).toEqual([sibling]);
    expect(await mark(revokedEvent)).toBeNull(); await denied(resultTarget());
    expect(await canonical("app_private.family_notifications")).toEqual(original);
    expect((await inbox(id.studentUserA, "student")).notifications).toHaveLength(1);
  });

  it("persists first read time per recipient, never marks another account, and isolates explicit dual-role state", async () => {
    await publish(); const guardian = (await inbox()).notifications.find(n => n.kind === "result_published")!;
    const student = (await inbox(id.studentUserA, "student")).notifications[0];
    expect(await mark(guardian, id.studentUserA, "student")).toBeNull();
    const marked = await mark(guardian); expect(marked).toBeTruthy(); expect(await mark(guardian)).toBe(marked);
    expect((await inbox()).notifications.find(n => n.id === guardian.id)?.read_at).toBeTruthy();
    expect((await inbox(id.studentUserA, "student")).notifications[0].read_at).toBeNull();
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'student')", [id.guardianA, id.schoolA]);
    await db.query("update public.students set profile_id=$1 where id=$2", [id.guardianA, id.unlinkedPupilA]);
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [id.unlinkedPupilA, id.parentA]);
    const request = await submitLeave(id.unlinkedPupilA); await reviewLeave(request);
    expect(await count(id.guardianA, "student")).toBe(1);
    await markAll(id.guardianA, "parent");
    expect(await count(id.guardianA, "parent")).toBe(0); expect(await count(id.guardianA, "student")).toBe(1);
    expect(student.read_at).toBeNull();
  });

  it("marks all eligible unread sources beyond 100 rows atomically and does not change student reads", async () => {
    await seedManyDecisions(); await publish();
    const page = await inbox(); expect(page.notifications).toHaveLength(30); expect(page.unread_count).toBe(108);
    expect(await count()).toBe(108); expect(await markAll()).toBe(108);
    expect(await markAll()).toBe(0); expect(await count()).toBe(0);
    expect((await inbox(id.guardianA, "parent", true)).notifications).toEqual([]);
    expect(await count(id.studentUserA, "student")).toBe(107);
    expect((await db.query<{ read: boolean }>("select read_at is not null as read from app_private.guardian_absence_alerts where recipient_user_id=$1", [id.guardianA])).rows).toEqual([{ read: true }]);
  });

  it("filters unread on the server before paging and traverses tied timestamp/kind keys without gaps", async () => {
    await seedManyDecisions(67); await publish();
    const seen: string[] = []; let cursor: Cursor | null = null;
    do { const page = await inbox(id.guardianA, "parent", false, 17, cursor); seen.push(...page.notifications.map(n => n.id)); cursor = page.next_cursor; } while (cursor);
    expect(seen).toHaveLength(69); expect(new Set(seen).size).toBe(69);
    const first = await inbox(id.guardianA, "parent", false, 50);
    for (const event of first.notifications) await mark(event);
    const unread = await inbox(id.guardianA, "parent", true, 5);
    expect(unread.notifications).toHaveLength(5); expect(unread.unread_count).toBe(19);
    expect(unread.notifications.every(n => n.read_at === null && !first.notifications.some(read => read.id === n.id))).toBe(true);
  });

  it("validates bounded limits, full cursor tuples, finite timestamps, role and event kinds", async () => {
    for (const args of [["parent", false, 0, null, null, null], ["parent", false, 51, null, null, null],
      ["parent", null, 30, null, null, null], ["parent", false, 30, "2026-11-06", null, null],
      ["parent", false, 30, "infinity", "absence", randomUUID()], ["parent", false, 30, "2026-11-06", "bogus", randomUUID()],
      ["teacher", false, 30, null, null, null], [null, false, 30, null, null, null]])
      await invalid(value(id.guardianA, "select public.get_family_notification_inbox($1,$2,$3,$4,$5,$6) as value", args));
    await invalid(value(id.guardianA, "select public.mark_family_notification_read('parent','bogus',$1) as value", [randomUUID()]));
  });

  it("requires fresh native sessions, verified active school profiles and current database role for every API", async () => {
    await publish(); const event = (await inbox()).notifications[0];
    const operations = [
      ["select public.get_family_notification_inbox('parent')", []], ["select public.get_family_notification_unread_count('parent')", []],
      ["select public.mark_family_notification_read('parent',$1,$2)", [event.kind, event.id]], ["select public.mark_all_family_notifications_read('parent')", []],
      ["select public.get_family_notification_result('parent',$1,$2)", [id.pupilA, id.assessmentA]],
      ["select public.get_family_notification_leave('parent',$1,$2)", [id.pupilA, randomUUID()]],
    ] as [string, unknown[]][];
    for (const [sql, params] of operations) {
      await denied(actor(id.guardianA, sql, params, "authenticated", null));
      await denied(actor(id.guardianA, sql, params, "authenticated", randomUUID()));
      await denied(actor(id.teacherA, sql, params));
    }
    for (const mutation of ["update auth.sessions set not_after=now()-interval '1 second' where user_id=$1",
      "delete from auth.sessions where user_id=$1", "update public.profiles set is_active=false where id=$1",
      "update public.profiles set school_id='74000000-0000-0000-0000-000000000002' where id=$1",
      "update auth.users set email_confirmed_at=null,phone_confirmed_at=null where id=$1",
      "update auth.users set banned_until=now()+interval '1 day' where id=$1",
      "delete from public.user_roles where user_id=$1"]) {
      await db.exec("savepoint disallow_actor"); await db.query(mutation, [id.guardianA]);
      for (const [sql, params] of operations) await denied(actor(id.guardianA, sql, params));
      await db.exec("rollback to savepoint disallow_actor; release savepoint disallow_actor");
    }
    expect(await count(id.studentUserB, "student")).toBe(0);
    await denied(inbox(id.studentUserA, "parent")); await denied(resultTarget(id.pupilB));
  });

  it("supports verified phone-only family members and excludes unverified recipients at event time", async () => {
    await addGuardian();
    await db.query("update auth.users set email_confirmed_at=null where id=$1", [secondGuardian]);
    const request = await submitLeave(); await reviewLeave(request);
    expect((await db.query("select id from app_private.family_notifications where recipient_user_id=$1", [secondGuardian])).rows).toEqual([]);
    // No linked-contact mutation is needed: this pupil is a student account.
    await db.query("update auth.users set email_confirmed_at=null,phone_confirmed_at=now() where id=$1", [id.studentUserA]);
    expect((await inbox(id.studentUserA, "student")).notifications).toHaveLength(1);
  });

  it("aligns result alerts and exact target reads to the latest published pupil revision, including zero marks", async () => {
    const first = await publish(); const firstEvent = (await inbox()).notifications.find(n => n.source_id === first)!; await mark(firstEvent);
    await actor(id.teacherA, "update public.teacher_assessment_marks set marks_obtained=0 where id=$1", [id.markA]);
    const second = await publish();
    expect((await inbox()).notifications.filter(n => n.kind === "result_published").map(n => n.source_id)).toEqual([second]);
    expect(await resultTarget()).toMatchObject({ id: second, revision: 2, marks_obtained: 0, percentage: 0 });
    const existing = await value<{ rows: unknown[] }>(id.guardianA, "select public.get_family_assessment_results($1) as value", [id.pupilA]);
    expect(await resultTarget()).toEqual(existing.rows[0]);
    expect(await resultTarget(id.pupilA, randomUUID())).toBeNull();
    expect(await mark(firstEvent)).toBeNull();
    expect((await db.query<{ read: boolean }>("select read_at is not null as read from app_private.family_notifications where id=$1", [firstEvent.id])).rows[0].read).toBe(true);
    await actor(id.teacherA, "update public.teacher_assessment_marks set marks_obtained=1 where id=$1", [id.markA]);
    const rejected = await requestResult(); await reviewResult(rejected, "rejected");
    expect((await inbox()).notifications.filter(n => n.kind === "result_published").map(n => n.source_id)).toEqual([second]);
  });

  it("does not expose raw event writes/reads, trigger execution or eligibility helpers to API roles", async () => {
    for (const role of ["authenticated", "anon", "service_role"] as const) {
      for (const sql of ["select * from app_private.family_notifications", "delete from app_private.family_notifications",
        "update app_private.family_notifications set read_at=now()", "select * from app_private.eligible_family_notifications('parent')",
        "select * from app_private.family_notification_recipients(null,null)", "select app_private.notify_family_leave_decision()"])
        await denied(actor(id.guardianA, sql, [], role));
    }
    for (const role of ["anon", "service_role"] as const) await denied(actor(id.guardianA, "select public.get_family_notification_inbox('parent')", [], role));
    const wrappers = await db.query<{ name: string; definer: boolean }>(`select proname as name,prosecdef as definer from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname in
      ('get_family_notification_inbox','get_family_notification_unread_count','mark_family_notification_read','mark_all_family_notifications_read','get_family_notification_result','get_family_notification_leave')`);
    expect(wrappers.rows).toHaveLength(6); expect(wrappers.rows.every(row => !row.definer)).toBe(true);
  });
});
