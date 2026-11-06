// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";
import { createSyntheticSnapshot, restoreSyntheticSnapshot } from "../../scripts/database-recovery/drill.mjs";

const uuid = (number: number) => `78000000-0000-0000-0000-${String(number).padStart(12, "0")}`;
const principal = uuid(1), finance = uuid(2), superAdmin = uuid(3), fakeSuperAdmin = uuid(4), reception = uuid(5);
const canary = "PRIVATE_REASON_TOKEN_PHONE_EMAIL_DIFF_CANARY";
const at = "2026-11-05T10:00:00Z";
const sql = "select public.list_school_audit_events($1,$2::date,$3::date,$4,$5::timestamptz,$6,$7::int) as value";
type AuditEvent = { id: string; occurred_at: string; actor_name: string | null; module: string; action: string; record_label: string };
type AuditPage = { events: AuditEvent[]; next_cursor: { occurred_at: string; key: string } | null };
let db: PGlite;

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  for (const [user, role, school] of [[principal, "principal", id.schoolA], [finance, "accountant", id.schoolA],
    [superAdmin, "super_admin", null], [fakeSuperAdmin, "super_admin", id.schoolA], [reception, "reception_staff", id.schoolA]] as const) {
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())", [user, `${role}-${user}@audit.invalid`]);
    await db.query("update public.profiles set school_id=$2,full_name=$3 where id=$1", [user, school, `Audit ${role}`]);
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,$3)", [user, school, role]);
  }
  const users = (await db.query<{ id: string }>("select id from auth.users")).rows;
  for (const user of users) await db.query("insert into auth.sessions(id,user_id) values($1,$1)", [user.id]);
}, 60_000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

async function actor<Row extends Record<string, unknown> = Record<string, unknown>>(
  user: string | null, query: string, params: unknown[] = [], role: "authenticated" | "anon" = "authenticated",
  connection: PGlite = db, session: string | null = user,
) {
  await connection.exec("savepoint audit_actor");
  try {
    await connection.exec(`set local role ${role}`);
    await connection.query("select set_config('request.jwt.claim.sub',$1,true)", [user ?? ""]);
    await connection.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, session_id: session })]);
    const result = await connection.query<Row>(query, params);
    await connection.exec("reset role");
    await connection.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','',true)");
    await connection.exec("release savepoint audit_actor");
    return result;
  } catch (error) {
    await connection.exec("rollback to savepoint audit_actor; release savepoint audit_actor");
    throw error;
  }
}
const args = (overrides: unknown[] = []) => {
  const values: unknown[] = [id.schoolA, "2026-11-01", "2026-11-30", null, null, null, 50];
  for (let index = 0; index < overrides.length; index++) if (overrides[index] !== undefined) values[index] = overrides[index];
  return values;
};
const page = async (user = id.adminA, values = args(), connection = db, session: string | null = user) =>
  (await actor<{ value: AuditPage }>(user, sql, values, "authenticated", connection, session)).rows[0].value;
const denied = (promise: Promise<unknown>) => expect(promise).rejects.toMatchObject({ code: "42501" });
const invalid = (promise: Promise<unknown>) => expect(promise).rejects.toMatchObject({ code: "22023" });

async function guardianEvent(number = 10, school = id.schoolA, time = at, by = id.adminA) {
  await db.query(`insert into app_private.guardian_access_audit(id,school_id,student_id,parent_id,actor_id,action,occurred_at)
    values($1,$2,$3,$4,$5,'linked',$6)`, [uuid(number), school, id.pupilA, id.parentA, by, time]);
}

async function sourceEvents() {
  await guardianEvent();
  await db.query(`insert into app_private.guardian_contact_audit(id,school_id,parent_id,actor_id,action,occurred_at)
    values($1,$2,$3,$4,'email_changed',$5)`, [uuid(11), id.schoolA, id.parentA, id.guardianA, at]);
  await db.query(`insert into app_private.attendance_submission_settings_audit(id,school_id,revision,reason,changed_by,changed_at)
    values($1,$2,1,$3,$4,$5)`, [uuid(12), id.schoolA, canary, id.adminA, at]);
  await db.query(`insert into app_private.attendance_corrections(id,school_id,academic_year_id,section_id,student_id,attendance_date,
    requested_by,request_reason,requested_status,requested_at,state,reviewed_by,reviewed_at,review_reason,after_record)
    values($1,$2,$3,$4,$5,'2026-11-04',$6,$7,'present',$8,'approved',$9,'2026-11-05T11:00:00Z',$7,$10)`,
    [uuid(13), id.schoolA, id.yearA, id.sectionA, id.pupilA, id.teacherA, canary, at, id.adminA, { private: canary }]);
  const enrollment = (await db.query<{ id: string }>("select id from public.enrollments where student_id=$1", [id.pupilA])).rows[0].id;
  await db.query(`insert into app_private.roster_placement_changes(school_id,request_id,student_id,source_enrollment_id,
    source_year_id,source_class_id,source_section_id,destination_enrollment_id,destination_year_id,destination_class_id,
    destination_section_id,change_kind,effective_date,reason,changed_by,changed_at)
    values($1,$2,$3,$4,$5,$6,$7,$4,$5,$6,$7,'move','2026-11-01',$8,$9,$10)`,
    [id.schoolA, uuid(14), id.pupilA, enrollment, id.yearA, id.classA, id.sectionA, canary, id.adminA, at]);
  await db.query(`insert into app_private.enrollment_withdrawals(enrollment_id,student_id,school_id,academic_year_id,class_id,
    section_id,reason,withdrawn_by,withdrawn_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [enrollment, id.pupilA, id.schoolA, id.yearA, id.classA, id.sectionA, canary, id.adminA, at]);
  await db.query(`insert into app_private.academic_year_activations(academic_year_id,school_id,previous_year_id,reason,
    promoted_count,actor_id,activated_at) values($1,$2,$1,$3,0,$4,$5)`, [id.yearA, id.schoolA, canary, id.adminA, at]);
  await db.query(`insert into app_private.student_leave_requests(id,school_id,student_id,enrollment_id,academic_year_id,class_id,
    section_id,student_name,admission_no,academic_year_name,class_name,start_date,end_date,reason,requester_id,requester_name,
    idempotency_key,created_at,status,reviewed_by,reviewer_name,review_note,reviewed_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,'REC-A-001','2026-27','Class','2026-11-10','2026-11-10',$8,$9,$8,$1,$10,
      'approved',$11,$8,$8,'2026-11-05T11:00:00Z')`,
    [uuid(15), id.schoolA, id.pupilA, enrollment, id.yearA, id.classA, id.sectionA, canary, id.guardianA, at, id.adminA]);
  await db.query(`insert into app_private.assessment_result_submissions(id,assessment_id,school_id,teacher_id,requested_by,
    requester_name,requested_at,source_token,payload,status,reviewed_by,reviewer_name,review_note,reviewed_at,revision)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,'published',$10,$6,$6,'2026-11-05T11:00:00Z',1)`,
    [uuid(16), id.assessmentA, id.schoolA, id.teacherRecordA, id.teacherA, canary, at, "a".repeat(64), { private: canary }, id.adminA]);
  await db.query(`insert into app_private.timetable_write_receipts(actor_id,request_id,operation,period_id,payload,after_record,created_at)
    values($1,$2,'save',$3,$4,$5,$6)`, [id.adminA, uuid(17), uuid(18),
    { school: id.schoolA, room: canary }, { id: uuid(18), school_id: id.schoolA, room: canary }, at]);
}

describe("curated school audit history", () => {
  it("projects every supported source and separates immutable request and decision events", async () => {
    await sourceEvents();
    const result = await page();
    expect(result.events).toHaveLength(13);
    expect(new Set(result.events.map((event) => event.module))).toEqual(new Set(["guardians", "attendance", "roster", "student-leave", "results", "timetable"]));
    for (const source of ["attendance_correction", "student_leave", "assessment_result"]) {
      const events = result.events.filter((event) => event.id.startsWith(source + ":"));
      expect(events.map((event) => event.id.split(":").at(-1))).toEqual(["reviewed", "submitted"]);
      expect(Date.parse(events[0].occurred_at)).toBeGreaterThan(Date.parse(events[1].occurred_at));
    }
    expect(result.events[0].actor_name).toBe("Synthetic admin-a");
    expect(result.next_cursor).toBeNull();
  });

  it("returns only the six safe fields and never source payloads, reasons, contact or snapshot names", async () => {
    await sourceEvents();
    const result = await page();
    for (const event of result.events) expect(Object.keys(event).sort()).toEqual(["action", "actor_name", "id", "module", "occurred_at", "record_label"]);
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(JSON.stringify(result)).not.toContain("source_token");
  });

  it.each([principal, superAdmin])("permits its principal or a true global super admin %s", async (user) => {
    await guardianEvent();
    expect((await page(user)).events).toHaveLength(1);
  });

  it.each([id.teacherA, id.studentUserA, id.guardianA, finance, reception, fakeSuperAdmin, id.adminB])("denies non-authorized role or foreign school %s", async (user) => {
    await denied(page(user));
  });

  it("denies anonymous, missing school and unrelated nonexistent school without leaking history", async () => {
    await denied(actor(null, sql, args(), "anon"));
    await denied(page(id.adminA, args([null])));
    await denied(page(superAdmin, args([uuid(999)])));
  });

  it.each(["missing", "malformed", "foreign", "expired", "deleted"])("requires the current live session: %s", async (condition) => {
    let session: string | null = id.adminA;
    if (condition === "missing") session = null;
    if (condition === "malformed") session = "not-a-session";
    if (condition === "foreign") session = id.adminB;
    if (condition === "expired") await db.query("update auth.sessions set not_after=now()-interval '1 second' where id=$1", [id.adminA]);
    if (condition === "deleted") await db.query("delete from auth.sessions where id=$1", [id.adminA]);
    await denied(page(id.adminA, args(), db, session));
  });

  it.each(["inactive", "anonymous", "unverified", "banned", "deleted", "role removed"])("denies changed account authority: %s", async (condition) => {
    if (condition === "inactive") await db.query("update public.profiles set is_active=false where id=$1", [id.adminA]);
    if (condition === "anonymous") await db.query("update auth.users set is_anonymous=true where id=$1", [id.adminA]);
    if (condition === "unverified") await db.query("update auth.users set email_confirmed_at=null,phone_confirmed_at=null where id=$1", [id.adminA]);
    if (condition === "banned") await db.query("update auth.users set banned_until=now()+interval '1 day' where id=$1", [id.adminA]);
    if (condition === "deleted") await db.query("update auth.users set deleted_at=now() where id=$1", [id.adminA]);
    if (condition === "role removed") await db.query("delete from public.user_roles where user_id=$1", [id.adminA]);
    await denied(page());
  });

  it("keeps foreign-school events, null-school legacy logs and foreign actor names out", async () => {
    await guardianEvent(20, id.schoolA, at, id.adminB);
    await guardianEvent(21, id.schoolB);
    await db.query("insert into public.audit_logs(school_id,action,old_data) values(null,$1,$2),($3,$1,$2)", [canary, { private: canary }, id.schoolA]);
    const result = await page();
    expect(result.events).toHaveLength(1);
    expect(result.events[0].actor_name).toBeNull();
    expect(JSON.stringify(result)).not.toContain("admin-b");
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it("preserves source history if an actor name is unavailable or a guardian relationship is revoked", async () => {
    await guardianEvent();
    await db.query("update public.profiles set full_name=null where id=$1", [id.adminA]);
    await db.query("delete from public.student_parents where student_id=$1", [id.pupilA]);
    expect((await page()).events[0].actor_name).toBeNull();
  });

  it("uses the full IST calendar day including both UTC boundary crossings", async () => {
    for (const [number, time] of [[30, "2026-11-04T18:29:59.999999Z"], [31, "2026-11-04T18:30:00Z"],
      [32, "2026-11-05T18:29:59.999999Z"], [33, "2026-11-05T18:30:00Z"]] as const) await guardianEvent(number, id.schoolA, time);
    expect((await page(id.adminA, args([undefined, "2026-11-05", "2026-11-05"]))).events.map((event) => event.id))
      .toEqual([`guardian_access:${uuid(32)}:linked`, `guardian_access:${uuid(31)}:linked`]);
  });

  it("pages tied timestamps without duplicate or skipped events and excludes newer arrivals from older pages", async () => {
    for (let number = 40; number < 47; number++) await guardianEvent(number);
    const complete = (await page()).events.map((event) => event.id);
    let result = await page(id.adminA, args([undefined, undefined, undefined, null, null, null, 2]));
    const seen = result.events.map((event) => event.id);
    await guardianEvent(90, id.schoolA, "2026-11-05T11:00:00Z");
    while (result.next_cursor) {
      const cursor = result.next_cursor;
      expect(cursor).toEqual({ occurred_at: result.events.at(-1)!.occurred_at, key: result.events.at(-1)!.id });
      result = await page(id.adminA, args([undefined, undefined, undefined, null, cursor.occurred_at, cursor.key, 2]));
      seen.push(...result.events.map((event) => event.id));
    }
    expect(seen).toEqual(complete);
    expect(new Set(seen).size).toBe(7);
  });

  it("filters modules server-side and returns a truthful empty page", async () => {
    await sourceEvents();
    expect((await page(id.adminA, args([undefined, undefined, undefined, "results"]))).events.map((event) => event.module)).toEqual(["results", "results"]);
    const empty = await page(id.adminA, args([undefined, "2026-10-01", "2026-10-01"]));
    expect(empty).toEqual({ events: [], next_cursor: null });
  });

  it.each([
    [undefined, null], [undefined, undefined, null], [undefined, "infinity"], [undefined, "-infinity"],
    [undefined, "2026-11-06", "2026-11-05"], [undefined, "2024-01-01", "2025-01-01"],
    [undefined, undefined, undefined, "finance"], [undefined, undefined, undefined, ""],
    [undefined, undefined, undefined, undefined, undefined, undefined, 0],
    [undefined, undefined, undefined, undefined, undefined, undefined, 101],
    [undefined, undefined, undefined, undefined, undefined, undefined, null],
    [undefined, undefined, undefined, undefined, at],
    [undefined, undefined, undefined, undefined, undefined, `guardian_access:${uuid(10)}:linked`],
    [undefined, undefined, undefined, undefined, "infinity", `guardian_access:${uuid(10)}:linked`],
    [undefined, undefined, undefined, undefined, "2026-12-01T00:00:00Z", `guardian_access:${uuid(10)}:linked`],
    [undefined, undefined, undefined, undefined, at, "malformed"],
  ])("rejects invalid bounded filter/cursor values %j", async (...input) => { await invalid(page(id.adminA, args(input))); });

  it("accepts the full 366-day leap-year window and limit100", async () => {
    expect(await page(id.adminA, args([undefined, "2024-01-01", "2024-12-31", null, null, null, 100]))).toEqual({ events: [], next_cursor: null });
  });

  it("rejects incoherent timetable receipt school evidence without revealing its payload", async () => {
    await sourceEvents();
    await db.query("update app_private.timetable_write_receipts set after_record=jsonb_set(after_record,'{school_id}',to_jsonb($1::text))", [id.schoolB]);
    expect((await page(id.adminA, args([undefined, undefined, undefined, "timetable"]))).events).toEqual([]);
  });

  it("does not grant direct raw legacy reads or private source mutation to any school account", async () => {
    await sourceEvents();
    await denied(actor(id.adminA, "select * from public.audit_logs"));
    await denied(actor(id.adminA, "select old_data from public.audit_logs"));
    for (const table of ["guardian_access_audit", "guardian_contact_audit", "attendance_corrections", "student_leave_requests",
      "assessment_result_submissions", "roster_placement_changes", "timetable_write_receipts"]) {
      await denied(actor(id.adminA, `select * from app_private.${table}`));
      await denied(actor(id.adminA, `delete from app_private.${table}`));
    }
    await denied(actor(id.adminA, "update public.audit_logs set action='forged'"));
    await denied(actor(id.adminA, "insert into public.audit_logs(action) values('forged')"));
    expect((await page()).events).toHaveLength(13);
  });

  it("keeps both RPC boundaries explicit and grants no anonymous execution", async () => {
    const rows = (await db.query<{ nspname: string; prosecdef: boolean; proconfig: string[]; anon: boolean; client: boolean }>(`select n.nspname,p.prosecdef,p.proconfig,
      has_function_privilege('anon',p.oid,'EXECUTE') as anon,has_function_privilege('authenticated',p.oid,'EXECUTE') as client
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname='list_school_audit_events' order by n.nspname`)).rows;
    expect(rows).toEqual([
      { nspname: "app_private", prosecdef: true, proconfig: ['search_path=""'], anon: false, client: true },
      { nspname: "public", prosecdef: false, proconfig: ['search_path=""'], anon: false, client: true },
    ]);
  });

  it("observes a real leave request and independent decision on fresh reads without changing history", async () => {
    const before = (await db.query("select (select jsonb_agg(to_jsonb(a)) from public.attendance a) as attendance,(select jsonb_agg(to_jsonb(f)) from public.student_fees f) as fees")).rows;
    const request = (await actor<{ id: string }>(id.guardianA, "select public.submit_student_leave($1,'2026-11-10','2026-11-10',$2,$3) as id", [id.pupilA, canary, randomUUID()])).rows[0].id;
    const today = (await db.query<{ day: string }>("select (now() at time zone 'Asia/Kolkata')::date::text as day")).rows[0].day;
    const filters = args([undefined, today, today, "student-leave"]);
    expect((await page(id.adminA, filters)).events.map((event) => event.action)).toEqual(["Student leave requested"]);
    await actor(id.adminA, "select public.review_student_leave($1,'approved',$2)", [request, canary]);
    expect((await page(id.adminA, filters)).events.map((event) => event.action)).toEqual(["Student leave approved", "Student leave requested"]);
    expect((await db.query("select (select jsonb_agg(to_jsonb(a)) from public.attendance a) as attendance,(select jsonb_agg(to_jsonb(f)) from public.student_fees f) as fees")).rows).toEqual(before);
  });

  it("restores the same safe event page and session authority in a fresh embedded engine", async () => {
    await sourceEvents();
    await db.exec("commit");
    const restored = await restoreSyntheticSnapshot(await createSyntheticSnapshot(db));
    await db.exec("begin");
    await restored.exec("begin");
    try {
      expect(await page(id.adminA, args(), restored)).toEqual(await page());
      await denied(page(id.guardianA, args(), restored));
      await denied(actor(id.adminA, "select * from public.audit_logs", [], "authenticated", restored));
    } finally { await restored.exec("rollback"); await restored.close(); }
  }, 30_000);
});
