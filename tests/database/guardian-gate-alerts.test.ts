// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase, readRecoveryManifest, readRecoverySources } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite, day: string, current: string, earlier: string, later: string, device: string, secret: string;
const peer = randomUUID(), peerParent = randomUUID();
type Preference = { user_id?: string; student_id: string; student_name: string; preference_id: string; arrival_enabled: boolean; exit_enabled: boolean; version: number };
type Item = { id: string; kind: string; student_id: string; student_name: string; created_at: string; read_at: string | null;
  event_date: string; source_id: string; status: string; title: string; assessment_id: string | null; occurred_at: string | null; delayed: boolean };
type Cursor = { created_at: string; kind: string; id: string };
type Inbox = { notifications: Item[]; unread_count: number; next_cursor: Cursor | null };
async function actor<T>(user: string | null, sql: string, args: unknown[] = [], options: { role?: "authenticated" | "anon" | "service_role"; aal?: string; session?: string } = {}) {
  await db.exec("savepoint guardian_gate_actor");
  try {
    await db.exec(`set local role ${options.role ?? "authenticated"}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [user ?? "",
      JSON.stringify({ sub: user, session_id: options.session ?? user, aal: options.aal ?? (user === id.adminA ? "aal2" : "aal1"), role: options.role ?? "authenticated" })]);
    const result = await db.query<{ value: T }>(sql, args);
    await db.exec("reset role;release savepoint guardian_gate_actor");
    await db.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true)");
    return result.rows[0].value;
  } catch (error) { await db.exec("rollback to savepoint guardian_gate_actor;release savepoint guardian_gate_actor"); throw error; }
}
const denied = (promise: Promise<unknown>, code = "42501") => expect(promise).rejects.toMatchObject({ code });
const preferences = (user = id.guardianA, options: Parameters<typeof actor>[3] = {}) => actor<{ user_id: string; children: Preference[] }>(user,
  "select public.get_my_gate_alert_preferences() as value", [], options);
const save = (pref: Preference, arrival = true, exit = true, user = id.guardianA, version = pref.version) => actor<Preference>(user,
  "select public.set_my_gate_alert_preferences($1,$2,$3,$4) as value", [pref.preference_id, version, arrival, exit]);
const pref = async (user = id.guardianA, student = id.pupilA) => (await preferences(user)).children.find((child) => child.student_id === student)!;
const inbox = (user = id.guardianA, role = "parent", unread = false, limit = 30, cursor: Cursor | null = null, legacy = false) => actor<Inbox>(user,
  `select public.get_family_notification_inbox${legacy ? "" : "_v2"}($1,$2,$3,$4,$5,$6) as value`,
  [role, unread, limit, cursor?.created_at ?? null, cursor?.kind ?? null, cursor?.id ?? null]);
const count = (user = id.guardianA, role = "parent", legacy = false) => actor<number>(user,
  `select public.get_family_notification_unread_count${legacy ? "" : "_v2"}($1)::int as value`, [role]);
const mark = (item: Item, user = id.guardianA, role = "parent") => actor<string | null>(user,
  "select public.mark_family_notification_read_v2($1,$2,$3)::text as value", [role, item.kind, item.id]);
const markAll = (user = id.guardianA, role = "parent", legacy = false) => actor<number>(user,
  `select public.mark_all_family_notifications_read${legacy ? "" : "_v2"}($1)::int as value`, [role]);
const ingest = (direction = "IN", at = current, subject = "gate-card", event = randomUUID()) => actor<Record<string, unknown>>(null,
  "select public.ingest_gate_attendance_event($1,$2,$3,$4,$5,$6::timestamptz) as value", [device, secret, event, subject, direction, at], { role: "service_role" });
const gateItems = async (user = id.guardianA) => (await inbox(user)).notifications.filter((item) => item.kind.startsWith("gate_"));
const snapshots = async (tables: string[]) => Promise.all(tables.map(async table => (await db.query(`select to_jsonb(t) as row from ${table} t order by to_jsonb(t)::text collate "C"`)).rows));

beforeAll(async () => {
  db = await createRecoveryDatabase(); await seedRecoveryData(db);
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'peer@gate-alerts.invalid',now())", [peer]);
  await db.query("update public.profiles set school_id=$2 where id=$1", [peer, id.schoolA]);
  await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'parent')", [peer, id.schoolA]);
  await db.query("insert into public.parents(id,school_id,profile_id) values($1,$2,$3)", [peerParent, id.schoolA, peer]);
  await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [id.pupilA, peerParent]);
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
  const factor = randomUUID(); await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status) values($1,$2,'totp','verified')", [factor, id.adminA]);
  await db.query("update auth.sessions set aal='aal2',factor_id=$2 where id=$1", [id.adminA, factor]);
  const dates = (await db.query<{ day: string; current: string; earlier: string; later: string }>(`select
    (clock_timestamp() at time zone 'Asia/Kolkata')::date::text as day,
    (clock_timestamp()-interval '2 minutes')::text as current,
    (clock_timestamp()-interval '10 minutes')::text as earlier,
    (clock_timestamp()-interval '1 minute')::text as later`)).rows[0];
  ({ day, current, earlier, later } = dates);
  await db.query("update public.academic_years set start_date=$1::date-30,end_date=$1::date+30", [day]);
}, 60000);
beforeEach(async () => {
  await db.exec("begin"); device = randomUUID(); secret = randomBytes(32).toString("base64url");
  await actor(id.adminA, "select public.create_gate_device($1,$2,'Guardian alert gate',$3,'23:59',array[0,1,2,3,4,5,6]) as value", [id.schoolA, device, secret]);
  await actor(id.adminA, "select public.map_gate_student($1,$2,'gate-card',$3) as value", [device, randomUUID(), id.pupilA]);
});
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

describe("per-guardian per-child opt-in with current relationship epochs", () => {
  it("defaults both choices OFF, binds owner UID and returns only current linked children", async () => {
    expect(await preferences()).toEqual({ user_id: id.guardianA, children: [{ student_id: id.pupilA, student_name: "Synthetic recovery pupil",
      preference_id: expect.any(String), arrival_enabled: false, exit_enabled: false, version: 0 }] });
    expect((await pref(peer)).preference_id).not.toBe((await pref()).preference_id);
    await denied(preferences(id.studentUserB));
  });
  it("persists independent choices, versions and strict compare-and-set without mutating another guardian", async () => {
    const original = await pref(); const updated = await save(original, true, false);
    expect(updated).toMatchObject({ user_id: id.guardianA, preference_id: original.preference_id, arrival_enabled: true, exit_enabled: false, version: 1 });
    expect(await pref()).toMatchObject({ ...original, arrival_enabled: true, version: 1 });
    expect(await save(updated, true, false)).toEqual(updated);
    await denied(save(original), "PT409");
    expect(await pref(peer)).toMatchObject({ arrival_enabled: false, exit_enabled: false, version: 0 });
  });
  it.each([id.adminA, id.teacherA, id.studentUserA, id.adminB])("rejects staff/student/foreign family configuration %s", async user => {
    await denied(preferences(user)); await denied(save(await pref(), true, true, user));
  });
  it("rejects another guardian's preference ID and malformed choices", async () => {
    await denied(save(await pref(peer)));
    await denied(actor(id.guardianA, "select public.set_my_gate_alert_preferences($1,-1,true,true) as value", [(await pref()).preference_id]), "22023");
    await denied(actor(id.guardianA, "select public.set_my_gate_alert_preferences($1,0,null,true) as value", [(await pref()).preference_id]), "22023");
  });
  it("requires current native session and optional enrolled MFA rather than a cached UID/AAL claim", async () => {
    await denied(preferences(id.guardianA, { session: randomUUID() }));
    const factor = randomUUID(); await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status) values($1,$2,'totp','verified')", [factor, id.guardianA]);
    await denied(preferences());
    await db.query("update auth.sessions set aal='aal2',factor_id=$2 where id=$1", [id.guardianA, factor]);
    expect((await preferences(id.guardianA, { aal: "aal2" })).children).toHaveLength(1);
    await db.query("delete from auth.mfa_factors where id=$1", [factor]);
    await denied(preferences(id.guardianA, { aal: "aal2" }));
  });
  it("resets to a new OFF epoch after revoke and re-link; stale old UUID cannot restore consent/history", async () => {
    const old = await save(await pref()); await ingest(); const alert = (await gateItems())[0];
    await db.query("delete from public.student_parents where parent_id=$1 and student_id=$2", [id.parentA, id.pupilA]);
    expect((await preferences()).children).toEqual([]); expect(await gateItems()).toEqual([]); expect(await mark(alert)).toBeNull();
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [id.pupilA, id.parentA]);
    const replacement = await pref(); expect(replacement).toMatchObject({ arrival_enabled: false, exit_enabled: false, version: 0 });
    expect(replacement.preference_id).not.toBe(old.preference_id);
    await denied(save(old)); await save(replacement);
    expect(await gateItems()).toEqual([]);
    expect((await db.query<{ value: number }>("select count(*)::int as value from app_private.gate_guardian_notifications")).rows[0].value).toBe(1);
  });
  it("resets gate preference owner/epoch during parent-account replacement without rewriting old alerts or child links", async () => {
    await save(await pref()); await ingest(); const alerts = await snapshots(["app_private.gate_guardian_notifications"]);
    await db.query("update public.parents set profile_id=$2 where id=$1", [id.parentA, peer]);
    expect(await gateItems()).toEqual([]);
    const owned = await db.query("select recipient_user_id,arrival_enabled,exit_enabled,version from app_private.gate_guardian_preferences where parent_id=$1", [id.parentA]);
    expect(owned.rows).toEqual([{ recipient_user_id: peer, arrival_enabled: false, exit_enabled: false, version: 0 }]);
    expect(await snapshots(["app_private.gate_guardian_notifications"])).toEqual(alerts);
    expect((await db.query("select student_id,parent_id from public.student_parents where parent_id=$1", [id.parentA])).rows).toEqual([{ student_id: id.pupilA, parent_id: id.parentA }]);
  });
  it("keeps both new tables and all privileged source/eligibility helpers private", async () => {
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      for (const table of ["gate_guardian_preferences", "gate_guardian_notifications"]) await denied(actor(null,
        `select to_jsonb(t) as value from app_private.${table} t`, [], { role }));
    }
    await denied(actor(id.guardianA, "select app_private.gate_guardian_is_eligible($1,$2,$3,$4) as value", [id.schoolA, id.pupilA, id.parentA, id.guardianA]));
  });
});

describe("gate source events create only optional bounded in-app alerts", () => {
  it("does not create alerts while OFF and never backfills later new-ID repeated scans after opt-in", async () => {
    await ingest(); await ingest("OUT", later);
    await save(await pref()); await ingest("IN", later); await ingest("OUT", later);
    expect(await gateItems()).toEqual([]);
    expect((await db.query<{ value: number }>("select count(*)::int as value from app_private.gate_guardian_notifications")).rows[0].value).toBe(0);
    expect(await count()).toBe(1);
  });
  it("creates one independent arrival/exit per enabled guardian and suppresses retries/re-entry/extra event IDs", async () => {
    await save(await pref()); await save(await pref(peer), true, false, peer);
    const key = randomUUID(); const arrival = await ingest("IN", current, "gate-card", key);
    await ingest("IN", current, "gate-card", key); await ingest("IN", later);
    await ingest("OUT", later); await ingest("IN", later); await ingest("OUT", later);
    expect((await gateItems()).map(n => n.kind).sort()).toEqual(["gate_arrival", "gate_exit"]);
    expect((await gateItems(peer)).map(n => n.kind)).toEqual(["gate_arrival"]);
    expect((await gateItems()).find(n => n.kind === "gate_arrival")).toMatchObject({ source_id: arrival.receipt_id, status: "IN", title: "Arrived at school", event_date: day });
    expect((await db.query<{ value: number }>("select count(*)::int as value from app_private.gate_guardian_notifications")).rows[0].value).toBe(3);
  });
  it("suppresses OUT without a prior accepted same-day IN, then permits the first qualifying OUT", async () => {
    await save(await pref()); await ingest("OUT", earlier); expect(await gateItems()).toEqual([]);
    await ingest("IN", current); await ingest("OUT", later);
    expect((await gateItems()).map(n => n.kind).sort()).toEqual(["gate_arrival", "gate_exit"]);
  });
  it("does not allow an earlier event-time OUT to borrow a later IN", async () => {
    await save(await pref()); await ingest("IN", current); await ingest("OUT", earlier);
    expect((await gateItems()).map(n => n.kind)).toEqual(["gate_arrival"]);
    await ingest("OUT", later); expect((await gateItems()).map(n => n.kind).sort()).toEqual(["gate_arrival", "gate_exit"]);
  });
  it("retains the actual same-day delayed timestamp and labels the delay without changing canonical daily attendance", async () => {
    await save(await pref()); const result = await ingest("IN", earlier);
    const notification = (await gateItems())[0];
    expect(notification).toMatchObject({ kind: "gate_arrival", delayed: true, source_id: result.receipt_id, assessment_id: null });
    expect(Date.parse(notification.occurred_at!)).toBe(Date.parse(earlier));
    expect(Date.parse(notification.created_at)).toBeGreaterThan(Date.parse(notification.occurred_at!));
    expect(notification.title).not.toContain("just");
    expect((await db.query("select status from public.attendance where id=$1", [result.attendance_id])).rows).toEqual([{ status: "present" }]);
  });
  it("never creates gate push jobs or changes native push preferences", async () => {
    const before = await snapshots(["app_private.family_push_jobs", "app_private.family_push_preferences"]);
    await save(await pref()); await ingest(); await ingest("OUT", later);
    expect(await snapshots(["app_private.family_push_jobs", "app_private.family_push_preferences"])).toEqual(before);
  });
  it.each(["history", "future", "manual", "unknown", "leave"])("suppresses held/non-current source %s", async reason => {
    await save(await pref());
    if (reason === "manual") await db.query("insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status,marked_by) values($1,$2,$3,$4,$5,'absent',$6)", [id.schoolA, id.yearA, id.sectionA, id.pupilA, day, id.adminA]);
    if (reason === "leave") {
      const request = await actor<string>(id.guardianA, "select public.submit_student_leave($1,$2,$2,'Medical appointment',$3) as value", [id.pupilA, day, randomUUID()]);
      await actor(id.adminA, "select public.review_student_leave($1,'approved','Approved by the school') as value", [request]);
    }
    await ingest("IN", reason === "history" ? "2000-01-01T08:00:00+05:30" : reason === "future" ? "2099-01-01T08:00:00+05:30" : current,
      reason === "unknown" ? "unknown-card" : "gate-card");
    expect(await gateItems()).toEqual([]);
  });
  it("suppresses a tolerated future IN alert even when the core accepted its daily mark", async () => {
    await save(await pref());
    const future = (await db.query<{ value: string }>("select (clock_timestamp()+interval '30 seconds')::text as value")).rows[0].value;
    expect(await ingest("IN", future)).toMatchObject({ status: "accepted" });
    expect(await gateItems()).toEqual([]);
  });
  it.each(["permission", "inactive-profile", "inactive-school", "banned", "unverified", "removed-role"])("rechecks current guardian entitlement before creation and reads: %s", async state => {
    await save(await pref());
    if (state === "permission") await db.query("delete from public.role_permissions where role='parent' and permission_id=(select id from public.permissions where code='attendance.view')");
    if (state === "inactive-profile") await db.query("update public.profiles set is_active=false where id=$1", [id.guardianA]);
    if (state === "inactive-school") await db.query("update public.schools set is_active=false where id=$1", [id.schoolA]);
    if (state === "banned") await db.query("update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=$1", [id.guardianA]);
    if (state === "unverified") await db.query("update auth.users set email_confirmed_at=null,phone_confirmed_at=null where id=$1", [id.guardianA]);
    if (state === "removed-role") await db.query("delete from public.user_roles where user_id=$1 and school_id=$2 and role='parent'", [id.guardianA, id.schoolA]);
    if (state === "inactive-school") await denied(ingest()); else await ingest();
    expect((await db.query<{ value: number }>("select count(*)::int as value from app_private.gate_guardian_notifications where recipient_user_id=$1", [id.guardianA])).rows[0].value).toBe(0);
  });
});

describe("v2 inbox/read state and old-client compatibility", () => {
  it("keeps legacy RPC kinds/count/mark-all byte-shaped and leaves unseen gate alerts unread", async () => {
    await save(await pref()); await ingest(); await ingest("OUT", later);
    const legacy = await inbox(id.guardianA, "parent", false, 30, null, true);
    expect(legacy.notifications.map(n => n.kind)).toEqual(["absence"]); expect(legacy.unread_count).toBe(1);
    expect(Object.keys(legacy.notifications[0])).not.toContain("occurred_at");
    expect(await count(id.guardianA, "parent", true)).toBe(1);
    expect(await markAll(id.guardianA, "parent", true)).toBe(1);
    expect(await count()).toBe(2); expect((await gateItems()).every(n => n.read_at === null)).toBe(true);
    await denied(actor(id.guardianA, "select public.mark_family_notification_read('parent','gate_arrival',$1) as value", [(await gateItems())[0].id]), "22023");
  });
  it("persists individual reads per guardian and refresh, hides OFF kinds and leaves absence independent", async () => {
    let own = await save(await pref()); await save(await pref(peer), true, true, peer); await ingest(); await ingest("OUT", later);
    const item = (await gateItems()).find(n => n.kind === "gate_arrival")!;
    const readAt = await mark(item); expect(await mark(item)).toBe(readAt);
    expect((await gateItems()).find(n => n.id === item.id)?.read_at).toBeTruthy();
    expect((await gateItems(peer)).every(n => n.read_at === null)).toBe(true);
    expect(await mark(item, peer)).toBeNull();
    own = await save(own, false, true);
    expect((await gateItems()).map(n => n.kind)).toEqual(["gate_exit"]); expect(await mark(item)).toBeNull();
    expect(await count()).toBe(2); // Existing absence plus the unread exit.
    await save(own, true, true);
    expect(Date.parse((await gateItems()).find(n => n.id === item.id)!.read_at!)).toBe(Date.parse(readAt!));
  });
  it("separates Student role and unrelated family scope while v2 Mark all covers current guardian only", async () => {
    await save(await pref()); await save(await pref(peer), true, true, peer); await ingest(); await ingest("OUT", later);
    expect((await inbox(id.studentUserA, "student")).notifications).toEqual([]);
    expect((await inbox(id.studentUserB, "student")).notifications).toEqual([]);
    expect(await mark((await gateItems())[0], id.studentUserA, "student")).toBeNull();
    expect(await markAll()).toBe(3); expect(await count()).toBe(0);
    expect(await count(peer)).toBe(2); expect(await markAll()).toBe(0);
  });
  it("pages the combined sources with gate cursors, unread filters and stable no-duplicate ordering", async () => {
    await save(await pref()); await ingest(); await ingest("OUT", later);
    const first = await inbox(id.guardianA, "parent", false, 1); expect(first.next_cursor).not.toBeNull();
    const second = await inbox(id.guardianA, "parent", false, 1, first.next_cursor);
    const third = await inbox(id.guardianA, "parent", false, 1, second.next_cursor);
    const items = [...first.notifications, ...second.notifications, ...third.notifications];
    expect(new Set(items.map(n => n.id)).size).toBe(3); expect(third.next_cursor).toBeNull();
    await mark(first.notifications[0]); expect((await inbox(id.guardianA, "parent", true)).notifications).toHaveLength(2);
    await denied(inbox(id.guardianA, "parent", false, 0), "22023");
    await denied(inbox(id.guardianA, "parent", false, 1, { ...first.next_cursor!, kind: "unknown" }), "22023");
  });
  it("marks every eligible gate notification beyond UI pagination without touching a peer guardian", async () => {
    await save(await pref(peer), true, false, peer); await ingest();
    for (let n = 0; n < 105; n++) {
      const pupil = randomUUID(), subject = `bulk-${n}`;
      await db.query("insert into public.students(id,school_id,admission_no,first_name) values($1,$2,$3,'Bulk gate pupil')", [pupil, id.schoolA, subject]);
      await db.query("insert into public.enrollments(student_id,academic_year_id,class_id,section_id) values($1,$2,$3,$4)", [pupil, id.yearA, id.classA, id.sectionA]);
      await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [pupil, id.parentA]);
      await save(await pref(id.guardianA, pupil), true, false);
      await actor(id.adminA, "select public.map_gate_student($1,$2,$3,$4) as value", [device, randomUUID(), subject, pupil]);
      await ingest("IN", current, subject);
    }
    expect((await inbox()).notifications).toHaveLength(30); expect(await count()).toBe(106);
    expect(await markAll()).toBe(106); expect(await count()).toBe(0);
    expect(await count(peer)).toBe(1);
    expect((await db.query<{ value: number }>("select count(*)::int as value from app_private.gate_guardian_notifications where recipient_user_id=$1 and read_at is not null", [id.guardianA])).rows[0].value).toBe(105);
  }, 30000);
  it("preserves attendance, fees, child links and existing source notifications while preference/read state changes", async () => {
    const protectedTables = ["public.attendance", "public.student_fees", "public.fee_payments", "public.student_parents", "app_private.family_notifications", "app_private.guardian_absence_alerts"];
    await save(await pref()); await ingest(); await ingest("OUT", later);
    const before = await snapshots(protectedTables);
    const alert = (await gateItems())[0]; await mark(alert); await save(await pref(), false, false);
    expect(await snapshots(protectedTables)).toEqual(before);
  });
  it("leaves every legacy family inbox helper definition and ACL untouched by this migration", async () => {
    const sources = await readRecoverySources(await readRecoveryManifest());
    const upgrade = sources.find(source => source.name === "govern_guardian_gate_alerts")!;
    const prior = await createRecoveryDatabase({ applyPending: false });
    try {
      for (const source of sources.slice(0, sources.indexOf(upgrade)).filter(source => source.kind === "pending")) await prior.exec(source.sql);
      const query = `select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) as args,pg_get_functiondef(p.oid) as definition,p.proacl::text
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','app_private')
        and p.proname in('eligible_family_notifications','get_family_notification_inbox','get_family_notification_unread_count','mark_family_notification_read','mark_all_family_notifications_read',
          'family_push_event','family_push_job_eligible','enqueue_family_push_event','eligible_guardian_absence_alerts') order by n.nspname collate "C",p.proname collate "C"`;
      const before = (await prior.query(query)).rows; await prior.exec(upgrade.sql);
      expect((await prior.query(query)).rows).toEqual(before);
    } finally { await prior.close(); }
  }, 30000);
});
