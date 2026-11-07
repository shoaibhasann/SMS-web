// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite;
const principal = randomUUID(), finance = randomUUID();
let day: string;
type Receipt = { receipt_id: string; event_id: string; status: "accepted" | "held_review"; reason: string;
  attendance_id: string | null; attendance_status: string | null; duplicate: boolean };
type Device = { device_id: string; school_id: string; name: string; timezone: string; late_after: string; working_days: number[]; revoked_at: string | null };
let device: Device, secret: string;
async function actor<T>(user: string | null, sql: string, args: unknown[] = [], options: { role?: "authenticated" | "anon" | "service_role"; aal?: string; session?: string } = {}) {
  await db.exec("savepoint gate_actor");
  try {
    await db.exec(`set local role ${options.role ?? "authenticated"}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [user ?? "", JSON.stringify({ sub: user, session_id: options.session ?? user, aal: options.aal ?? "aal2", role: options.role ?? "authenticated" })]);
    const { rows } = await db.query<{ value: T }>(sql, args);
    await db.exec("reset role;release savepoint gate_actor");
    await db.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true)");
    return rows[0].value;
  } catch (error) {
    await db.exec("rollback to savepoint gate_actor;release savepoint gate_actor");
    throw error;
  }
}
const denied = (promise: Promise<unknown>, code = "42501") => expect(promise).rejects.toMatchObject({ code });
const create = (opts: { user?: string; school?: string; key?: string; password?: string; cutoff?: string; days?: number[]; aal?: string } = {}) =>
  actor<Device>(opts.user ?? id.adminA, "select public.create_gate_device($1,$2,'School gate',$3,$4,$5::integer[]) as value",
    [opts.school ?? id.schoolA, opts.key ?? randomUUID(), opts.password ?? secret, opts.cutoff ?? "23:59", opts.days ?? [0, 1, 2, 3, 4, 5, 6]], { aal: opts.aal });
const map = (subject = "card-001", student = id.pupilA, key = randomUUID(), user = id.adminA, target = device.device_id) =>
  actor<{ mapping_id: string; subject_id: string; valid_from: string; revoked_at: string | null }>(user,
    "select public.map_gate_student($1,$2,$3,$4) as value", [target, key, subject, student]);
const ingest = (opts: { event?: string; subject?: string; direction?: string; at?: string; password?: string; deviceId?: string; role?: "authenticated" | "anon" | "service_role" } = {}) =>
  actor<Receipt>(null, "select public.ingest_gate_attendance_event($1,$2,$3,$4,$5,$6::timestamptz) as value",
    [opts.deviceId ?? device.device_id, opts.password ?? secret, opts.event ?? randomUUID(), opts.subject ?? "card-001", opts.direction ?? "IN", opts.at ?? `${day}T00:00:30+05:30`],
    { role: opts.role ?? "service_role" });
const attendance = async (pupil = id.pupilA) => (await db.query("select id,status,revision::int,school_id,academic_year_id,section_id,marked_by from public.attendance where student_id=$1 and attendance_date=$2", [pupil, day])).rows;
const setup = (user = id.adminA, school = id.schoolA, offset = 0) => actor<Record<string, unknown>>(user,
  "select public.get_gate_setup($1,$2) as value", [school, offset]);
async function enroll(user: string) {
  const factor = randomUUID();
  await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status) values($1,$2,'totp','verified')", [factor, user]);
  await db.query("update auth.sessions set aal='aal2',factor_id=$2 where id=$1", [user, factor]);
}

beforeAll(async () => {
  db = await createRecoveryDatabase(); await seedRecoveryData(db);
  for (const [user, role] of [[principal, "principal"], [finance, "accountant"]]) {
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())", [user, `${user}@gate.invalid`]);
    await db.query("update public.profiles set school_id=$2 where id=$1", [user, id.schoolA]);
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,$3)", [user, id.schoolA, role]);
  }
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
  for (const user of [id.adminA, id.adminB, principal]) await enroll(user);
  day = (await db.query<{ value: string }>("select (clock_timestamp() at time zone 'Asia/Kolkata')::date::text as value")).rows[0].value;
  await db.query("update public.academic_years set start_date=$1::date-30,end_date=$1::date+30", [day]);
  // Old synthetic marks retain their original IDs/statuses on another day.
  await db.query("update public.attendance set attendance_date=$1::date-1", [day]);
}, 60000);
beforeEach(async () => {
  await db.exec("begin"); secret = randomBytes(32).toString("base64url");
  device = await create(); await map();
});
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

describe("native staff device authority and private connector data", () => {
  it("creates one active school device with idempotent exact retries and stores only the secret hash", async () => {
    expect(await create({ key: device.device_id })).toEqual(device);
    expect(device).toMatchObject({ timezone: "Asia/Kolkata", working_days: [0, 1, 2, 3, 4, 5, 6] });
    expect((await db.query("select octet_length(secret_hash)::int as bytes from app_private.gate_devices")).rows).toEqual([{ bytes: 32 }]);
    expect(JSON.stringify(await setup())).not.toContain(secret);
    expect(JSON.stringify(await setup())).not.toContain("secret_hash");
    await denied(create({ key: device.device_id, cutoff: "09:00" }), "PT409");
    await denied(create(), "PT409");
  });
  it.each([id.teacherA, id.guardianA, id.studentUserA, finance, id.adminB])("denies configuration and reads from a lower/foreign role %s", async (user) => {
    await denied(create({ user })); await denied(setup(user)); await denied(map("foreign", id.unlinkedPupilA, randomUUID(), user));
    await denied(actor(user, "select public.revoke_gate_device($1,'Denied device revocation') as value", [device.device_id]));
  });
  it("allows the same native-AAL2 Principal capability and denies AAL1 or stale native sessions", async () => {
    expect((await setup(principal))?.school_id).toBe(id.schoolA);
    await denied(create({ aal: "aal1" }));
    await denied(actor(id.adminA, "select public.get_gate_setup($1) as value", [id.schoolA], { session: randomUUID() }));
    await db.query("update auth.sessions set aal='aal1' where id=$1", [id.adminA]);
    await denied(setup());
  });
  it("denies private table/secret/provenance access and direct ingests from native API roles", async () => {
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      for (const table of ["gate_devices", "gate_student_mappings", "gate_events", "gate_attendance_days"]) {
        await denied(actor(null, `select to_jsonb(t) as value from app_private.${table} t`, [], { role }));
      }
    }
    await denied(ingest({ role: "authenticated" })); await denied(ingest({ role: "anon" }));
    await denied(actor(id.adminA, "select app_private.gate_office_actor($1) as value", [id.schoolA]));
  });
  it("keeps every exposed wrapper invoker-only and grants ingress solely to the server role", async () => {
    const wrappers = await db.query<{ name: string; definer: boolean; anonymous: boolean }>(`select p.proname as name,p.prosecdef as definer,
      has_function_privilege('anon',p.oid,'execute') as anonymous from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in('create_gate_device','revoke_gate_device','map_gate_student',
        'revoke_gate_student_mapping','get_gate_setup','list_gate_events','ingest_gate_attendance_event')`);
    expect(wrappers.rows).toHaveLength(7);
    expect(wrappers.rows.every((row) => !row.definer && !row.anonymous)).toBe(true);
    expect((await db.query(`select has_function_privilege('authenticated','public.ingest_gate_attendance_event(uuid,text,text,text,text,timestamptz)','execute') as browser,
      has_function_privilege('service_role','public.ingest_gate_attendance_event(uuid,text,text,text,text,timestamptz)','execute') as server`)).rows).toEqual([{ browser: false, server: true }]);
  });
  it("requires a coherent current profile, active school and exact surviving verified factor", async () => {
    await db.query("update public.profiles set school_id=$2 where id=$1", [id.adminA, id.schoolB]); await denied(setup());
    await db.query("update public.profiles set school_id=$2 where id=$1", [id.adminA, id.schoolA]);
    await db.query("delete from auth.mfa_factors where user_id=$1", [id.adminA]); await denied(setup());
    await db.query("update public.schools set is_active=false where id=$1", [id.schoolA]); await denied(ingest());
  });
  it("denies a retained native AAL2 session after the exact school office role is removed", async () => {
    await db.query("delete from public.user_roles where user_id=$1 and school_id=$2 and role='school_admin'", [id.adminA, id.schoolA]);
    await denied(setup()); await denied(create());
    await denied(actor(id.adminA, "select public.revoke_gate_device($1,'Denied after role removal') as value", [device.device_id]));
    expect((await db.query("select revoked_at from app_private.gate_devices where id=$1", [device.device_id])).rows).toEqual([{ revoked_at: null }]);
  });
  it.each([
    { cutoff: "24:00" }, { cutoff: "8:30" }, { days: [] }, { days: [0, 0] }, { days: [7] }, { password: "short" },
  ])("validates device policy %j", async (opts) => { await denied(create(opts), "22023"); });
  it("validates mapping scope, exact retry and permanent subject ownership after revocation", async () => {
    const key = randomUUID(); const mapping = await map("new-card", id.unlinkedPupilA, key);
    expect(await map("new-card", id.unlinkedPupilA, key)).toEqual(mapping);
    await denied(map("other", id.pupilB), "42501");
    await denied(map("new-card", id.pupilA, key), "PT409");
    await actor(principal, "select public.revoke_gate_student_mapping($1,'Replace the lost card') as value", [mapping.mapping_id]);
    await denied(map("new-card", id.unlinkedPupilA), "PT409");
    expect((await map("replacement-card", id.unlinkedPupilA)).revoked_at).toBeNull();
  });
});

describe("immutable gate receipts and canonical daily marks", () => {
  it("marks one Present record, returns exact retries, and exposes the same family-owned attendance", async () => {
    const key = randomUUID(); const first = await ingest({ event: key });
    expect(first).toMatchObject({ event_id: key, status: "accepted", reason: "marked_present", attendance_status: "present", duplicate: false });
    expect(await ingest({ event: key })).toEqual({ ...first, duplicate: true });
    expect(await attendance()).toEqual([expect.objectContaining({ id: first.attendance_id, status: "present", revision: 0, marked_by: null,
      school_id: id.schoolA, academic_year_id: id.yearA, section_id: id.sectionA })]);
    const own = await actor(id.guardianA, "select to_jsonb(a) as value from public.attendance a where id=$1", [first.attendance_id], { aal: "aal1" });
    expect(own).toMatchObject({ id: first.attendance_id, status: "present" });
    expect(await actor(id.studentUserB, "select(select to_jsonb(a) from public.attendance a where id=$1) as value", [first.attendance_id], { aal: "aal1" })).toBeNull();
    expect((await db.query("select count(*)::int as n from app_private.gate_events")).rows).toEqual([{ n: 1 }]);
    expect((await db.query("select count(*)::int as n from app_private.guardian_absence_alerts where attendance_id=$1", [first.attendance_id])).rows).toEqual([{ n: 0 }]);
  });
  it("rejects same event ID with a different subject, direction or event time without mutation", async () => {
    const key = randomUUID(); await ingest({ event: key }); const original = await attendance();
    for (const payload of [{ subject: "different" }, { direction: "OUT" }, { at: `${day}T00:00:31+05:30` }]) {
      await denied(ingest({ event: key, ...payload }), "PT409");
    }
    expect(await attendance()).toEqual(original);
    expect((await db.query("select count(*)::int as n from app_private.gate_events")).rows).toEqual([{ n: 1 }]);
  });
  it("keeps repeated IN idempotent and OUT leaves the original daily mark/revision untouched", async () => {
    await ingest(); const original = await attendance();
    expect(await ingest({ at: `${day}T00:00:31+05:30` })).toMatchObject({ status: "accepted", reason: "already_marked" });
    expect(await ingest({ direction: "OUT" })).toMatchObject({ status: "accepted", reason: "recorded_out", attendance_id: null });
    expect(await attendance()).toEqual(original);
    expect((await db.query("select count(*)::int as n from app_private.gate_events")).rows).toEqual([{ n: 3 }]);
  });
  it("uses earliest validated same-day IN rather than offline receipt order and preserves immutable old receipts", async () => {
    await actor(id.adminA, "select public.revoke_gate_device($1,'Replace cutoff for the test') as value", [device.device_id]);
    device = await create({ cutoff: "00:00" }); await map();
    const key = randomUUID(); const late = await ingest({ event: key, at: `${day}T00:00:30+05:30` });
    expect(late).toMatchObject({ attendance_status: "late", reason: "marked_late" });
    expect(await ingest({ at: `${day}T00:00:00+05:30` })).toMatchObject({ attendance_status: "present", reason: "earlier_in_applied" });
    expect(await attendance()).toEqual([expect.objectContaining({ id: late.attendance_id, status: "present", revision: 1 })]);
    expect(await ingest({ event: key, at: `${day}T00:00:30+05:30` })).toEqual({ ...late, duplicate: true });
  });
  it.each(["absent", "leave", "holiday", "half_day", "present"])("holds a pre-existing manual %s mark and preserves it exactly", async (status) => {
    await db.query("insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status,marked_by,remarks) values($1,$2,$3,$4,$5,$6,$7,'Keep original')",
      [id.schoolA, id.yearA, id.sectionA, id.pupilA, day, status, id.adminA]);
    const before = await attendance();
    expect(await ingest()).toMatchObject({ status: "held_review", reason: "manual_or_changed_mark" });
    expect(await attendance()).toEqual(before);
  });
  it("fences any intervening manual edit including an ABA status change", async () => {
    const first = await ingest();
    await db.query("update public.attendance set status='late',marked_by=$2 where id=$1", [first.attendance_id, id.adminA]);
    await db.query("update public.attendance set status='present',marked_by=null where id=$1", [first.attendance_id]);
    const before = await attendance();
    expect(await ingest({ at: `${day}T00:00:00+05:30` })).toMatchObject({ status: "held_review", reason: "manual_or_changed_mark" });
    expect(await attendance()).toEqual(before);
  });
  it("preserves original attendance, fee, child links and unrelated school rows", async () => {
    const sql = "select jsonb_build_object('fees',(select jsonb_agg(to_jsonb(f) order by id) from public.student_fees f),'links',(select jsonb_agg(to_jsonb(l) order by student_id,parent_id) from public.student_parents l),'old_attendance',(select jsonb_agg(to_jsonb(a) order by id) from public.attendance a where attendance_date<>$1::date)) as value";
    const before = (await db.query(sql, [day])).rows;
    await ingest(); await ingest({ direction: "OUT" });
    expect((await db.query(sql, [day])).rows).toEqual(before);
  });
});

describe("invalid clocks, school policy, identities and revocation", () => {
  it.each([
    { subject: "unknown", reason: "unknown_subject" },
    { at: "2000-01-01T08:00:00+05:30", reason: "historical_date" },
    { at: "2099-01-01T08:00:00+05:30", reason: "future_clock" },
  ])("retains %j for review without canonical writes", async ({ reason, ...payload }) => {
    expect(await ingest(payload)).toMatchObject({ status: "held_review", reason, attendance_id: null });
    expect(await attendance()).toEqual([]);
    expect((await db.query("select count(*)::int as n from app_private.gate_events")).rows).toEqual([{ n: 1 }]);
  });
  it("holds wrong future clock on the same day", async () => {
    const at = (await db.query<{ value: string }>("select to_char(clock_timestamp()+interval '10 minutes','YYYY-MM-DD\"T\"HH24:MI:SSOF') as value")).rows[0].value;
    expect(await ingest({ at })).toMatchObject({ status: "held_review", reason: "future_clock" });
  });
  it("holds a configured non-working day and does not infer absence from no scans", async () => {
    await actor(id.adminA, "select public.revoke_gate_device($1,'Replace working days for test') as value", [device.device_id]);
    const dow = (await db.query<{ value: number }>("select extract(dow from $1::date)::int as value", [day])).rows[0].value;
    device = await create({ days: [(dow + 1) % 7] }); await map();
    expect(await ingest()).toMatchObject({ status: "held_review", reason: "non_working_day" });
    expect(await attendance()).toEqual([]);
  });
  it.each(["inactive-pupil", "withdrawn-enrollment", "missing-section", "ended-year"])("holds unavailable current enrollment %s", async (state) => {
    if (state === "inactive-pupil") await db.query("update public.students set status='withdrawn' where id=$1", [id.pupilA]);
    if (state === "withdrawn-enrollment") await db.query("update public.enrollments set status='withdrawn' where student_id=$1", [id.pupilA]);
    if (state === "missing-section") await db.query("update public.enrollments set section_id=null where student_id=$1", [id.pupilA]);
    if (state === "ended-year") await db.query("update public.academic_years set end_date=$2::date-1 where id=$1", [id.yearA, day]);
    expect(await ingest()).toMatchObject({ status: "held_review", reason: state === "inactive-pupil" ? "student_inactive" : "enrollment_unavailable" });
    expect(await attendance()).toEqual([]);
  });
  it("honors approved leave even though leave does not create an attendance row", async () => {
    const request = await actor<string>(id.guardianA, "select public.submit_student_leave($1,$2,$2,'Medical appointment',$3) as value", [id.pupilA, day, randomUUID()], { aal: "aal1" });
    await actor(id.adminA, "select public.review_student_leave($1,'approved','School approved leave') as value", [request]);
    expect(await ingest()).toMatchObject({ status: "held_review", reason: "approved_leave" });
    expect(await attendance()).toEqual([]);
  });
  it("holds a reviewed correction instead of creating a competing register mark", async () => {
    await db.query(`insert into app_private.attendance_corrections(id,school_id,academic_year_id,section_id,student_id,attendance_date,requested_by,request_reason,requested_status)
      values($1,$2,$3,$4,$5,$6,$7,'Review this source event','present')`, [randomUUID(), id.schoolA, id.yearA, id.sectionA, id.pupilA, day, id.teacherA]);
    expect(await ingest()).toMatchObject({ status: "held_review", reason: "reviewed_attendance" });
    expect(await attendance()).toEqual([]);
  });
  it("holds an event-date roster move rather than guessing before/after placement", async () => {
    const enrollment = (await db.query<{ id: string }>("select id from public.enrollments where student_id=$1 and academic_year_id=$2", [id.pupilA, id.yearA])).rows[0].id;
    await db.query(`insert into app_private.roster_placement_changes(school_id,request_id,student_id,source_enrollment_id,source_year_id,source_class_id,source_section_id,
      destination_enrollment_id,destination_year_id,destination_class_id,destination_section_id,change_kind,effective_date,reason,changed_by)
      values($1,$2,$3,$4,$5,$6,$7,$4,$5,$6,$7,'move',$8,'Synthetic same-day move',$9)`,
    [id.schoolA, randomUUID(), id.pupilA, enrollment, id.yearA, id.classA, id.sectionA, day, id.adminA]);
    expect(await ingest()).toMatchObject({ status: "held_review", reason: "roster_date_conflict" });
    expect(await attendance()).toEqual([]);
  });
  it("denies revoked mappings and devices; retries cannot reactivate either", async () => {
    const key = randomUUID(); await ingest({ event: key }); const before = await attendance();
    const mapping = (await db.query<{ id: string }>("select id from app_private.gate_student_mappings where device_id=$1", [device.device_id])).rows[0];
    await actor(principal, "select public.revoke_gate_student_mapping($1,'Lost student card revoked') as value", [mapping.id]);
    expect(await ingest()).toMatchObject({ status: "held_review", reason: "unknown_subject" });
    await actor(principal, "select public.revoke_gate_device($1,'Device retired and replaced') as value", [device.device_id]);
    await denied(ingest({ event: key }));
    expect((await create({ key: device.device_id })).revoked_at).not.toBeNull();
    await denied(map("new-card")); expect(await attendance()).toEqual(before);
  });
  it.each([
    { event: "bad event" }, { subject: "bad/subject" }, { direction: "UNKNOWN" }, { at: "infinity" },
  ])("rejects malformed event boundaries %j without receipts", async (payload) => {
    await denied(ingest(payload), "22023");
    expect((await db.query("select count(*)::int as n from app_private.gate_events")).rows).toEqual([{ n: 0 }]);
  });
  it("rejects absent/incorrect/foreign device credentials generically", async () => {
    await denied(ingest({ password: randomBytes(32).toString("base64url") }));
    await denied(ingest({ password: "short" })); await denied(ingest({ deviceId: randomUUID() }));
    expect((await db.query("select count(*)::int as n from app_private.gate_events")).rows).toEqual([{ n: 0 }]);
  });
  it("bounds new-event flood per device while allowing cheap exact retries", async () => {
    const key = randomUUID(); const original = await ingest({ event: key });
    await db.query("insert into app_private.gate_events(device_id,school_id,source_event_id,subject_id,direction,occurred_at,status,reason) select $1,$2,'rate-'||n,'unknown','IN',now(),'held_review','unknown_subject' from generate_series(1,599) n", [device.device_id, id.schoolA]);
    await denied(ingest(), "PT429"); expect(await ingest({ event: key })).toEqual({ ...original, duplicate: true });
  });
  it("bounds staff history pages and keeps school isolation", async () => {
    await ingest();
    const history = await actor<{ events: Receipt[]; total_count: number }>(principal, "select public.list_gate_events($1) as value", [id.schoolA]);
    expect(history.total_count).toBe(1); expect(history.events).toHaveLength(1);
    await denied(actor(id.adminB, "select public.list_gate_events($1) as value", [id.schoolA]));
    await denied(setup(id.adminA, id.schoolA, -1), "22023");
    expect((await setup(id.adminA, id.schoolA, 100))?.mappings).toEqual([]);
  });
});
